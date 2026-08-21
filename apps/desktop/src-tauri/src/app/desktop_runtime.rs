use std::{sync::atomic::Ordering, time::Duration};

use tauri::Manager;

use crate::{
    runtime::{self, resources::WindowActivity, window_adapter},
    AppState,
};

use super::{
    lifecycle::{CloseDecision, LifecyclePhase, UpdateExitStatus},
    window_labels,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UpdateExitRunDecision {
    Normal,
    PreventExit,
    AllowExitWithoutCleanup,
}

fn update_exit_run_decision(status: Option<UpdateExitStatus>) -> UpdateExitRunDecision {
    match status {
        None => UpdateExitRunDecision::Normal,
        Some(UpdateExitStatus::Sealed) => UpdateExitRunDecision::AllowExitWithoutCleanup,
        Some(UpdateExitStatus::Prepared | UpdateExitStatus::RecoveryRequired) => {
            UpdateExitRunDecision::PreventExit
        }
    }
}

fn app_update_exit_run_decision(app: &tauri::AppHandle) -> UpdateExitRunDecision {
    let status = app
        .state::<AppState>()
        .window_runtime
        .lock()
        .ok()
        .and_then(|runtime| runtime.update_exit_status());
    update_exit_run_decision(status)
}

fn single_instance_window_reactivation_steps() -> [&'static str; 3] {
    ["show", "unminimize", "set_focus"]
}

pub fn reactivate_main_window_for_single_instance(app: &tauri::AppHandle) {
    show_main_window(app);
}

pub fn show_main_window(app: &tauri::AppHandle) {
    let lifecycle_allows_show = app
        .state::<AppState>()
        .window_runtime
        .lock()
        .map(|runtime| {
            !matches!(
                runtime.snapshot().lifecycle.phase,
                LifecyclePhase::Exiting | LifecyclePhase::Cleaned
            )
        })
        .unwrap_or(false);
    if !lifecycle_allows_show {
        return;
    }
    if !super::full_desktop_runtime::prepare_main_window_for_show(app) {
        return;
    }
    // prepare 后再次取得生命周期许可，吸收与退出并发的托盘/单实例回调。
    let show_allowed = app
        .state::<AppState>()
        .window_runtime
        .lock()
        .map(|mut runtime| {
            if matches!(
                runtime.snapshot().lifecycle.phase,
                LifecyclePhase::Exiting | LifecyclePhase::Cleaned
            ) {
                return false;
            }
            let _ = runtime.request_show();
            true
        })
        .unwrap_or(false);
    if !show_allowed {
        return;
    }
    let Some(window) = app.get_webview_window(window_labels::MAIN) else {
        return;
    };
    for step in single_instance_window_reactivation_steps() {
        match step {
            "show" => {
                let _ = window.show();
            }
            "unminimize" => {
                let _ = window.unminimize();
            }
            "set_focus" => {
                let _ = window.set_focus();
            }
            _ => {}
        }
    }
    set_window_activity(app, WindowActivity::Foreground);
    window_adapter::emit_window_state(&window);
}

pub fn request_application_exit(app: &tauri::AppHandle) {
    if !super::full_desktop_runtime::recover_before_exit(app) {
        return;
    }
    let should_exit = request_runtime_exit(app);
    if !should_exit {
        return;
    }
    finish_cancelable_cleanup(
        cleanup_runtime_once(app).is_ok(),
        || app.exit(0),
        || {
            let _ = cancel_runtime_exit(app);
        },
    );
}

fn request_runtime_exit(app: &tauri::AppHandle) -> bool {
    app.state::<AppState>()
        .window_runtime
        .lock()
        .map(|mut runtime| runtime.request_exit())
        .unwrap_or(true)
}

fn cancel_runtime_exit(app: &tauri::AppHandle) -> bool {
    app.state::<AppState>()
        .window_runtime
        .lock()
        .map(|mut runtime| runtime.cancel_exit())
        .unwrap_or(false)
}

/// 系统退出、程序化退出和窗口关闭最终都进入同一个 cleanup claim。
pub fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            match app_update_exit_run_decision(app) {
                UpdateExitRunDecision::AllowExitWithoutCleanup => return,
                UpdateExitRunDecision::PreventExit => {
                    api.prevent_exit();
                    return;
                }
                UpdateExitRunDecision::Normal => {}
            }
            if !super::full_desktop_runtime::recover_before_exit(app) {
                api.prevent_exit();
                return;
            }
            let _ = request_runtime_exit(app);
            finish_cancelable_cleanup(
                cleanup_runtime_once(app).is_ok(),
                || {},
                || {
                    let _ = cancel_runtime_exit(app);
                    api.prevent_exit();
                },
            );
        }
        tauri::RunEvent::Exit => {
            if let Some(updater) =
                app.try_state::<super::updater_runtime::ApplicationUpdateRuntime>()
            {
                updater.shutdown();
            }
            if app_update_exit_run_decision(app) != UpdateExitRunDecision::Normal {
                // sealed install 已由 reversible native lease 完成所有退出前工作；这里
                // 禁止重新进入普通 cleanup。不可取消的异常退出则保留 recovery 证据。
                return;
            }
            // Exit 已不可取消；仍执行同一 rollback，失败时 journal 留给下次启动恢复。
            let _ = super::full_desktop_runtime::recover_before_exit(app);
            let _ = request_runtime_exit(app);
            let _ = cleanup_runtime_once(app);
        }
        _ => {}
    }
}

