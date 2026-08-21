//! Full Desktop Runtime 的 Tauri 生命周期装配。
//!
//! 本模块只决定安装、启动恢复与自动恢复的顺序；Explorer/Win32 mutation 仍由
//! `runtime::full_desktop` 和 platform adapter 所有。

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use tauri::Manager;

use crate::{
    platform::TauriFullDesktopPlatform,
    runtime::{
        diagnostics::{DiagnosticProbeKind, DiagnosticsRuntime, StructuredDiagnosticEvent},
        full_desktop::{
            reconcile::{ExplorerReconcilePolicy, ReconcileDecision, ReconcileOutcome},
            FullDesktopError, FullDesktopMode, FullDesktopPhase, FullDesktopRuntimeState,
        },
    },
    AppState,
};

pub fn stable_error(error: FullDesktopError) -> String {
    format!("FULL_DESKTOP_{}: {error}", error.code())
}

#[derive(Clone, Copy)]
enum FullDesktopAppFailure {
    StateUnavailable,
    SettingsUnavailable,
    SettingsPersistence,
    DispatchUnavailable,
}

/// 编排层错误也保持低基数、稳定且不携带锁错误、路径或平台内部文本。
fn stable_app_error(failure: FullDesktopAppFailure) -> String {
    let (code, message) = match failure {
        FullDesktopAppFailure::StateUnavailable => {
            ("STATE_UNAVAILABLE", "完整桌面运行时状态不可用")
        }
        FullDesktopAppFailure::SettingsUnavailable => {
            ("SETTINGS_UNAVAILABLE", "完整桌面偏好状态不可用")
        }
        FullDesktopAppFailure::SettingsPersistence => {
            ("SETTINGS_PERSISTENCE", "无法持久化完整桌面偏好")
        }
        FullDesktopAppFailure::DispatchUnavailable => {
            ("DISPATCH_UNAVAILABLE", "无法调度完整桌面主线程操作")
        }
    };
    format!("FULL_DESKTOP_{code}: {message}")
}

fn record_failure(state: &AppState, operation: &str, error: impl std::fmt::Display) {
    let error_code = stable_failure_code(&error.to_string());
    state.diagnostics.record_runtime_error(
        DiagnosticProbeKind::FullDesktop,
        crate::runtime::now_ms(),
        format!("{operation} [{error_code}]"),
    );
}

const EVENT_TRANSITION: &str = "full_desktop_transition";
const EVENT_JOURNAL_WRITTEN: &str = "full_desktop_journal_written";
const EVENT_ROLLBACK: &str = "full_desktop_rollback";
const EVENT_EXPLORER_RECONCILE: &str = "full_desktop_explorer_reconcile";
const EVENT_RECOVERY_REQUIRED: &str = "full_desktop_recovery_required";

#[derive(Clone)]
struct FullDesktopObservation {
    state: FullDesktopRuntimeState,
    journal_present: bool,
    last_failure_code: Option<String>,
}

fn observe_full_desktop(state: &AppState) -> Result<FullDesktopObservation, String> {
    state
        .full_desktop
        .lock()
        .map(|runtime| FullDesktopObservation {
            state: runtime.snapshot(),
            journal_present: runtime.has_recovery_journal(),
            last_failure_code: runtime.last_error_code().map(str::to_owned),
        })
        .map_err(|_| stable_app_error(FullDesktopAppFailure::StateUnavailable))
}

fn stable_failure_code(error: &str) -> String {
    error
        .strip_prefix("FULL_DESKTOP_")
        .and_then(|rest| rest.split_once(':').map(|(code, _)| code))
        .filter(|code| {
            !code.is_empty()
                && code
                    .chars()
                    .all(|character| character == '_' || character.is_ascii_uppercase())
        })
        .unwrap_or("APP_OPERATION_FAILED")
        .to_string()
}

