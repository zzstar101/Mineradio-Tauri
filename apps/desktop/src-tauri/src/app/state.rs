use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use crate::{db, runtime, sidecar};

use super::{
    sidecar_owner::{SidecarLaunchDescriptor, SidecarUpdateOwnerState},
    update_install_gate::{UpdateInstallGate, UpdateInstallMutationPermit},
};

#[derive(serde::Serialize, Clone)]
pub struct RuntimeConfig {
    pub sidecar_base_url: String,
    pub app_data_dir: String,
    pub app_version: String,
    pub schema_version: String,
    pub updater_public_key_configured: bool,
}

#[derive(Default)]
pub struct DesktopLyricsRuntimeState {
    pub latest_payload: Option<serde_json::Value>,
    pub click_through: bool,
    pub hot_bounds: Option<runtime::desktop_lyrics::DesktopLyricsHotBounds>,
    pub user_bounds: Option<runtime::window::WindowGeometry>,
    pub programmatic_bounds_until_ms: u64,
    pub overlay_ready: bool,
    pub payload_generation: u64,
    pub monitor_bounds: Option<runtime::window::WindowGeometry>,
    pub scale_factor: Option<f64>,
    pub last_middle_at_ms: u64,
    pub poller_running: bool,
    pub poller_starting: bool,
    pub poller_desired: bool,
    pub poller_child: Option<DesktopLyricsPollerChild>,
}

pub struct DesktopLyricsPollerChild {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

/// Explorer watcher 的运行时所有权。worker 只做状态观察和主线程任务排队；它不直接
/// 操作 FullDesktopRuntime 或 Win32。停止时先令 policy 失效，再异步回收线程。
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FullDesktopReconcileOutcome {
    Success,
    Failure,
}

impl From<runtime::full_desktop::reconcile::ReconcileOutcome> for FullDesktopReconcileOutcome {
    fn from(outcome: runtime::full_desktop::reconcile::ReconcileOutcome) -> Self {
        match outcome {
            runtime::full_desktop::reconcile::ReconcileOutcome::Success => Self::Success,
            runtime::full_desktop::reconcile::ReconcileOutcome::Failure => Self::Failure,
        }
    }
}

#[derive(Default)]
pub struct FullDesktopExplorerWatcher {
    pub stop: Option<Arc<AtomicBool>>,
    pub policy: Option<Arc<Mutex<runtime::full_desktop::reconcile::ExplorerReconcilePolicy>>>,
    /// `unpark` 允许 mode/recovery/shutdown 立即打断 30 秒 inactive 等待，无需短周期轮询。
    pub wake: Option<std::thread::Thread>,
    pub worker: Option<JoinHandle<()>>,
    /// 仅由已被 policy 接受的 main-thread completion 更新；诊断读取不会触发 poll。
    pub last_reconcile_at_ms: Option<u64>,
    pub last_reconcile_outcome: Option<FullDesktopReconcileOutcome>,
}

/// Wallpaper capture health watcher 的唯一线程所有权。worker 只在 active 时低频调用
/// core reconcile；stop + unpark 保证退出后不会再取得 runtime mutation ownership。
#[derive(Default)]
pub struct WallpaperEngineReconcileWatcher {
    pub stop: Option<Arc<AtomicBool>>,
    pub wake: Option<std::thread::Thread>,
    pub worker: Option<JoinHandle<()>>,
}

impl DesktopLyricsPollerChild {
    pub fn new(stop: Arc<AtomicBool>, worker: JoinHandle<()>) -> Self {
        Self {
            stop,
            worker: Some(worker),
        }
    }

    #[cfg(test)]
    pub fn empty_for_test() -> Self {
        Self {
            stop: Arc::new(AtomicBool::new(false)),
            worker: None,
        }
    }

    pub fn terminate(mut self) -> Result<(), String> {
        self.stop.store(true, Ordering::Release);
        let Some(worker) = self.worker.take() else {
            return Ok(());
        };
        std::thread::Builder::new()
            .name("mineradio-desktop-lyrics-reaper".to_string())
            .spawn(move || {
                if worker.join().is_err() {
                    eprintln!("desktop lyrics input worker panicked");
                }
            })
            .map(|_| ())
            .map_err(|error| format!("desktop lyrics reaper start failed: {error}"))
    }