fn claim_cleanup_after_exact_scene<F>(
    exact_scene_dispose: Result<(), String>,
    claim_cleanup: F,
) -> Result<bool, String>
where
    F: FnOnce() -> Result<bool, String>,
{
    exact_scene_dispose?;
    claim_cleanup()
}

fn finish_cancelable_cleanup<OnExit, OnPrevent>(
    cleanup_succeeded: bool,
    on_exit: OnExit,
    on_prevent: OnPrevent,
) where
    OnExit: FnOnce(),
    OnPrevent: FnOnce(),
{
    if cleanup_succeeded {
        on_exit();
    } else {
        on_prevent();
    }
}

/// 只在真正退出时取得资源清理所有权；托盘隐藏不会进入这里。
pub fn cleanup_runtime_once(app: &tauri::AppHandle) -> Result<bool, String> {
    let state = app.state::<AppState>();
    // 必须早于歌词与托盘 cleanup；失败时不取得 exactly-once claim，允许用户
    // 修复 Explorer 后再次尝试退出。
    if !super::full_desktop_runtime::recover_before_exit(app) {
        return Err("FULL_DESKTOP_EXIT_RECOVERY_UNCONFIRMED".to_owned());
    }
    let exact_scene_dispose = super::wallpaper_engine_runtime::dispose_before_exit(state.inner());
    if let Err(error) = &exact_scene_dispose {
        state.diagnostics.record_runtime_error(
            runtime::diagnostics::DiagnosticProbeKind::WallpaperEngine,
            crate::runtime::now_ms(),
            error.clone(),
        );
    }
    let cleanup_claimed = claim_cleanup_after_exact_scene(exact_scene_dispose, || {
        let mut runtime = state
            .window_runtime
            .lock()
            .map_err(|_| "DESKTOP_RUNTIME_CLEANUP_LOCK_UNAVAILABLE".to_owned())?;
        let lifecycle = runtime.snapshot().lifecycle;
        if lifecycle.phase == LifecyclePhase::Cleaned && lifecycle.cleanup_claimed {
            return Ok(false);
        }
        if !runtime.claim_cleanup() {
            return Err("DESKTOP_RUNTIME_CLEANUP_CLAIM_UNAVAILABLE".to_owned());
        }
        runtime.dispose_state_emit();
        Ok(true)
    })?;
    if !cleanup_claimed {
        return Ok(false);
    }

    state
        .application_runtime_running
        .store(false, Ordering::Release);
    runtime::hotkeys::clear_global_hotkeys(app);

    flush_desktop_lyrics_bounds_for_shutdown(state.inner());
    let lyrics_child = state.desktop_lyrics.lock().ok().and_then(|mut lyrics| {
        lyrics.overlay_ready = false;
        let (_, child) =
            runtime::desktop_lyrics::desktop_lyrics_stop_middle_click_poller_state(&mut lyrics);
        child
    });
    runtime::desktop_lyrics::desktop_lyrics_terminate_poller_child(lyrics_child);
    close_desktop_lyrics_window_for_shutdown(app);

    super::tray::remove_main_tray(app);
    Ok(true)
}

/// 在退出和歌词窗口被原生关闭时复用同一条无阻塞停机路径。
fn stop_desktop_lyrics_input_worker(state: &AppState) {
    let lyrics_child = state.desktop_lyrics.lock().ok().and_then(|mut lyrics| {
        lyrics.overlay_ready = false;
        let (_, child) =
            runtime::desktop_lyrics::desktop_lyrics_stop_middle_click_poller_state(&mut lyrics);
        child
    });
    runtime::desktop_lyrics::desktop_lyrics_terminate_poller_child(lyrics_child);
}