fn phase_name(phase: FullDesktopPhase) -> &'static str {
    match phase {
        FullDesktopPhase::Disabled => "disabled",
        FullDesktopPhase::Attaching => "attaching",
        FullDesktopPhase::Passive => "passive",
        FullDesktopPhase::Interactive => "interactive",
        FullDesktopPhase::Recovering => "recovering",
        FullDesktopPhase::Detaching => "detaching",
        FullDesktopPhase::RecoveryRequired => "recoveryRequired",
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn record_event(
    diagnostics: &DiagnosticsRuntime,
    event: &'static str,
    observation: &FullDesktopObservation,
    reason: &'static str,
    duration_ms: Option<u64>,
    error_code: Option<String>,
) {
    diagnostics.record_event(StructuredDiagnosticEvent {
        event: event.into(),
        phase: phase_name(observation.state.phase).into(),
        reason: reason.into(),
        generation: observation.state.explorer_generation,
        occurred_at_ms: crate::runtime::now_ms(),
        duration_ms,
        error_code,
    });
}

fn record_operation_events(
    state: &AppState,
    before: Option<&FullDesktopObservation>,
    reason: &'static str,
    duration_ms: u64,
    error: Option<&str>,
    journal_checkpoint_written: bool,
    rollback_attempted: bool,
) {
    let Ok(after) = observe_full_desktop(state) else {
        return;
    };
    let error_code = error
        .map(stable_failure_code)
        .or_else(|| after.last_failure_code.clone());
    let changed = before.is_none_or(|before| before.state != after.state);
    if changed || error_code.is_some() {
        record_event(
            &state.diagnostics,
            EVENT_TRANSITION,
            &after,
            reason,
            Some(duration_ms),
            error_code.clone(),
        );
    }

    let journal_became_present = before
        .map(|before| !before.journal_present && after.journal_present)
        .unwrap_or(after.journal_present);
    if journal_became_present || (journal_checkpoint_written && after.journal_present) {
        record_event(
            &state.diagnostics,
            EVENT_JOURNAL_WRITTEN,
            &after,
            reason,
            Some(duration_ms),
            error_code.clone(),
        );
    }

    let startup_recovered_stale_journal =
        reason == "startup_recovery" && after.state.auto_resume_suppressed;
    if rollback_attempted
        && (before.is_some_and(|before| {
            before.journal_present
                || before.state.effective_mode != FullDesktopMode::Disabled
                || before.state.recovery_required
        }) || startup_recovered_stale_journal
            || error_code.is_some())
    {
        record_event(
            &state.diagnostics,
            EVENT_ROLLBACK,
            &after,
            reason,
            Some(duration_ms),
            error_code.clone(),
        );
    }

    if after.state.recovery_required {
        record_event(
            &state.diagnostics,
            EVENT_RECOVERY_REQUIRED,
            &after,
            reason,
            Some(duration_ms),
            error_code,
        );
    }
}

fn needs_native_recovery_surface(state: &FullDesktopRuntimeState) -> bool {
    state.recovery_required
        || matches!(
            state.effective_mode,
            FullDesktopMode::Passive | FullDesktopMode::Interactive
        )
}

pub fn native_recovery_required(app: &tauri::AppHandle) -> bool {
    snapshot(app.state::<AppState>().inner())
        .map(|state| needs_native_recovery_surface(&state))
        .unwrap_or(true)
}

fn try_lock_desktop_wallpaper_transition(
    state: &AppState,
) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    state
        .desktop_wallpaper_transition
        .try_lock()
        .map_err(|error| match error {
            std::sync::TryLockError::WouldBlock => "DESKTOP_WALLPAPER_TRANSITION_BUSY".to_owned(),
            std::sync::TryLockError::Poisoned(_) => {
                "DESKTOP_WALLPAPER_TRANSITION_UNAVAILABLE".to_owned()
            }
        })
}