    /// update-install 需要在继续关闭其他 owner 前得到线程已退出的确定证据。超时不
    /// 丢弃 JoinHandle，caller 可在同一 recovery lease 上继续等待或回滚。
    #[allow(dead_code)]
    pub(crate) fn stop_and_join_bounded(&mut self, timeout: Duration) -> Result<bool, String> {
        self.stop.store(true, Ordering::Release);
        join_worker_bounded(
            &mut self.worker,
            timeout,
            "DESKTOP_LYRICS_POLLER_JOIN_PANICKED",
        )
    }
}

// update-install adapter 在 #54 接线前 dormant；普通退出仍不可同步等待 UI 线程。
#[allow(dead_code)]
pub(crate) fn join_worker_bounded(
    worker: &mut Option<JoinHandle<()>>,
    timeout: Duration,
    panic_code: &'static str,
) -> Result<bool, String> {
    let Some(current) = worker.as_ref() else {
        return Ok(true);
    };
    let deadline = Instant::now() + timeout;
    while !current.is_finished() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(false);
        }
        std::thread::sleep(remaining.min(Duration::from_millis(5)));
    }
    let current = worker.take().expect("finished worker 应仍由 owner 持有");
    current.join().map_err(|_| panic_code.to_owned())?;
    Ok(true)
}

impl Drop for DesktopLyricsPollerChild {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        // JoinHandle 在这里仅解除关联；退出路径不得在 UI 事件循环同步等待原生输入线程。
        let _ = self.worker.take();
    }
}

pub struct AppState {
    pub config: RuntimeConfig,
    pub started_at: Instant,
    pub desktop_lyrics: Mutex<DesktopLyricsRuntimeState>,
    pub window_runtime: Mutex<runtime::window::WindowRuntimeState>,
    pub full_desktop: Mutex<runtime::full_desktop::FullDesktopRuntime>,
    pub full_desktop_watcher: Mutex<FullDesktopExplorerWatcher>,
    pub desktop_wallpaper_transition: Arc<Mutex<()>>,
    pub wallpaper_engine: Arc<Mutex<runtime::wallpaper_engine::WallpaperEngineRuntime>>,
    pub wallpaper_engine_watcher: Mutex<WallpaperEngineReconcileWatcher>,
    pub wallpaper_scene_epoch: AtomicU64,
    pub wallpaper_engine_init_error: Option<String>,
    pub runtime_settings: Arc<Mutex<runtime::settings::RuntimeSettingsStore>>,
    pub cache: Option<Arc<Mutex<runtime::cache::CacheRuntime>>>,
    pub cache_init_error: Option<String>,
    pub local_library: Option<Arc<Mutex<runtime::local_library::LocalMusicLibraryRuntime>>>,
    pub diagnostics: runtime::diagnostics::DiagnosticsRuntime,
    pub resources: runtime::resources::ResourceGovernor,
    pub window_activity: Mutex<runtime::resources::WindowActivity>,
    pub application_runtime_running: AtomicBool,
    pub update_install_gate: UpdateInstallGate,
    pub sidecar: Mutex<sidecar::SidecarRuntimeState>,
    pub sidecar_supervisor_running: AtomicBool,
    pub(crate) sidecar_update_owner: Mutex<SidecarUpdateOwnerState>,
    pub(crate) sidecar_launch_descriptor: Mutex<Option<SidecarLaunchDescriptor>>,
    pub db: Option<Mutex<db::DbRuntimeState>>,
    pub db_init_error: Option<String>,
}

impl AppState {
    pub(crate) fn enter_update_install_mutation(
        &self,
    ) -> Result<UpdateInstallMutationPermit, String> {
        self.update_install_gate
            .enter_mutation()
            .map_err(|error| error.to_string())
    }

