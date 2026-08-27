use std::{
    sync::{atomic::Ordering, mpsc, Arc, Mutex},
    thread::JoinHandle,
    time::Duration,
};

use tauri::Manager;

use crate::{
    runtime::{
        desktop_lyrics,
        full_desktop::{FullDesktopMode, FullDesktopRuntimeState},
        wallpaper_engine::StartWallpaperSceneRequest,
    },
    AppState, DesktopLyricsPollerChild,
};

use super::{
    full_desktop_runtime::{self, ExplorerWatcherInstallReceipt},
    update_install_gate::UpdateInstallGateClaim,
    update_install_quiescence::{
        NativeInstallOwnerPort, NativeInstallQuiescence, NativeInstallStage, NativeOwnerError,
        NativeOwnerPrepareFailure, NativeOwnerReceipt,
    },
    wallpaper_engine_runtime::{self, WallpaperWatcherInstallReceipt},
};

const OWNER_WAIT_TIMEOUT: Duration = Duration::from_secs(2);

struct TransitionOwner {
    acquired: mpsc::Receiver<Result<(), String>>,
    release: mpsc::Sender<()>,
    release_requested: bool,
    worker: Option<JoinHandle<()>>,
    acquisition_confirmed: bool,
}

impl TransitionOwner {
    fn spawn(transition: Arc<Mutex<()>>) -> Result<Self, String> {
        let (acquired_tx, acquired) = mpsc::sync_channel(1);
        let (release, release_rx) = mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("mineradio-update-transition-owner".to_owned())
            .spawn(move || match transition.lock() {
                Ok(_guard) => {
                    let _ = acquired_tx.send(Ok(()));
                    let _ = release_rx.recv();
                }
                Err(_) => {
                    let _ = acquired_tx
                        .send(Err("DESKTOP_WALLPAPER_TRANSITION_UNAVAILABLE".to_owned()));
                }
            })
            .map_err(|_| "UPDATE_INSTALL_TRANSITION_WORKER_FAILED".to_owned())?;
        Ok(Self {
            acquired,
            release,
            release_requested: false,
            worker: Some(worker),
            acquisition_confirmed: false,
        })
    }

    fn wait_acquired(&mut self, timeout: Duration) -> Result<(), String> {
        match self.acquired.recv_timeout(timeout) {
            Ok(Ok(())) => {
                self.acquisition_confirmed = true;
                Ok(())
            }
            Ok(Err(error)) => Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err("UPDATE_INSTALL_TRANSITION_TIMEOUT".to_owned())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("UPDATE_INSTALL_TRANSITION_WORKER_FAILED".to_owned())
            }
        }
    }

    fn release_bounded(&mut self, timeout: Duration) -> Result<bool, String> {
        if !self.release_requested {
            let _ = self.release.send(());
            self.release_requested = true;
        }
        super::state::join_worker_bounded(
            &mut self.worker,
            timeout,
            "UPDATE_INSTALL_TRANSITION_WORKER_PANICKED",
        )
    }
}

struct FullDesktopOwner {
    prior: Option<FullDesktopRuntimeState>,
    watcher: ExplorerWatcherInstallReceipt,
}

struct WallpaperOwner {
    recipe: Option<StartWallpaperSceneRequest>,
    recipe_captured: bool,
    watcher: WallpaperWatcherInstallReceipt,
}

struct DesktopLyricsOwner {
    was_running: bool,
    child: Option<DesktopLyricsPollerChild>,
}

#[derive(Default)]
struct NativeOperationOwners {
    claim: Option<UpdateInstallGateClaim>,
    transition: Option<TransitionOwner>,
    full_desktop: Option<FullDesktopOwner>,
    wallpaper: Option<WallpaperOwner>,
    desktop_lyrics: Option<DesktopLyricsOwner>,
}

impl NativeOperationOwners {
    fn ensure_exact(&self, claim: &UpdateInstallGateClaim) -> Result<(), NativeOwnerError> {
        if self.claim.as_ref() == Some(claim) {
            Ok(())
        } else {
            Err(NativeOwnerError::new("UPDATE_INSTALL_CLAIM_STALE"))
        }
    }
}