/// 持久化用户意图并执行原生切换。若原生切换失败，偏好回滚到上一次成功值，避免
/// 下一次启动自动重试一个从未成功附着的模式。
pub fn set_mode_and_persist(
    app: &tauri::AppHandle,
    state: &AppState,
    mode: FullDesktopMode,
) -> Result<FullDesktopRuntimeState, String> {
    let _transition = try_lock_desktop_wallpaper_transition(state)?;
    let before = observe_full_desktop(state).ok();
    let previous_wallpaper_mode = before
        .as_ref()
        .map(|snapshot| snapshot.state.effective_mode)
        .unwrap_or(FullDesktopMode::Disabled);
    let started = Instant::now();
    if mode == FullDesktopMode::Passive {
        super::wallpaper_engine_runtime::prepare_full_desktop_transition(state, mode)?;
    }
    let previous_mode = {
        let mut settings = match state.runtime_settings.lock() {
            Ok(settings) => settings,
            Err(_) => {
                if mode == FullDesktopMode::Passive {
                    super::wallpaper_engine_runtime::rollback_full_desktop_transition(
                        state,
                        previous_wallpaper_mode,
                    );
                }
                return Err(stable_app_error(FullDesktopAppFailure::SettingsUnavailable));
            }
        };
        let previous = settings.snapshot().full_desktop_mode;
        if settings.set_full_desktop_mode(mode).is_err() {
            if mode == FullDesktopMode::Passive {
                super::wallpaper_engine_runtime::rollback_full_desktop_transition(
                    state,
                    previous_wallpaper_mode,
                );
            }
            return Err(stable_app_error(FullDesktopAppFailure::SettingsPersistence));
        }
        previous
    };
    let mut result = state
        .full_desktop
        .lock()
        .map_err(|_| stable_app_error(FullDesktopAppFailure::StateUnavailable))?
        .request_mode(mode)
        .map_err(stable_error);
    if result.is_ok() && mode != FullDesktopMode::Passive {
        if let Err(error) =
            super::wallpaper_engine_runtime::prepare_full_desktop_transition(state, mode)
        {
            // Wallpaper layering 是 interactive/disabled 完成条件的一部分。失败时恢复
            // 上一个完整桌面事实，不能让 Web 收到 error 而 native mode 已悄悄改变。
            let rollback = state
                .full_desktop
                .lock()
                .map_err(|_| stable_app_error(FullDesktopAppFailure::StateUnavailable))
                .and_then(|mut runtime| runtime.request_mode(previous_mode).map_err(stable_error));
            if rollback.is_ok() {
                super::wallpaper_engine_runtime::rollback_full_desktop_transition(
                    state,
                    previous_mode,
                );
            }
            result = Err(error);
        }
    } else if result.is_err() && mode == FullDesktopMode::Passive {
        super::wallpaper_engine_runtime::rollback_full_desktop_transition(state, previous_mode);
    }
    if result.is_err() {
        if let Ok(mut settings) = state.runtime_settings.lock() {
            let _ = settings.set_full_desktop_mode(previous_mode);
        }
    }
    record_operation_events(
        state,
        before.as_ref(),
        "user_mode_request",
        elapsed_ms(started),
        result.as_ref().err().map(String::as_str),
        false,
        mode == FullDesktopMode::Disabled,
    );
    sync_native_recovery_surfaces(app);
    wake_explorer_watcher(state);
    result
}