fn flush_desktop_lyrics_bounds_for_shutdown(state: &AppState) {
    if let Err(error) = runtime::desktop_lyrics::flush_desktop_lyrics_user_bounds(state) {
        state.diagnostics.record_runtime_error(
            runtime::diagnostics::DiagnosticProbeKind::DesktopLyrics,
            crate::runtime::now_ms(),
            format!("desktop lyrics bounds persist failed: {error}"),
        );
    }
}

/// cleanup 已先停止输入 worker；这里仅关闭原生窗口，CloseRequested/Destroyed 的
/// 幂等停机分支会自然吸收重复通知。
fn close_desktop_lyrics_window_for_shutdown(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(window_labels::DESKTOP_LYRICS) {
        let _ = window.close();
    }
}

fn set_window_activity(app: &tauri::AppHandle, activity: WindowActivity) {
    if let Ok(mut current) = app.state::<AppState>().window_activity.lock() {
        *current = activity;
    }
}

fn schedule_background_working_set_trim(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(
            runtime::resources::MIN_BACKGROUND_DELAY_MS,
        ));
        let state = app.state::<AppState>();
        if !state.application_runtime_running.load(Ordering::Acquire) {
            return;
        }
        let activity = state
            .window_activity
            .lock()
            .map(|activity| *activity)
            .unwrap_or(WindowActivity::Visible);
        let adapter = runtime::resources::WindowsProcessMemoryAdapter;
        let outcome = state
            .resources
            .trim_working_set(activity, crate::runtime::now_ms(), &adapter);
        if matches!(outcome, runtime::resources::TrimOutcome::Failed { .. }) {
            state.diagnostics.record_runtime_error(
                runtime::diagnostics::DiagnosticProbeKind::ProcessMemory,
                crate::runtime::now_ms(),
                format!("background working-set trim failed: {outcome:?}"),
            );
        }
    });
}