    // 这些参数逐一对应应用启动阶段的配置、日志与数据库状态资源，显式签名便于核对装配关系。
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        sidecar_base_url: String,
        app_data_dir: String,
        app_version: String,
        schema_version: String,
        updater_public_key_configured: bool,
        sidecar_log_path: PathBuf,
        db: Option<Mutex<db::DbRuntimeState>>,
        db_init_error: Option<String>,
        cache: Option<Arc<Mutex<runtime::cache::CacheRuntime>>>,
        cache_init_error: Option<String>,
        local_library: Option<Arc<Mutex<runtime::local_library::LocalMusicLibraryRuntime>>>,
        runtime_settings: Arc<Mutex<runtime::settings::RuntimeSettingsStore>>,
    ) -> Self {
        let settings_snapshot = runtime_settings
            .lock()
            .map(|settings| settings.snapshot())
            .unwrap_or_default();
        let settings_diagnostics = runtime_settings
            .lock()
            .map(|settings| settings.diagnostics().to_vec())
            .unwrap_or_default();
        let diagnostics = runtime::diagnostics::DiagnosticsRuntime::default();
        for issue in settings_diagnostics {
            let preserved = issue
                .preserved_path
                .as_ref()
                .map(|path| format!("；已保留至 {}", path.display()))
                .unwrap_or_default();
            diagnostics.record_runtime_error(
                runtime::diagnostics::DiagnosticProbeKind::Runtime,
                sidecar::now_ms(),
                format!("{}{}", issue.message, preserved),
            );
        }
        let wallpaper_library_path =
            PathBuf::from(&app_data_dir).join("wallpaper-engine-library-v1.json");
        let wallpaper_journal =
            runtime::wallpaper_engine::journal::FileWallpaperRecoveryJournalStore::for_app_data(
                PathBuf::from(&app_data_dir),
            );
        let (wallpaper_library, wallpaper_engine_init_error) =
            match runtime::wallpaper_engine::library::WallpaperLibrary::open(
                &wallpaper_library_path,
            ) {
                Ok(library) => (library, None),
                Err(error) => {
                    let code = error.code().to_owned();
                    diagnostics.record_runtime_error(
                        runtime::diagnostics::DiagnosticProbeKind::WallpaperEngine,
                        sidecar::now_ms(),
                        code.clone(),
                    );
                    // 损坏的用户配置保持原位供恢复；disabled runtime 使用不可持久化的
                    // 会话路径占位，command 编排层会根据 init_error 拒绝 mutation。
                    let fallback = std::env::temp_dir().join(format!(
                        "mineradio-wallpaper-library-disabled-{}-{}.json",
                        std::process::id(),
                        sidecar::now_ms(),
                    ));
                    let library =
                        runtime::wallpaper_engine::library::WallpaperLibrary::open(fallback)
                            .expect("临时 Wallpaper Engine 空库应可创建");
                    (library, Some(code))
                }
            };
        let wallpaper_engine = Arc::new(Mutex::new(
            runtime::wallpaper_engine::WallpaperEngineRuntime::new(
                wallpaper_library,
                Box::new(wallpaper_journal),
            ),
        ));
        Self {
            config: RuntimeConfig {
                sidecar_base_url: sidecar_base_url.clone(),
                app_data_dir: app_data_dir.clone(),
                app_version,
                schema_version,
                updater_public_key_configured,
            },
            started_at: Instant::now(),
            desktop_lyrics: Mutex::new(DesktopLyricsRuntimeState {
                latest_payload: None,
                click_through: true,
                hot_bounds: None,
                user_bounds: settings_snapshot.desktop_lyrics_bounds,
                programmatic_bounds_until_ms: 0,
                overlay_ready: false,
                payload_generation: 0,
                monitor_bounds: None,
                scale_factor: None,
                last_middle_at_ms: 0,
                poller_running: false,
                poller_starting: false,
                poller_desired: false,
                poller_child: None,
            }),
            window_runtime: Mutex::new(runtime::window::WindowRuntimeState::new(
                settings_snapshot.close_behavior,
            )),
            full_desktop: Mutex::new(runtime::full_desktop::FullDesktopRuntime::new(Box::new(
                runtime::full_desktop::FileRecoveryJournalStore::for_app_data(PathBuf::from(
                    &app_data_dir,
                )),
            ))),
            full_desktop_watcher: Mutex::new(FullDesktopExplorerWatcher::default()),
            desktop_wallpaper_transition: Arc::new(Mutex::new(())),
            wallpaper_engine,
            wallpaper_engine_watcher: Mutex::new(WallpaperEngineReconcileWatcher::default()),
            wallpaper_scene_epoch: AtomicU64::new(0),
            wallpaper_engine_init_error,
            runtime_settings,
            cache,
            cache_init_error,
            local_library,
            diagnostics,
            resources: runtime::resources::ResourceGovernor::default(),
            window_activity: Mutex::new(runtime::resources::WindowActivity::Foreground),
            application_runtime_running: AtomicBool::new(true),
            update_install_gate: UpdateInstallGate::default(),
            sidecar: Mutex::new(sidecar::SidecarRuntimeState::new(
                sidecar_base_url,
                sidecar_log_path,
            )),
            sidecar_supervisor_running: AtomicBool::new(true),
            sidecar_update_owner: Mutex::new(SidecarUpdateOwnerState::default()),
            sidecar_launch_descriptor: Mutex::new(None),
            db,
            db_init_error,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::{
            atomic::{AtomicU64, Ordering as AtomicOrdering},
            mpsc,
        },
        time::Duration,
    };

    static SETTINGS_TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn full_desktop_watcher_diagnostics_start_empty_and_use_typed_outcomes() {
        let watcher = FullDesktopExplorerWatcher::default();
        assert_eq!(watcher.last_reconcile_at_ms, None);
        assert_eq!(watcher.last_reconcile_outcome, None);
        assert_eq!(
            FullDesktopReconcileOutcome::from(
                runtime::full_desktop::reconcile::ReconcileOutcome::Failure
            ),
            FullDesktopReconcileOutcome::Failure
        );
    }

    #[test]
    fn desktop_lyrics_worker_reaping_never_waits_on_the_caller_thread() {
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let (release_tx, release_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            while !worker_stop.load(Ordering::Acquire) {
                std::thread::yield_now();
            }
            let _ = release_rx.recv();
        });
        let child = DesktopLyricsPollerChild::new(stop, worker);
        let (done_tx, done_rx) = mpsc::channel();
        let terminator = std::thread::spawn(move || {
            let _ = done_tx.send(child.terminate());
        });

        let result = done_rx
            .recv_timeout(Duration::from_millis(250))
            .expect("terminate 必须先返回，再由后台 reaper 等待 worker");
        assert!(result.is_ok());
        let _ = release_tx.send(());
        terminator.join().expect("terminator thread");
    }

    #[test]
    fn desktop_lyrics_bounded_join_retains_worker_after_timeout_for_retry() {
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let (release_tx, release_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            while !worker_stop.load(Ordering::Acquire) {
                std::thread::yield_now();
            }
            let _ = release_rx.recv();
        });
        let mut child = DesktopLyricsPollerChild::new(stop, worker);

        assert_eq!(
            child.stop_and_join_bounded(Duration::from_millis(10)),
            Ok(false)
        );
        release_tx.send(()).expect("应释放 worker");
        assert_eq!(
            child.stop_and_join_bounded(Duration::from_secs(1)),
            Ok(true)
        );
        assert_eq!(child.stop_and_join_bounded(Duration::ZERO), Ok(true));
    }

    #[test]
    fn app_state_new_builds_config() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let db_state = db::DbRuntimeState {
            conn,
            path: PathBuf::from("/data/mineradio.db"),
        };
        let sequence = SETTINGS_TEST_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
        let settings_path = std::env::temp_dir().join(format!(
            "mineradio-app-state-config-{}-{sequence}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&settings_path);

        let state = AppState::new(
            "http://127.0.0.1:1".into(),
            "/data".into(),
            "0.1.0".into(),
            "0.1.0".into(),
            false,
            PathBuf::from("/logs/sidecar-runtime.log"),
            Some(Mutex::new(db_state)),
            None,
            None,
            Some("cache disabled in unit test".to_string()),
            None,
            Arc::new(Mutex::new(
                runtime::settings::RuntimeSettingsStore::with_path(&settings_path),
            )),
        );

        assert_eq!(state.config.sidecar_base_url, "http://127.0.0.1:1");
        assert_eq!(state.config.app_data_dir, "/data");
        assert_eq!(state.config.app_version, "0.1.0");
        assert_eq!(state.config.schema_version, "0.1.0");
        assert!(!state.config.updater_public_key_configured);
        assert!(state.wallpaper_engine_init_error.is_none());
        assert_eq!(
            state
                .wallpaper_engine
                .lock()
                .expect("Wallpaper Engine runtime")
                .status()
                .phase,
            runtime::wallpaper_engine::WallpaperRuntimePhase::Unavailable,
        );
        let lyrics = state.desktop_lyrics.lock().expect("desktop lyrics state");
        assert!(lyrics.latest_payload.is_none());
        assert!(lyrics.click_through);
        assert!(lyrics.hot_bounds.is_none());
        assert!(lyrics.user_bounds.is_none());
        assert_eq!(lyrics.programmatic_bounds_until_ms, 0);
        assert!(!lyrics.overlay_ready);
        assert_eq!(lyrics.payload_generation, 0);
        assert!(lyrics.monitor_bounds.is_none());
        assert!(lyrics.scale_factor.is_none());
        assert_eq!(lyrics.last_middle_at_ms, 0);
        assert!(!lyrics.poller_running);
        assert!(!lyrics.poller_starting);
        assert!(!lyrics.poller_desired);
        assert!(lyrics.poller_child.is_none());
        let window = state.window_runtime.lock().expect("window runtime state");
        assert_eq!(
            window.snapshot().lifecycle.close_behavior,
            super::super::lifecycle::CloseBehavior::Exit
        );
        drop(window);
        let sidecar = state.sidecar.lock().expect("sidecar state");
        assert_eq!(sidecar.phase, sidecar::SidecarPhase::Starting);
        assert_eq!(sidecar.base_url, "http://127.0.0.1:1");
        assert!(sidecar.child.is_none());
        assert_eq!(sidecar.log_path, PathBuf::from("/logs/sidecar-runtime.log"));
        let _ = fs::remove_file(settings_path);
    }

    #[test]
    fn app_state_uses_persisted_close_policy_before_web_runtime_sync() {
        let sequence = SETTINGS_TEST_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
        let test_dir = std::env::temp_dir().join(format!(
            "mineradio-app-state-settings-{}-{sequence}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&test_dir);
        let settings_path = test_dir.join("runtime-settings.json");
        let mut settings = runtime::settings::RuntimeSettingsStore::with_path(&settings_path);
        settings
            .set_close_behavior(super::super::lifecycle::CloseBehavior::Tray)
            .expect("应持久化托盘关闭策略");
        let desktop_lyrics_bounds = runtime::window::WindowGeometry {
            x: -1200,
            y: 360,
            width: 1080,
            height: 340,
        };
        settings
            .set_desktop_lyrics_bounds(Some(desktop_lyrics_bounds))
            .expect("应持久化桌面歌词位置");
        let state = AppState::new(
            "http://127.0.0.1:1".into(),
            test_dir.to_string_lossy().into_owned(),
            "0.1.0".into(),
            "0.1.0".into(),
            false,
            test_dir.join("sidecar-runtime.log"),
            None,
            None,
            None,
            None,
            None,
            Arc::new(Mutex::new(settings)),
        );

        assert_eq!(
            state
                .window_runtime
                .lock()
                .expect("窗口运行时")
                .snapshot()
                .lifecycle
                .close_behavior,
            super::super::lifecycle::CloseBehavior::Tray
        );
        assert_eq!(
            state
                .desktop_lyrics
                .lock()
                .expect("桌面歌词运行时")
                .user_bounds,
            Some(desktop_lyrics_bounds)
        );
        let _ = fs::remove_dir_all(test_dir);
    }
}