pub fn recover_explicitly(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<FullDesktopRuntimeState, String> {
    let _transition = try_lock_desktop_wallpaper_transition(state)?;
    let before = observe_full_desktop(state).ok();
    let started = Instant::now();
    let result = state
        .full_desktop
        .lock()
        .map_err(|_| stable_app_error(FullDesktopAppFailure::StateUnavailable))?
        .recover()
        .map_err(stable_error)
        .and_then(|runtime_state| {
            super::wallpaper_engine_runtime::prepare_full_desktop_transition(
                state,
                FullDesktopMode::Disabled,
            )?;
            Ok(runtime_state)
        });
    record_operation_events(
        state,
        before.as_ref(),
        "explicit_recovery",
        elapsed_ms(started),
        result.as_ref().err().map(String::as_str),
        false,
        true,
    );
    sync_native_recovery_surfaces(app);
    wake_explorer_watcher(state);
    result
}

/// command 的 icon mutation 也必须穿过 app 编排层，才能在不暴露 HWND 的情况下记录
/// journal checkpoint 与稳定事件。
pub fn set_icons_visible(
    state: &AppState,
    visible: bool,
) -> Result<FullDesktopRuntimeState, String> {
    let before = observe_full_desktop(state).ok();
    let started = Instant::now();
    let result = state
        .full_desktop
        .lock()
        .map_err(|_| stable_app_error(FullDesktopAppFailure::StateUnavailable))?
        .set_icons_visible(visible)
        .map_err(stable_error);
    record_operation_events(
        state,
        before.as_ref(),
        "icons_visibility_change",
        elapsed_ms(started),
        result.as_ref().err().map(String::as_str),
        result.is_ok(),
        false,
    );
    result
}

/// software interaction lock 的原生 mutation 与 icon visibility 使用同一诊断约束。
pub fn set_interaction_locked(
    state: &AppState,
    locked: bool,
) -> Result<FullDesktopRuntimeState, String> {
    let before = observe_full_desktop(state).ok();
    let started = Instant::now();
    let result = state
        .full_desktop
        .lock()
        .map_err(|_| stable_app_error(FullDesktopAppFailure::StateUnavailable))?
        .set_interaction_locked(locked)
        .map_err(stable_error);
    record_operation_events(
        state,
        before.as_ref(),
        "interaction_lock_change",
        elapsed_ms(started),
        result.as_ref().err().map(String::as_str),
        result.is_ok(),
        false,
    );
    result
}

/// Escape 与托盘的“恢复普通窗口”是明确的禁用意图；和 crash-recovery command 不同，
/// 成功后会把偏好设为 disabled。
pub fn recover_to_normal_window(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let current = snapshot(state.inner());
    let result = match current {
        Ok(current) if current.recovery_required => recover_explicitly(app, state.inner()),
        Ok(_) => set_mode_and_persist(app, state.inner(), FullDesktopMode::Disabled),
        Err(error) => Err(error),
    };
    match result {
        Ok(runtime_state)
            if runtime_state.phase == FullDesktopPhase::Disabled
                && !runtime_state.recovery_required =>
        {
            if let Ok(mut settings) = state.runtime_settings.lock() {
                let _ = settings.set_full_desktop_mode(FullDesktopMode::Disabled);
            }
            super::desktop_runtime::show_main_window(app);
        }
        Ok(_) => record_failure(
            state.inner(),
            "恢复普通窗口失败",
            "恢复操作未确认 disabled 状态",
        ),
        Err(error) => record_failure(state.inner(), "恢复普通窗口失败", error),
    }
    sync_native_recovery_surfaces(app);
}

pub fn request_mode_from_tray(app: &tauri::AppHandle, mode: FullDesktopMode) {
    let state = app.state::<AppState>();
    if let Err(error) = set_mode_and_persist(app, state.inner(), mode) {
        record_failure(state.inner(), "托盘切换完整桌面失败", error);
    }
}

/// 托盘/单实例唤醒不能把半附着窗口当普通顶层窗口展示。passive 唤醒先切 interactive；
/// recoveryRequired 先走显式恢复；过渡态等待下一次用户操作。
pub fn prepare_main_window_for_show(app: &tauri::AppHandle) -> bool {
    let state = app.state::<AppState>();
    let current = match snapshot(state.inner()) {
        Ok(current) => current,
        Err(error) => {
            record_failure(state.inner(), "读取完整桌面唤醒状态失败", error);
            return false;
        }
    };
    match current.phase {
        FullDesktopPhase::Disabled | FullDesktopPhase::Interactive => true,
        FullDesktopPhase::Passive => {
            set_mode_and_persist(app, state.inner(), FullDesktopMode::Interactive).is_ok()
        }
        FullDesktopPhase::RecoveryRequired => {
            recover_explicitly(app, state.inner()).is_ok_and(|state| {
                state.phase == FullDesktopPhase::Disabled && !state.recovery_required
            })
        }
        FullDesktopPhase::Attaching
        | FullDesktopPhase::Recovering
        | FullDesktopPhase::Detaching => false,
    }
}

pub fn is_active(state: &AppState) -> bool {
    snapshot(state)
        .map(|state| {
            matches!(
                state.effective_mode,
                FullDesktopMode::Passive | FullDesktopMode::Interactive
            )
        })
        .unwrap_or(false)
}

pub fn transition_to_passive_for_minimize(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _transition = try_lock_desktop_wallpaper_transition(state.inner())?;
    let current = snapshot(state.inner())?;
    if current.effective_mode != FullDesktopMode::Interactive {
        return Ok(());
    }
    super::wallpaper_engine_runtime::prepare_full_desktop_transition(
        state.inner(),
        FullDesktopMode::Passive,
    )?;
    let before = observe_full_desktop(state.inner()).ok();
    let started = Instant::now();
    let result = state
        .full_desktop
        .lock()
        .map_err(|_| stable_app_error(FullDesktopAppFailure::StateUnavailable))?
        .request_mode(FullDesktopMode::Passive)
        .map_err(stable_error);
    if result.is_err() {
        super::wallpaper_engine_runtime::rollback_full_desktop_transition(
            state.inner(),
            current.effective_mode,
        );
    }
    record_operation_events(
        state.inner(),
        before.as_ref(),
        "window_minimize",
        elapsed_ms(started),
        result.as_ref().err().map(String::as_str),
        false,
        false,
    );
    sync_native_recovery_surfaces(app);
    wake_explorer_watcher(state.inner());
    result.map(|_| ())
}

/// 完整桌面 active/recoveryRequired 时保留原生托盘和 Escape 恢复路径；普通模式则
/// 恢复用户原有的托盘策略。
pub fn sync_native_recovery_surfaces(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let runtime_state = match snapshot(state.inner()) {
        Ok(state) => state,
        Err(error) => {
            record_failure(state.inner(), "同步完整桌面恢复入口失败", error);
            return;
        }
    };
    let required = needs_native_recovery_surface(&runtime_state);
    if required {
        if let Err(error) = super::tray::ensure_main_tray(app) {
            record_failure(state.inner(), "创建完整桌面恢复托盘失败", error);
        }
        if let Err(error) = crate::runtime::hotkeys::reserve_full_desktop_escape(app) {
            record_failure(state.inner(), "注册完整桌面 Escape 恢复键失败", error);
        }
    } else {
        crate::runtime::hotkeys::release_full_desktop_escape(app);
        let close_behavior = state
            .window_runtime
            .lock()
            .map(|runtime| runtime.snapshot().lifecycle.close_behavior)
            .unwrap_or_default();
        if close_behavior == super::lifecycle::CloseBehavior::Exit {
            super::tray::remove_main_tray(app);
        }
    }
}

/// 安装平台 adapter，并在动态创建主窗口之前恢复上一会话的遗留 journal。
///
/// 恢复失败会被保留为 `recoveryRequired` 供原生托盘/Web 显式处理，但不阻止普通
/// 主窗口启动，否则用户将失去可见恢复入口。
pub fn recover_before_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let before = observe_full_desktop(state.inner()).ok();
    let started = Instant::now();
    let result = state
        .full_desktop
        .lock()
        .map_err(|_| stable_app_error(FullDesktopAppFailure::StateUnavailable))
        .and_then(|mut runtime| {
            runtime.install_platform(Box::new(TauriFullDesktopPlatform::new(app.clone())));
            runtime.startup_recover().map_err(stable_error)
        });
    record_operation_events(
        state.inner(),
        before.as_ref(),
        "startup_recovery",
        elapsed_ms(started),
        result.as_ref().err().map(String::as_str),
        false,
        true,
    );
    if let Err(error) = result {
        record_failure(state.inner(), "完整桌面启动恢复失败", error);
    }
    Ok(())
}