/// 将 Tauri 原生窗口事件收敛到 Desktop Runtime Module。
pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() == window_labels::DESKTOP_LYRICS {
        if matches!(
            event,
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
        ) {
            let state = window.state::<AppState>();
            flush_desktop_lyrics_bounds_for_shutdown(state.inner());
            stop_desktop_lyrics_input_worker(state.inner());
            return;
        }
        let programmatic = matches!(event, tauri::WindowEvent::ScaleFactorChanged { .. });
        if matches!(
            event,
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
        ) || programmatic
        {
            let _ = runtime::desktop_lyrics::handle_window_geometry_event(window, programmatic);
        }
        return;
    }
    if window.label() != window_labels::MAIN {
        return;
    }
    if matches!(event, tauri::WindowEvent::Destroyed) {
        super::wallpaper_engine_runtime::schedule_stop_for_webview_failure(
            window.app_handle().clone(),
        );
        return;
    }

    match event {
        tauri::WindowEvent::Focused(true) => {
            set_window_activity(window.app_handle(), WindowActivity::Foreground);
        }
        tauri::WindowEvent::Focused(false) => {
            let native_minimized = window.is_minimized().unwrap_or(false);
            let full_desktop_active =
                super::full_desktop_runtime::is_active(window.state::<AppState>().inner());
            if native_minimized && full_desktop_active {
                if let Err(error) = super::full_desktop_runtime::transition_to_passive_for_minimize(
                    window.app_handle(),
                ) {
                    let state = window.state::<AppState>();
                    state.diagnostics.record_runtime_error(
                        runtime::diagnostics::DiagnosticProbeKind::FullDesktop,
                        crate::runtime::now_ms(),
                        format!("完整桌面最小化切换 passive 失败：{error}"),
                    );
                }
                // 完整桌面 surface 是 Explorer child；系统级 minimize 只转换为 passive，
                // 不让 child 保持隐藏。
                let _ = window.unminimize();
            }
            let activity = if native_minimized && !full_desktop_active {
                WindowActivity::Minimized {
                    since_ms: crate::runtime::now_ms(),
                }
            } else {
                WindowActivity::Visible
            };
            set_window_activity(window.app_handle(), activity);
            if matches!(activity, WindowActivity::Minimized { .. }) {
                if let Err(error) = super::wallpaper_engine_runtime::stop_for_window_deactivation(
                    window.state::<AppState>().inner(),
                ) {
                    window.state::<AppState>().diagnostics.record_runtime_error(
                        runtime::diagnostics::DiagnosticProbeKind::WallpaperEngine,
                        crate::runtime::now_ms(),
                        error,
                    );
                    // exact Scene 未确认关闭时不能把透明 host 留在最小化状态。
                    let _ = window.unminimize();
                    set_window_activity(window.app_handle(), WindowActivity::Visible);
                    window_adapter::emit_window_state_for_window(window);
                    return;
                }
                schedule_background_working_set_trim(window.app_handle().clone());
            }
        }
        _ => {}
    }

    let emit_mode = window_adapter::state_emit_mode_for_event(event);
    if let Some(mode) = emit_mode {
        match mode {
            window_adapter::WindowStateEmitMode::Now => {
                window_adapter::emit_window_state_for_window(window)
            }
            window_adapter::WindowStateEmitMode::Debounced => {
                window_adapter::emit_window_state_debounced(window.clone());
            }
        }
    }

    if !matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
        return;
    }
    let state = window.state::<AppState>();
    if state
        .window_runtime
        .lock()
        .ok()
        .and_then(|runtime| runtime.update_exit_status())
        .is_some()
    {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
        }
        return;
    }
    let close_will_exit = state
        .window_runtime
        .lock()
        .map(|runtime| {
            let snapshot = runtime.snapshot();
            snapshot.lifecycle.close_behavior == super::lifecycle::CloseBehavior::Exit
                || snapshot.tray_phase != runtime::window::TrayRuntimePhase::Ready
        })
        .unwrap_or(true);
    if !close_will_exit {
        if let Err(error) =
            super::wallpaper_engine_runtime::stop_for_window_deactivation(state.inner())
        {
            state.diagnostics.record_runtime_error(
                runtime::diagnostics::DiagnosticProbeKind::WallpaperEngine,
                crate::runtime::now_ms(),
                error,
            );
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
            }
            return;
        }
    }
    if close_will_exit && !super::full_desktop_runtime::recover_before_exit(window.app_handle()) {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
        }
        return;
    }
    let decision = state
        .window_runtime
        .lock()
        .map(|mut runtime| runtime.request_close())
        .unwrap_or(CloseDecision::Exit);
    match decision {
        CloseDecision::HideToTray => {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
            }
            let _ = window.hide();
            set_window_activity(
                window.app_handle(),
                WindowActivity::Hidden {
                    since_ms: crate::runtime::now_ms(),
                },
            );
            schedule_background_working_set_trim(window.app_handle().clone());
            if let Some(main_window) = window.app_handle().get_webview_window(window_labels::MAIN) {
                window_adapter::emit_window_state(&main_window);
            }
        }
        CloseDecision::Exit => {
            finish_cancelable_cleanup(
                cleanup_runtime_once(window.app_handle()).is_ok(),
                || window.app_handle().exit(0),
                || {
                    let _ = cancel_runtime_exit(window.app_handle());
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                    }
                },
            );
        }
        CloseDecision::Ignore => {}
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    #[test]
    fn single_instance_reactivation_uses_baseline_main_window_steps() {
        assert_eq!(
            single_instance_window_reactivation_steps(),
            ["show", "unminimize", "set_focus"]
        );
    }

    #[test]
    fn exact_scene_dispose_failure_stops_before_cleanup_claim() {
        let claim_called = Cell::new(false);

        let result = claim_cleanup_after_exact_scene(
            Err("WALLPAPER_ENGINE_EXIT_STOP_UNCONFIRMED".to_owned()),
            || {
                claim_called.set(true);
                Ok(true)
            },
        );

        assert_eq!(
            result,
            Err("WALLPAPER_ENGINE_EXIT_STOP_UNCONFIRMED".to_owned())
        );
        assert!(!claim_called.get());
    }

    #[test]
    fn cancelable_cleanup_failure_prevents_exit_without_running_exit_action() {
        let exit_called = Cell::new(false);
        let prevent_called = Cell::new(false);

        finish_cancelable_cleanup(false, || exit_called.set(true), || prevent_called.set(true));

        assert!(!exit_called.get());
        assert!(prevent_called.get());
    }

    #[test]
    fn already_completed_cleanup_remains_safe_for_reentrant_exit_request() {
        let result = claim_cleanup_after_exact_scene(Ok(()), || Ok(false));

        assert_eq!(result, Ok(false));
    }

    #[test]
    fn only_a_sealed_update_exit_bypasses_normal_cleanup() {
        assert_eq!(
            update_exit_run_decision(None),
            UpdateExitRunDecision::Normal
        );
        assert_eq!(
            update_exit_run_decision(Some(UpdateExitStatus::Prepared)),
            UpdateExitRunDecision::PreventExit
        );
        assert_eq!(
            update_exit_run_decision(Some(UpdateExitStatus::RecoveryRequired)),
            UpdateExitRunDecision::PreventExit
        );
        assert_eq!(
            update_exit_run_decision(Some(UpdateExitStatus::Sealed)),
            UpdateExitRunDecision::AllowExitWithoutCleanup
        );
    }
}
