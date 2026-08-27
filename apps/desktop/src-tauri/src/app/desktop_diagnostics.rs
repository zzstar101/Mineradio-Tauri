//! Desktop Runtime 诊断编排。
//!
//! 诊断 command 只负责稳定 IPC 入口；这里组合各运行时的只读状态。除手动
//! working-set trim 的显式失败记录外，读取诊断快照绝不写入运行时状态，也不
//! 触发缓存扫描。

use crate::{
    app::window_labels,
    db,
    runtime::{
        diagnostics::{DiagnosticProbe, DiagnosticProbeKind, DiagnosticsSnapshot},
        hotkeys,
        resources::{
            ProcessMemoryAdapter, ResourceGovernanceSnapshot, SystemPurgeOutcome, TrimOutcome,
            WindowsProcessMemoryAdapter,
        },
        window_adapter,
        window_contract::WindowStateSnapshot,
    },
    AppState,
};
use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeDiagnostics {
    app_version: String,
    schema_version: String,
    pid: u32,
    uptime_ms: u64,
    platform: &'static str,
    architecture: &'static str,
    updater_public_key_configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopLyricsDiagnostics {
    enabled: bool,
    window_exists: bool,
    window_visible: Option<bool>,
    window_focused: Option<bool>,
    click_through: bool,
    has_payload: bool,
    has_hot_bounds: bool,
    user_bounds: Option<crate::runtime::window::WindowGeometry>,
    overlay_ready: bool,
    payload_generation: u64,
    monitor_bounds: Option<crate::runtime::window::WindowGeometry>,
    scale_factor: Option<f64>,
    input_worker_running: bool,
    input_worker_starting: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FullDesktopDiagnostics {
    state: crate::runtime::full_desktop::FullDesktopRuntimeState,
    /// 这是 controller 对已确认 attach 的期望，不宣称是一次新的 Win32 实测。
    /// 诊断读取不得为了填充此字段扫描 Explorer 或触发 reconcile。
    expected_main_desktop_child: bool,
    /// 当前主窗口 parent 与已经验证的 desktop host identity 的只读比对结果。`None`
    /// 表示运行时不在稳定附着阶段，或 native probe 无法证明该事实；它绝不等同于 true。
    actual_main_desktop_child: Option<bool>,
    recovery_journal_present: bool,
    recovery_journal_version: Option<u32>,
    last_failure_code: Option<String>,
    watcher_running: bool,
    watcher_stop_requested: bool,
    last_reconcile_at_ms: Option<u64>,
    last_reconcile_outcome: Option<crate::app::state::FullDesktopReconcileOutcome>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WallpaperEngineDiagnostics {
    state: crate::runtime::wallpaper_engine::WallpaperRuntimeState,
    recovery_journal_present: bool,
    recovery_journal_version: Option<u32>,
    recovery_phase: Option<crate::runtime::wallpaper_engine::journal::WallpaperRecoveryPhase>,
    initialization_error: Option<String>,
}

fn expected_main_desktop_child(
    state: &crate::runtime::full_desktop::FullDesktopRuntimeState,
) -> bool {
    use crate::runtime::full_desktop::{FullDesktopMode, FullDesktopPhase};

    matches!(
        (state.phase, state.effective_mode),
        (FullDesktopPhase::Passive, FullDesktopMode::Passive)
            | (FullDesktopPhase::Interactive, FullDesktopMode::Interactive)
    )
}

fn main_window_snapshot(app: &tauri::AppHandle) -> Result<WindowStateSnapshot, String> {
    let window = app
        .get_webview_window(window_labels::MAIN)
        .ok_or_else(|| "main window not found".to_string())?;
    Ok(window_adapter::snapshot_for_webview_window(&window))
}

/// 收集不可变诊断快照。
///
/// 任何单个 native probe 失败都仅降级自己的条目，不能让整个诊断面板不可用。
pub fn snapshot(app: &tauri::AppHandle, state: &AppState) -> DiagnosticsSnapshot {
    let captured_at_ms = crate::runtime::now_ms();
    // `latest_snapshot` 是上一次已发布结果；诊断读取不能隐式递归扫描磁盘。
    let cache_snapshot = state
        .cache
        .as_ref()
        .and_then(|cache| cache.lock().ok().map(|runtime| runtime.latest_snapshot()));

    let mut probes = vec![
        DiagnosticProbe::value(
            DiagnosticProbeKind::Runtime,
            captured_at_ms,
            RuntimeDiagnostics {
                app_version: state.config.app_version.clone(),
                schema_version: state.config.schema_version.clone(),
                pid: std::process::id(),
                uptime_ms: u64::try_from(state.started_at.elapsed().as_millis())
                    .unwrap_or(u64::MAX),
                platform: std::env::consts::OS,
                architecture: std::env::consts::ARCH,
                updater_public_key_configured: state.config.updater_public_key_configured,
            },
        ),
        DiagnosticProbe::capture(DiagnosticProbeKind::Window, captured_at_ms, || {
            main_window_snapshot(app)
        }),
        DiagnosticProbe::capture(DiagnosticProbeKind::Tray, captured_at_ms, || {
            state
                .window_runtime
                .lock()
                .map(|runtime| runtime.snapshot())
                .map_err(|error| error.to_string())
        }),
        DiagnosticProbe::capture(DiagnosticProbeKind::FullDesktop, captured_at_ms, || {
            let runtime = state
                .full_desktop
                .lock()
                .map_err(|error| error.to_string())?;
            let recovery_journal_present = runtime.has_recovery_journal();
            let recovery_journal_version = runtime.recovery_journal_version();
            let last_failure_code = runtime.last_error_code().map(str::to_owned);
            let runtime_state = runtime.snapshot();
            let expected_main_desktop_child = expected_main_desktop_child(&runtime_state);
            let actual_main_desktop_child = runtime.actual_main_desktop_child();
            drop(runtime);
            let watcher = state
                .full_desktop_watcher
                .lock()
                .map_err(|error| error.to_string())?;
            Ok::<_, String>(FullDesktopDiagnostics {
                state: runtime_state,
                expected_main_desktop_child,
                actual_main_desktop_child,
                recovery_journal_present,
                recovery_journal_version,
                last_failure_code,
                watcher_running: watcher.worker.is_some(),
                watcher_stop_requested: watcher
                    .stop
                    .as_ref()
                    .is_some_and(|stop| stop.load(std::sync::atomic::Ordering::Acquire)),
                last_reconcile_at_ms: watcher.last_reconcile_at_ms,
                last_reconcile_outcome: watcher.last_reconcile_outcome,
            })
        }),
        DiagnosticProbe::capture(DiagnosticProbeKind::WallpaperEngine, captured_at_ms, || {
            state
                .wallpaper_engine
                .lock()
                .map(|runtime| WallpaperEngineDiagnostics {
                    state: runtime.status().clone(),
                    recovery_journal_present: runtime.recovery_journal_version().is_some()
                        || runtime.status().cleanup_required,
                    recovery_journal_version: runtime.recovery_journal_version(),
                    recovery_phase: runtime.recovery_phase(),
                    initialization_error: state.wallpaper_engine_init_error.clone(),
                })
                .map_err(|error| error.to_string())
        }),
        DiagnosticProbe::capture(DiagnosticProbeKind::DesktopLyrics, captured_at_ms, || {
            let window = app.get_webview_window(window_labels::DESKTOP_LYRICS);
            let window_exists = window.is_some();
            let window_visible = window.as_ref().and_then(|window| window.is_visible().ok());
            let window_focused = window.as_ref().and_then(|window| window.is_focused().ok());
            state
                .desktop_lyrics
                .lock()
                .map(|lyrics| DesktopLyricsDiagnostics {
                    enabled: lyrics
                        .latest_payload
                        .as_ref()
                        .and_then(|payload| payload.get("enabled"))
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                    window_exists,
                    window_visible,
                    window_focused,
                    click_through: lyrics.click_through,
                    has_payload: lyrics.latest_payload.is_some(),
                    has_hot_bounds: lyrics.hot_bounds.is_some(),
                    user_bounds: lyrics.user_bounds,
                    overlay_ready: lyrics.overlay_ready,
                    payload_generation: lyrics.payload_generation,
                    monitor_bounds: lyrics.monitor_bounds,
                    scale_factor: lyrics.scale_factor,
                    input_worker_running: lyrics.poller_running,
                    input_worker_starting: lyrics.poller_starting,
                })
                .map_err(|error| error.to_string())
        }),
        DiagnosticProbe::value(
            DiagnosticProbeKind::Hotkeys,
            captured_at_ms,
            hotkeys::hotkey_runtime_snapshot(),
        ),
        DiagnosticProbe::value(
            DiagnosticProbeKind::ProcessMemory,
            captured_at_ms,
            state.resources.snapshot(),
        ),
    ];

    probes.push(match cache_snapshot {
        Some(snapshot) => {
            DiagnosticProbe::value(DiagnosticProbeKind::Cache, captured_at_ms, snapshot)
        }
        None => DiagnosticProbe::unavailable(
            DiagnosticProbeKind::Cache,
            captured_at_ms,
            state
                .cache_init_error
                .clone()
                .unwrap_or_else(|| "cache runtime not initialized".to_string()),
        ),
    });

    probes.push(match &state.db {
        Some(database) => {
            DiagnosticProbe::capture(DiagnosticProbeKind::Database, captured_at_ms, || {
                let database = database.lock().map_err(|error| error.to_string())?;
                db::build_database_status(&database.conn, &database.path)
                    .map_err(|error| error.to_string())
            })
        }
        None => DiagnosticProbe::unavailable(
            DiagnosticProbeKind::Database,
            captured_at_ms,
            state
                .db_init_error
                .clone()
                .unwrap_or_else(|| "database not initialized".to_string()),
        ),
    });

    let memory_adapter = WindowsProcessMemoryAdapter;
    probes.push(DiagnosticProbe::capture(
        DiagnosticProbeKind::Native,
        captured_at_ms,
        || memory_adapter.snapshot_verified_process_tree(),
    ));
    probes.push(DiagnosticProbe::unavailable(
        DiagnosticProbeKind::Visual,
        captured_at_ms,
        "GPU/visual 数据由 Web VisualEngine diagnostics 组合",
    ));

    state.diagnostics.snapshot(captured_at_ms, probes)
}

pub fn resource_governance(state: &AppState) -> ResourceGovernanceSnapshot {
    state.resources.snapshot()
}

/// 显式手动 trim 是有副作用的用户操作；失败需要进入运行时错误历史，供后续
/// 只读诊断快照展示。
pub fn trim_application_working_set(
    state: &AppState,
    force: Option<bool>,
) -> Result<TrimOutcome, String> {
    let activity = *state
        .window_activity
        .lock()
        .map_err(|error| error.to_string())?;
    let outcome = state.resources.trim_working_set_manual(
        activity,
        crate::runtime::now_ms(),
        force.unwrap_or(false),
        &WindowsProcessMemoryAdapter,
    );
    if matches!(outcome, TrimOutcome::Failed { .. }) {
        state.diagnostics.record_runtime_error(
            DiagnosticProbeKind::ProcessMemory,
            crate::runtime::now_ms(),
            format!("manual working-set trim failed: {outcome:?}"),
        );
    }
    Ok(outcome)
}

pub fn purge_system_memory(state: &AppState) -> SystemPurgeOutcome {
    state.resources.request_system_purge()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_reading_is_delegated_to_the_immutable_runtime_aggregator() {
        let diagnostics = crate::runtime::diagnostics::DiagnosticsRuntime::new(4);
        diagnostics.record_runtime_error(DiagnosticProbeKind::Runtime, 1, "startup failure");
        let probes = [DiagnosticProbe::unavailable(
            DiagnosticProbeKind::Visual,
            2,
            "provided by the web runtime",
        )];

        let first = diagnostics.snapshot(2, probes.clone());
        let second = diagnostics.snapshot(2, probes);

        assert_eq!(first, second);
        assert_eq!(diagnostics.recent_errors().len(), 1);
    }

    #[test]
    fn desktop_child_fact_is_explicitly_expected_and_requires_a_stable_active_phase() {
        use crate::runtime::full_desktop::{
            FullDesktopMode, FullDesktopPhase, FullDesktopRuntimeState,
        };

        let active = FullDesktopRuntimeState {
            phase: FullDesktopPhase::Interactive,
            requested_mode: FullDesktopMode::Interactive,
            effective_mode: FullDesktopMode::Interactive,
            icons_visible: true,
            interaction_locked: false,
            recovery_required: false,
            auto_resume_suppressed: false,
            explorer_generation: 3,
            last_error: None,
        };
        assert!(expected_main_desktop_child(&active));

        let transitioning = FullDesktopRuntimeState {
            phase: FullDesktopPhase::Recovering,
            ..active.clone()
        };
        assert!(!expected_main_desktop_child(&transitioning));

        let inconsistent = FullDesktopRuntimeState {
            phase: FullDesktopPhase::Passive,
            effective_mode: FullDesktopMode::Interactive,
            ..active
        };
        assert!(!expected_main_desktop_child(&inconsistent));
    }
}