/// 真实 AppState owner 的 dormant Adapter。它只由 future update installer 组装函数引用，
/// 当前 command/bootstrap 不会触发 prepare；现有 API 行为保持不变。
pub(crate) struct TauriNativeInstallOwners {
    app: tauri::AppHandle,
    owners: Mutex<NativeOperationOwners>,
}

impl TauriNativeInstallOwners {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            owners: Mutex::new(NativeOperationOwners::default()),
        }
    }

    fn receipt(
        claim: &UpdateInstallGateClaim,
        stage: NativeInstallStage,
        label: &'static str,
    ) -> NativeOwnerReceipt {
        NativeOwnerReceipt::exact(claim, stage, format!("{}-{label}", claim.generation()))
    }

    fn clean_prepare(error: impl Into<String>) -> NativeOwnerPrepareFailure {
        NativeOwnerPrepareFailure::clean(NativeOwnerError::new(error))
    }

    fn owned_prepare(
        claim: &UpdateInstallGateClaim,
        stage: NativeInstallStage,
        label: &'static str,
        error: impl Into<String>,
    ) -> NativeOwnerPrepareFailure {
        NativeOwnerPrepareFailure::owned(
            NativeOwnerError::new(error),
            Self::receipt(claim, stage, label),
        )
    }

    fn lock_owners(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, NativeOperationOwners>, NativeOwnerError> {
        // Poison 不能成为绕过 exact rollback 的出口；状态仍在同一 Mutex 内，恢复路径
        // 继续持有并核验全部 receipt，而不是遗失已停止的原生 owner。
        Ok(self
            .owners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    fn restore_full_desktop(&self, claim: &UpdateInstallGateClaim) -> Result<(), NativeOwnerError> {
        let owner = {
            let mut owners = self.lock_owners()?;
            owners.ensure_exact(claim)?;
            owners.full_desktop.take()
        };
        let Some(mut owner_value) = owner else {
            return Ok(());
        };
        let state = self.app.state::<AppState>();
        let result = (|| {
            if let Some(prior_state) = owner_value.prior.as_ref() {
                let mut runtime = state
                    .full_desktop
                    .lock()
                    .map_err(|_| NativeOwnerError::new("FULL_DESKTOP_STATE_UNAVAILABLE"))?;
                if runtime.snapshot().recovery_required {
                    runtime.recover().map_err(|error| {
                        NativeOwnerError::new(format!("FULL_DESKTOP_{}", error.code()))
                    })?;
                }
                if prior_state.effective_mode != FullDesktopMode::Disabled {
                    runtime
                        .request_mode(prior_state.effective_mode)
                        .map_err(|error| {
                            NativeOwnerError::new(format!("FULL_DESKTOP_{}", error.code()))
                        })?;
                }
                let restored = runtime.snapshot();
                if restored.effective_mode != prior_state.effective_mode
                    || restored.icons_visible != prior_state.icons_visible
                    || restored.interaction_locked != prior_state.interaction_locked
                    || restored.recovery_required
                    || runtime.has_recovery_journal()
                {
                    return Err(NativeOwnerError::new("FULL_DESKTOP_ROLLBACK_UNCONFIRMED"));
                }
            }
            if !owner_value
                .watcher
                .join_bounded(OWNER_WAIT_TIMEOUT)
                .map_err(NativeOwnerError::new)?
            {
                return Err(NativeOwnerError::new("FULL_DESKTOP_WATCHER_JOIN_TIMEOUT"));
            }
            owner_value
                .watcher
                .restore(&self.app)
                .map_err(NativeOwnerError::new)?;
            Ok(())
        })();
        if result.is_err() {
            self.lock_owners()?.full_desktop = Some(owner_value);
        } else {
            full_desktop_runtime::sync_native_recovery_surfaces(&self.app);
        }
        result
    }

    fn restore_wallpaper(&self, claim: &UpdateInstallGateClaim) -> Result<(), NativeOwnerError> {
        let owner = {
            let mut owners = self.lock_owners()?;
            owners.ensure_exact(claim)?;
            owners.wallpaper.take()
        };
        let Some(mut owner_value) = owner else {
            return Ok(());
        };
        let state = self.app.state::<AppState>();
        let result = (|| {
            {
                let mut runtime = state
                    .wallpaper_engine
                    .lock()
                    .map_err(|_| NativeOwnerError::new("WALLPAPER_ENGINE_STATE_UNAVAILABLE"))?;
                if runtime.status().cleanup_required {
                    runtime
                        .recover()
                        .map_err(|error| NativeOwnerError::new(error.code().to_owned()))?;
                }
                match owner_value.recipe.as_ref() {
                    Some(recipe) => {
                        if runtime.active_restart_recipe().as_ref() != Some(recipe) {
                            if runtime.status().active {
                                runtime.stop_scene(None).map_err(|error| {
                                    NativeOwnerError::new(error.code().to_owned())
                                })?;
                            }
                            runtime
                                .start_scene(recipe.clone())
                                .map_err(|error| NativeOwnerError::new(error.code().to_owned()))?;
                        }
                        if runtime.active_restart_recipe().as_ref() != Some(recipe)
                            || runtime.status().cleanup_required
                        {
                            return Err(NativeOwnerError::new(
                                "WALLPAPER_ENGINE_ROLLBACK_UNCONFIRMED",
                            ));
                        }
                    }
                    None if runtime.status().active || runtime.status().cleanup_required => {
                        return Err(NativeOwnerError::new(
                            "WALLPAPER_ENGINE_ROLLBACK_UNCONFIRMED",
                        ));
                    }
                    None => {}
                }
            }
            if !owner_value
                .watcher
                .join_bounded(OWNER_WAIT_TIMEOUT)
                .map_err(NativeOwnerError::new)?
            {
                return Err(NativeOwnerError::new(
                    "WALLPAPER_ENGINE_WATCHER_JOIN_TIMEOUT",
                ));
            }
            owner_value
                .watcher
                .restore(&self.app)
                .map_err(NativeOwnerError::new)?;
            Ok(())
        })();
        if result.is_err() {
            self.lock_owners()?.wallpaper = Some(owner_value);
        }
        result
    }

    fn restore_desktop_lyrics(
        &self,
        claim: &UpdateInstallGateClaim,
    ) -> Result<(), NativeOwnerError> {
        let prior = {
            let mut owners = self.lock_owners()?;
            owners.ensure_exact(claim)?;
            owners.desktop_lyrics.take()
        };
        let Some(mut prior_state) = prior else {
            return Ok(());
        };
        let result = (|| {
            if let Some(child) = prior_state.child.as_mut() {
                if !child
                    .stop_and_join_bounded(OWNER_WAIT_TIMEOUT)
                    .map_err(NativeOwnerError::new)?
                {
                    return Err(NativeOwnerError::new("DESKTOP_LYRICS_POLLER_JOIN_TIMEOUT"));
                }
            }
            prior_state.child = None;
            if prior_state.was_running {
                let state = self.app.state::<AppState>();
                desktop_lyrics::desktop_lyrics_start_middle_click_poller(
                    self.app.clone(),
                    state.inner(),
                )
                .map_err(NativeOwnerError::new)?;
            }
            Ok(())
        })();
        if result.is_err() {
            self.lock_owners()?.desktop_lyrics = Some(prior_state);
        }
        result
    }

    fn release_transition(&self, claim: &UpdateInstallGateClaim) -> Result<(), NativeOwnerError> {
        let transition = {
            let mut owners = self.lock_owners()?;
            owners.ensure_exact(claim)?;
            owners.transition.take()
        };
        let Some(mut transition_owner) = transition else {
            return Ok(());
        };
        let result = match transition_owner.release_bounded(OWNER_WAIT_TIMEOUT) {
            Ok(true) => Ok(()),
            Ok(false) => Err(NativeOwnerError::new(
                "UPDATE_INSTALL_TRANSITION_RELEASE_TIMEOUT",
            )),
            Err(error) => Err(NativeOwnerError::new(error)),
        };
        if result.is_err() {
            self.lock_owners()?.transition = Some(transition_owner);
        }
        result
    }
}

impl NativeInstallOwnerPort for TauriNativeInstallOwners {
    fn acquire_transition(
        &self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
        {
            let mut owners = self.lock_owners()?;
            match owners.claim.as_ref() {
                None => owners.claim = Some(operation.clone()),
                Some(current) if current == operation => {}
                Some(_) => return Err(Self::clean_prepare("UPDATE_INSTALL_CLAIM_STALE")),
            }
            if owners.transition.is_some() {
                return Err(Self::clean_prepare(
                    "UPDATE_INSTALL_TRANSITION_ALREADY_OWNED",
                ));
            }
        }

        let transition = self
            .app
            .state::<AppState>()
            .desktop_wallpaper_transition
            .clone();
        let mut owner = TransitionOwner::spawn(transition).map_err(NativeOwnerError::new)?;
        let result = owner.wait_acquired(OWNER_WAIT_TIMEOUT);
        self.lock_owners()?.transition = Some(owner);
        if let Err(error) = result {
            return Err(Self::owned_prepare(
                operation,
                NativeInstallStage::Transition,
                "transition",
                error,
            ));
        }
        Ok(Self::receipt(
            operation,
            NativeInstallStage::Transition,
            "transition",
        ))
    }

    fn disable_full_desktop_without_persisting_preference(
        &self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
        self.lock_owners()?.ensure_exact(operation)?;
        let state = self.app.state::<AppState>();
        let mut watcher = full_desktop_runtime::take_explorer_watcher_for_update(state.inner())
            .map_err(NativeOwnerError::new)?;
        let joined = watcher.join_bounded(OWNER_WAIT_TIMEOUT);
        self.lock_owners()?.full_desktop = Some(FullDesktopOwner {
            prior: None,
            watcher,
        });
        let joined = joined.map_err(|error| {
            Self::owned_prepare(
                operation,
                NativeInstallStage::FullDesktop,
                "full-desktop",
                error,
            )
        })?;
        if !joined {
            return Err(Self::owned_prepare(
                operation,
                NativeInstallStage::FullDesktop,
                "full-desktop",
                "FULL_DESKTOP_WATCHER_JOIN_TIMEOUT",
            ));
        }
        let prior = state
            .full_desktop
            .lock()
            .map_err(|_| {
                Self::owned_prepare(
                    operation,
                    NativeInstallStage::FullDesktop,
                    "full-desktop",
                    "FULL_DESKTOP_STATE_UNAVAILABLE",
                )
            })?
            .snapshot();
        self.lock_owners()?
            .full_desktop
            .as_mut()
            .expect("Full Desktop watcher receipt 应已安装")
            .prior = Some(prior);
        state
            .full_desktop
            .lock()
            .map_err(|_| {
                Self::owned_prepare(
                    operation,
                    NativeInstallStage::FullDesktop,
                    "full-desktop",
                    "FULL_DESKTOP_STATE_UNAVAILABLE",
                )
            })?
            .disable_for_shutdown()
            .map_err(|error| {
                Self::owned_prepare(
                    operation,
                    NativeInstallStage::FullDesktop,
                    "full-desktop",
                    format!("FULL_DESKTOP_{}", error.code()),
                )
            })?;
        Ok(Self::receipt(
            operation,
            NativeInstallStage::FullDesktop,
            "full-desktop",
        ))
    }

    fn capture_and_stop_wallpaper(
        &self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
        self.lock_owners()?.ensure_exact(operation)?;
        let state = self.app.state::<AppState>();
        let mut watcher =
            wallpaper_engine_runtime::take_reconcile_watcher_for_update(state.inner())
                .map_err(NativeOwnerError::new)?;
        let joined = watcher.join_bounded(OWNER_WAIT_TIMEOUT);
        self.lock_owners()?.wallpaper = Some(WallpaperOwner {
            recipe: None,
            recipe_captured: false,
            watcher,
        });
        let joined = joined.map_err(|error| {
            Self::owned_prepare(operation, NativeInstallStage::Wallpaper, "wallpaper", error)
        })?;
        if !joined {
            return Err(Self::owned_prepare(
                operation,
                NativeInstallStage::Wallpaper,
                "wallpaper",
                "WALLPAPER_ENGINE_WATCHER_JOIN_TIMEOUT",
            ));
        }
        state.wallpaper_scene_epoch.fetch_add(1, Ordering::AcqRel);
        let recipe = state
            .wallpaper_engine
            .lock()
            .map_err(|_| {
                Self::owned_prepare(
                    operation,
                    NativeInstallStage::Wallpaper,
                    "wallpaper",
                    "WALLPAPER_ENGINE_STATE_UNAVAILABLE",
                )
            })?
            .active_restart_recipe();
        {
            let mut owners = self.lock_owners()?;
            let owner = owners
                .wallpaper
                .as_mut()
                .expect("Wallpaper watcher receipt 应已安装");
            owner.recipe = recipe;
            owner.recipe_captured = true;
        }
        let mut runtime = state.wallpaper_engine.lock().map_err(|_| {
            Self::owned_prepare(
                operation,
                NativeInstallStage::Wallpaper,
                "wallpaper",
                "WALLPAPER_ENGINE_STATE_UNAVAILABLE",
            )
        })?;
        let expected_session = runtime.status().session_id.clone();
        let stopped = runtime
            .stop_scene((!expected_session.is_empty()).then_some(expected_session.as_str()))
            .map_err(|error| {
                Self::owned_prepare(
                    operation,
                    NativeInstallStage::Wallpaper,
                    "wallpaper",
                    error.code().to_owned(),
                )
            })?;
        if stopped.state.active || stopped.state.cleanup_required {
            return Err(Self::owned_prepare(
                operation,
                NativeInstallStage::Wallpaper,
                "wallpaper",
                "WALLPAPER_ENGINE_UPDATE_STOP_UNCONFIRMED",
            ));
        }
        Ok(Self::receipt(
            operation,
            NativeInstallStage::Wallpaper,
            "wallpaper",
        ))
    }

    fn stop_and_join_desktop_lyrics_worker(
        &self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
        self.lock_owners()?.ensure_exact(operation)?;
        let state = self.app.state::<AppState>();
        let (was_running, child) = {
            let mut lyrics = state
                .desktop_lyrics
                .lock()
                .map_err(|_| NativeOwnerError::new("DESKTOP_LYRICS_STATE_UNAVAILABLE"))?;
            desktop_lyrics::desktop_lyrics_stop_middle_click_poller_state(&mut lyrics)
        };
        let mut owner = DesktopLyricsOwner { was_running, child };
        let joined = match owner.child.as_mut() {
            Some(child) => child.stop_and_join_bounded(OWNER_WAIT_TIMEOUT),
            None => Ok(true),
        };
        if joined.as_ref() == Ok(&true) {
            owner.child = None;
        }
        self.lock_owners()?.desktop_lyrics = Some(owner);
        let joined = joined.map_err(|error| {
            Self::owned_prepare(
                operation,
                NativeInstallStage::DesktopLyrics,
                "desktop-lyrics",
                error,
            )
        })?;
        if !joined {
            return Err(Self::owned_prepare(
                operation,
                NativeInstallStage::DesktopLyrics,
                "desktop-lyrics",
                "DESKTOP_LYRICS_POLLER_JOIN_TIMEOUT",
            ));
        }
        Ok(Self::receipt(
            operation,
            NativeInstallStage::DesktopLyrics,
            "desktop-lyrics",
        ))
    }

    fn verify_prepared(
        &self,
        operation: &UpdateInstallGateClaim,
        receipts: &[NativeOwnerReceipt],
    ) -> Result<(), NativeOwnerError> {
        let owners = self.lock_owners()?;
        owners.ensure_exact(operation)?;
        if receipts.len() != 4
            || !owners
                .transition
                .as_ref()
                .is_some_and(|owner| owner.acquisition_confirmed && owner.worker.is_some())
            || owners
                .full_desktop
                .as_ref()
                .is_none_or(|owner| owner.prior.is_none())
            || owners
                .wallpaper
                .as_ref()
                .is_none_or(|owner| !owner.recipe_captured)
            || owners.desktop_lyrics.is_none()
        {
            return Err(NativeOwnerError::new(
                "UPDATE_INSTALL_NATIVE_RECEIPTS_INCOMPLETE",
            ));
        }
        drop(owners);

        let state = self.app.state::<AppState>();
        let full_desktop = state
            .full_desktop
            .lock()
            .map_err(|_| NativeOwnerError::new("FULL_DESKTOP_STATE_UNAVAILABLE"))?;
        let full_snapshot = full_desktop.snapshot();
        if full_snapshot.effective_mode != FullDesktopMode::Disabled
            || full_snapshot.recovery_required
            || full_desktop.has_recovery_journal()
        {
            return Err(NativeOwnerError::new(
                "FULL_DESKTOP_UPDATE_STOP_UNCONFIRMED",
            ));
        }
        drop(full_desktop);
        let wallpaper = state
            .wallpaper_engine
            .lock()
            .map_err(|_| NativeOwnerError::new("WALLPAPER_ENGINE_STATE_UNAVAILABLE"))?;
        if wallpaper.status().active || wallpaper.status().cleanup_required {
            return Err(NativeOwnerError::new(
                "WALLPAPER_ENGINE_UPDATE_STOP_UNCONFIRMED",
            ));
        }
        drop(wallpaper);
        let lyrics = state
            .desktop_lyrics
            .lock()
            .map_err(|_| NativeOwnerError::new("DESKTOP_LYRICS_STATE_UNAVAILABLE"))?;
        if lyrics.poller_running || lyrics.poller_starting || lyrics.poller_child.is_some() {
            return Err(NativeOwnerError::new(
                "DESKTOP_LYRICS_UPDATE_STOP_UNCONFIRMED",
            ));
        }
        drop(lyrics);
        Ok(())
    }

    fn rollback_owner(
        &self,
        operation: &UpdateInstallGateClaim,
        receipt: &NativeOwnerReceipt,
    ) -> Result<(), NativeOwnerError> {
        self.lock_owners()?.ensure_exact(operation)?;
        match receipt.stage() {
            NativeInstallStage::DesktopLyrics => self.restore_desktop_lyrics(operation),
            NativeInstallStage::Wallpaper => self.restore_wallpaper(operation),
            NativeInstallStage::FullDesktop => self.restore_full_desktop(operation),
            NativeInstallStage::Transition => self.release_transition(operation),
            _ => Err(NativeOwnerError::new(
                "UPDATE_INSTALL_ROLLBACK_STAGE_INVALID",
            )),
        }
    }

    fn verify_rollback(&self, operation: &UpdateInstallGateClaim) -> Result<(), NativeOwnerError> {
        let has_operation = self.lock_owners()?.claim.is_some();
        if !has_operation {
            return Ok(());
        }
        self.lock_owners()?.ensure_exact(operation)?;
        self.restore_desktop_lyrics(operation)?;
        self.restore_wallpaper(operation)?;
        self.restore_full_desktop(operation)?;
        self.release_transition(operation)?;
        let mut owners = self.lock_owners()?;
        owners.ensure_exact(operation)?;
        if owners.transition.is_some()
            || owners.full_desktop.is_some()
            || owners.wallpaper.is_some()
            || owners.desktop_lyrics.is_some()
        {
            return Err(NativeOwnerError::new(
                "UPDATE_INSTALL_NATIVE_ROLLBACK_INCOMPLETE",
            ));
        }
        owners.claim = None;
        Ok(())
    }
}

pub(crate) fn production_native_quiescence(app: tauri::AppHandle) -> NativeInstallQuiescence {
    // coordinator 只在 bounded blocking worker 内调用同步 native Adapter。
    let gate = app.state::<AppState>().update_install_gate.clone();
    NativeInstallQuiescence::new(gate, Arc::new(TauriNativeInstallOwners::new(app)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transition_owner_holds_exact_mutex_until_bounded_release() {
        let transition = Arc::new(Mutex::new(()));
        let mut owner = TransitionOwner::spawn(Arc::clone(&transition)).expect("应启动 owner");

        owner
            .wait_acquired(Duration::from_secs(1))
            .expect("应取得 transition ownership");
        assert!(transition.try_lock().is_err());
        assert_eq!(owner.release_bounded(Duration::from_secs(1)), Ok(true));
        assert!(transition.try_lock().is_ok());
    }

    #[test]
    fn transition_acquire_timeout_retains_join_for_exact_retry() {
        let transition = Arc::new(Mutex::new(()));
        let blocking_guard = transition.lock().expect("测试应先占有 transition");
        let mut owner = TransitionOwner::spawn(Arc::clone(&transition)).expect("应启动 owner");

        assert_eq!(
            owner.wait_acquired(Duration::from_millis(10)),
            Err("UPDATE_INSTALL_TRANSITION_TIMEOUT".to_owned())
        );
        assert_eq!(owner.release_bounded(Duration::from_millis(10)), Ok(false));
        drop(blocking_guard);
        assert_eq!(owner.release_bounded(Duration::from_secs(1)), Ok(true));
    }
}