/// 在主窗口已经创建后，异步提交正常启动的偏好恢复。检测到 crash journal 的本次
/// 启动会由 core 拒绝 auto-resume，避免恢复失败后立即再次附着。
pub fn schedule_auto_resume_after_main_window(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let preferred_mode = state
        .runtime_settings
        .lock()
        .map(|settings| settings.snapshot().full_desktop_mode)
        .unwrap_or(FullDesktopMode::Disabled);
    let auto_resume_suppressed = state
        .full_desktop
        .lock()
        .map(|runtime| runtime.snapshot().auto_resume_suppressed)
        .unwrap_or(true);
    if preferred_mode == FullDesktopMode::Disabled || auto_resume_suppressed {
        return;
    }

    let handle = app.clone();
    let dispatch = app.run_on_main_thread(move || {
        let state = handle.state::<AppState>();
        let _transition = match try_lock_desktop_wallpaper_transition(state.inner()) {
            Ok(transition) => transition,
            Err(error) => {
                record_failure(state.inner(), "完整桌面自动恢复失败", error);
                return;
            }
        };
        let before = observe_full_desktop(state.inner()).ok();
        let started = Instant::now();
        let result = super::wallpaper_engine_runtime::prepare_full_desktop_transition(
            state.inner(),
            preferred_mode,
        )
        .and_then(|()| {
            state
                .full_desktop
                .lock()
                .map_err(|_| stable_app_error(FullDesktopAppFailure::StateUnavailable))
                .and_then(|mut runtime| runtime.request_mode(preferred_mode).map_err(stable_error))
        });
        if result.is_err() {
            let _ = super::wallpaper_engine_runtime::prepare_full_desktop_transition(
                state.inner(),
                FullDesktopMode::Disabled,
            );
        }
        record_operation_events(
            state.inner(),
            before.as_ref(),
            "auto_resume",
            elapsed_ms(started),
            result.as_ref().err().map(String::as_str),
            false,
            false,
        );
        if let Err(error) = result {
            record_failure(state.inner(), "完整桌面自动恢复失败", error);
        }
        sync_native_recovery_surfaces(&handle);
        wake_explorer_watcher(state.inner());
    });
    if dispatch.is_err() {
        record_failure(
            state.inner(),
            "调度完整桌面自动恢复失败",
            stable_app_error(FullDesktopAppFailure::DispatchUnavailable),
        );
        wake_explorer_watcher(state.inner());
    }
}

/// 主窗口创建和 auto-resume 排队后启动 watcher。worker 本身只观察 phase，并把真正的
/// reconcile 投递回 Tauri 主线程，避免后台线程触碰 WebView/Win32 窗口状态。
pub fn start_explorer_watcher_after_main_window(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let Ok(mut watcher) = state.full_desktop_watcher.lock() else {
        record_failure(
            state.inner(),
            "启动 Explorer watcher 失败",
            "watcher 锁不可用",
        );
        return;
    };
    if watcher.worker.is_some() || watcher.stop.is_some() {
        return;
    }
    let stop = Arc::new(AtomicBool::new(false));
    let policy = Arc::new(Mutex::new(ExplorerReconcilePolicy::new(crate::runtime::now_ms())));

    let handle = app.clone();
    let worker_stop = Arc::clone(&stop);
    let worker_policy = Arc::clone(&policy);
    let worker = std::thread::Builder::new()
        .name("mineradio-explorer-reconcile".to_string())
        .spawn(move || explorer_watcher_loop(handle, worker_stop, worker_policy));
    match worker {
        Ok(worker) => {
            watcher.wake = Some(worker.thread().clone());
            watcher.stop = Some(stop);
            watcher.policy = Some(policy);
            watcher.worker = Some(worker);
        }
        Err(error) => {
            record_failure(state.inner(), "启动 Explorer watcher 失败", error);
        }
    }
}

/// mode/recovery 变化与 shutdown 都通过 `unpark` 打断 policy 的完整 deadline；这比
/// 短周期读锁轮询更省电，也不会让 disabled 状态触碰 full-desktop runtime。
fn wake_explorer_watcher(state: &AppState) {
    let wake = state
        .full_desktop_watcher
        .lock()
        .ok()
        .and_then(|watcher| watcher.wake.clone());
    if let Some(wake) = wake {
        wake.unpark();
    }
}

// 由 #54 dormant native adapter 消费；在 production cutover 前不从普通退出路径调用。
#[allow(dead_code)]
pub(crate) struct ExplorerWatcherInstallReceipt {
    was_running: bool,
    worker: Option<std::thread::JoinHandle<()>>,
}

#[allow(dead_code)]
impl ExplorerWatcherInstallReceipt {
    pub(crate) fn join_bounded(&mut self, timeout: Duration) -> Result<bool, String> {
        super::state::join_worker_bounded(
            &mut self.worker,
            timeout,
            "FULL_DESKTOP_WATCHER_JOIN_PANICKED",
        )
    }

    pub(crate) fn restore(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if self.worker.is_some() {
            return Err("FULL_DESKTOP_WATCHER_JOIN_INCOMPLETE".to_owned());
        }
        if self.was_running {
            start_explorer_watcher_after_main_window(app);
            let running = app
                .state::<AppState>()
                .full_desktop_watcher
                .lock()
                .map(|watcher| watcher.worker.is_some())
                .unwrap_or(false);
            if !running {
                return Err("FULL_DESKTOP_WATCHER_RESTART_FAILED".to_owned());
            }
        }
        Ok(())
    }
}

/// update-install 专用：先从共享状态撤销 watcher ownership，再由 caller 在无锁状态下
/// 有界 join。Receipt 保留原先是否运行，rollback 不靠当前 UI 状态猜测。
#[allow(dead_code)]
pub(crate) fn take_explorer_watcher_for_update(
    state: &AppState,
) -> Result<ExplorerWatcherInstallReceipt, String> {
    let mut watcher = state
        .full_desktop_watcher
        .lock()
        .map_err(|_| "FULL_DESKTOP_WATCHER_STATE_UNAVAILABLE".to_owned())?;
    let was_running = watcher.worker.is_some() || watcher.stop.is_some();
    if let Some(policy) = watcher.policy.as_ref() {
        policy
            .lock()
            .map_err(|_| "FULL_DESKTOP_WATCHER_POLICY_UNAVAILABLE".to_owned())?
            .shutdown();
    }
    if let Some(stop) = watcher.stop.take() {
        stop.store(true, Ordering::Release);
    }
    watcher.policy = None;
    if let Some(wake) = watcher.wake.take() {
        wake.unpark();
    }
    let worker = watcher.worker.take();
    Ok(ExplorerWatcherInstallReceipt {
        was_running,
        worker,
    })
}

/// 退出必须在 rollback 前取消 watcher；queued callback 会检查 stop 与 policy generation，
/// 因而不会在恢复普通桌面之后重新附着 Explorer。
pub fn stop_explorer_watcher_for_shutdown(state: &AppState) {
    let worker = state
        .full_desktop_watcher
        .lock()
        .ok()
        .and_then(|mut watcher| {
            if let Some(policy) = watcher.policy.as_ref() {
                if let Ok(mut policy) = policy.lock() {
                    policy.shutdown();
                }
            }
            if let Some(stop) = watcher.stop.take() {
                stop.store(true, Ordering::Release);
            }
            watcher.policy = None;
            if let Some(wake) = watcher.wake.take() {
                wake.unpark();
            }
            watcher.worker.take()
        });
    if let Some(worker) = worker {
        let _ = std::thread::Builder::new()
            .name("mineradio-explorer-reconcile-reaper".to_string())
            .spawn(move || {
                let _ = worker.join();
            });
    }
}

fn explorer_watcher_loop(
    app: tauri::AppHandle,
    stop: Arc<AtomicBool>,
    policy: Arc<Mutex<ExplorerReconcilePolicy>>,
) {
    while !stop.load(Ordering::Acquire) {
        let state = app.state::<AppState>();
        let active = state
            .full_desktop
            .lock()
            .map(|runtime| {
                matches!(
                    runtime.snapshot().phase,
                    FullDesktopPhase::Passive | FullDesktopPhase::Interactive
                )
            })
            .unwrap_or(false);
        let now_ms = crate::runtime::now_ms();
        let decision = policy
            .lock()
            .map(|mut policy| policy.poll(now_ms, active))
            .unwrap_or(ReconcileDecision::Stopped);
        match decision {
            ReconcileDecision::Queue { generation } => {
                queue_main_thread_reconcile(&app, &stop, &policy, generation);
                park_cancellable(&stop, 100);
            }
            ReconcileDecision::WaitUntil(due_ms) => {
                // inactive 时完整等待 policy 的 30 秒 deadline；mode/recovery 的显式 unpark
                // 会立即结束 park，让 active transition 不必等待超时。
                park_cancellable(
                    &stop,
                    watcher_wait_duration(ReconcileDecision::WaitUntil(due_ms), now_ms)
                        .unwrap_or(0),
                );
            }
            ReconcileDecision::InFlight => park_cancellable(&stop, 100),
            ReconcileDecision::Stopped => break,
        }
    }
}

fn record_reconcile_events(
    state: &AppState,
    before: Option<&FullDesktopObservation>,
    duration_ms: u64,
    error: Option<&str>,
) {
    let Ok(after) = observe_full_desktop(state) else {
        return;
    };
    let generation_changed = before
        .is_some_and(|before| before.state.explorer_generation != after.state.explorer_generation);
    // 正常 identity validation 每秒都可能成功；只有真正换代或失败才进入事件环，避免
    // 高频 success 挤掉有用的 transition/recovery 证据。
    if !should_record_reconcile_event(generation_changed, error.is_some()) {
        return;
    }
    let error_code = error
        .map(stable_failure_code)
        .or_else(|| after.last_failure_code.clone());
    record_event(
        &state.diagnostics,
        EVENT_EXPLORER_RECONCILE,
        &after,
        "explorer_identity_check",
        Some(duration_ms),
        error_code.clone(),
    );
    if generation_changed && after.journal_present {
        record_event(
            &state.diagnostics,
            EVENT_JOURNAL_WRITTEN,
            &after,
            "explorer_identity_check",
            Some(duration_ms),
            None,
        );
    }
    if after.state.recovery_required {
        record_event(
            &state.diagnostics,
            EVENT_RECOVERY_REQUIRED,
            &after,
            "explorer_identity_check",
            Some(duration_ms),
            error_code,
        );
    }
}

fn should_record_reconcile_event(generation_changed: bool, failed: bool) -> bool {
    generation_changed || failed
}

fn complete_reconcile_attempt(
    state: &AppState,
    policy: &Arc<Mutex<ExplorerReconcilePolicy>>,
    generation: u64,
    completed_at_ms: u64,
    outcome: ReconcileOutcome,
) -> bool {
    let accepted = policy
        .lock()
        .map(|mut policy| policy.complete(generation, completed_at_ms, outcome))
        .unwrap_or(false);
    if !accepted {
        return false;
    }
    if let Ok(mut watcher) = state.full_desktop_watcher.lock() {
        let is_current_policy = watcher
            .policy
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, policy));
        if is_current_policy {
            watcher.last_reconcile_at_ms = Some(completed_at_ms);
            watcher.last_reconcile_outcome = Some(outcome.into());
        }
    }
    true
}

fn queue_main_thread_reconcile(
    app: &tauri::AppHandle,
    stop: &Arc<AtomicBool>,
    policy: &Arc<Mutex<ExplorerReconcilePolicy>>,
    generation: u64,
) {
    let callback_app = app.clone();
    let callback_stop = Arc::clone(stop);
    let callback_policy = Arc::clone(policy);
    if app
        .run_on_main_thread(move || {
            if callback_stop.load(Ordering::Acquire) {
                return;
            }
            let state = callback_app.state::<AppState>();
            let before = observe_full_desktop(state.inner()).ok();
            let started = Instant::now();
            let result = state
                .full_desktop
                .lock()
                .map_err(|_| stable_app_error(FullDesktopAppFailure::StateUnavailable))
                .and_then(|mut runtime| {
                    if !matches!(
                        runtime.snapshot().phase,
                        FullDesktopPhase::Passive | FullDesktopPhase::Interactive
                    ) {
                        return Ok(());
                    }
                    runtime.reconcile().map(|_| ()).map_err(stable_error)
                });
            let outcome = if result.is_ok() {
                ReconcileOutcome::Success
            } else {
                ReconcileOutcome::Failure
            };
            if let Err(error) = &result {
                record_failure(state.inner(), "Explorer reconcile 失败", error);
            }
            record_reconcile_events(
                state.inner(),
                before.as_ref(),
                elapsed_ms(started),
                result.as_ref().err().map(String::as_str),
            );
            sync_native_recovery_surfaces(&callback_app);
            complete_reconcile_attempt(
                state.inner(),
                &callback_policy,
                generation,
                crate::runtime::now_ms(),
                outcome,
            );
        })
        .is_err()
    {
        let error = stable_app_error(FullDesktopAppFailure::DispatchUnavailable);
        let state = app.state::<AppState>();
        complete_reconcile_attempt(
            state.inner(),
            policy,
            generation,
            crate::runtime::now_ms(),
            ReconcileOutcome::Failure,
        );
        record_reconcile_events(
            state.inner(),
            observe_full_desktop(state.inner()).ok().as_ref(),
            0,
            Some(&error),
        );
        record_failure(state.inner(), "调度 Explorer reconcile 失败", error);
    }
}

fn watcher_wait_duration(decision: ReconcileDecision, now_ms: u64) -> Option<u64> {
    match decision {
        ReconcileDecision::WaitUntil(due_ms) => Some(due_ms.saturating_sub(now_ms)),
        ReconcileDecision::Queue { .. } | ReconcileDecision::InFlight => Some(100),
        ReconcileDecision::Stopped => None,
    }
}

fn park_cancellable(stop: &AtomicBool, duration_ms: u64) {
    if !stop.load(Ordering::Acquire) {
        std::thread::park_timeout(Duration::from_millis(duration_ms));
    }
}

pub fn snapshot(state: &AppState) -> Result<FullDesktopRuntimeState, String> {
    state
        .full_desktop
        .lock()
        .map(|runtime| runtime.snapshot())
        .map_err(|_| stable_app_error(FullDesktopAppFailure::StateUnavailable))
}

/// 所有正常退出路径共享此恢复入口。失败时 journal 必须保留，caller 决定是否取消退出。
pub fn recover_for_shutdown(state: &AppState) -> Result<(), String> {
    let _transition = try_lock_desktop_wallpaper_transition(state)?;
    let before = observe_full_desktop(state).ok();
    let started = Instant::now();
    let result = state
        .full_desktop
        .lock()
        .map_err(|_| stable_app_error(FullDesktopAppFailure::StateUnavailable))?
        .disable_for_shutdown()
        .map_err(stable_error);
    record_operation_events(
        state,
        before.as_ref(),
        "application_shutdown",
        elapsed_ms(started),
        result.as_ref().err().map(String::as_str),
        false,
        true,
    );
    result
}

/// 尝试在退出 claim 之前恢复普通桌面。失败时保留 journal，并让可取消的退出路径停下。
pub fn recover_before_exit(app: &tauri::AppHandle) -> bool {
    let state = app.state::<AppState>();
    stop_explorer_watcher_for_shutdown(state.inner());
    match recover_for_shutdown(state.inner()) {
        Ok(()) => true,
        Err(error) => {
            record_failure(state.inner(), "完整桌面退出恢复失败", error);
            // 可取消退出失败后恢复 watcher/原生入口，让用户修复 Explorer 后重试。
            start_explorer_watcher_after_main_window(app);
            sync_native_recovery_surfaces(app);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inactive_policy_deadline_is_not_truncated_to_half_second_polling() {
        assert_eq!(
            watcher_wait_duration(ReconcileDecision::WaitUntil(30_000), 0),
            Some(30_000)
        );
    }

    #[test]
    fn stopped_watcher_has_no_further_park_deadline() {
        assert_eq!(watcher_wait_duration(ReconcileDecision::Stopped, 0), None);
    }

    #[test]
    fn routine_successful_identity_checks_do_not_fill_the_structured_event_ring() {
        assert!(!should_record_reconcile_event(false, false));
        assert!(should_record_reconcile_event(true, false));
        assert!(should_record_reconcile_event(false, true));
    }

    #[test]
    fn structured_failures_keep_only_stable_codes() {
        assert_eq!(
            stable_failure_code("FULL_DESKTOP_INVALID_ATTACHMENT: 任意详细信息"),
            "INVALID_ATTACHMENT"
        );
        assert_eq!(
            stable_failure_code("C:\\users\\someone\\recovery.json"),
            "APP_OPERATION_FAILED"
        );
        let state_error = stable_app_error(FullDesktopAppFailure::StateUnavailable);
        assert_eq!(stable_failure_code(&state_error), "STATE_UNAVAILABLE");
        assert!(!state_error.contains("PoisonError"));

        let settings_error = stable_app_error(FullDesktopAppFailure::SettingsPersistence);
        assert_eq!(stable_failure_code(&settings_error), "SETTINGS_PERSISTENCE");
        assert!(!settings_error.contains("recovery.json"));
    }
}
