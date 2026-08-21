//! 受保护发布专用 harness。
//!
//! 该模块只在显式 `updater-smoke` feature 下编译。正式 Tauri 构建不启用该
//! feature，因此 Draft source、staging reader 与 smoke CLI 不进入公开二进制。

use std::{
    ffi::OsString,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::{
    app::{
        update_install_coordinator::{
            RuntimeUpdateInstallerAdapter, UpdateInstallCoordinator, UpdateInstallCoordinatorPhase,
            UpdateInstallCoordinatorPort,
        },
        update_install_exit::{
            InfallibleInstallExitCapability, InstallExitOwnershipError, InstallExitOwnershipPort,
            InstallExitOwnershipReceipt, InstallExitRecoveryEvidence,
        },
        update_install_gate::{UpdateInstallGate, UpdateInstallGateClaim},
        update_install_quiescence::{
            NativeInstallOwnerPort, NativeInstallQuiescence, NativeInstallStage, NativeOwnerError,
            NativeOwnerPrepareFailure, NativeOwnerReceipt,
        },
    },
    db::{self, PreferenceMutation, PreferenceTransactionRequest},
    runtime::updater::{
        cache::VerifiedCacheStore,
        draft_source::{staged_installer_downloader, DraftCandidateConfig, DraftCandidateSource},
        github_source::GitHubReleaseSource,
        install_attempt::{InstallAttemptRecovery, InstallAttemptStore, ReconciliationDisposition},
        nsis_install::{CurrentUserNsisSpawnPort, LocalRelaunchArguments, NsisInstallerSpawnPort},
        policy::{NativeUpdatePolicyStore, UpdatePolicyStore},
        quiescence::{
            NativeWebQuiescenceStore, PlaybackExitCheckpointV1, PrepareWebQuiescenceRequest,
            RollbackAcknowledgement, RollbackWebQuiescenceRequest, WebQuiescenceIdentity,
            WebQuiescenceReconciliation,
        },
        startup_reconciliation::{
            InstallAttemptStartupRecovery, NativeInstallAttemptRejectionPolicy,
            VerifiedCacheInstallAttemptPort, VerifiedCacheInstallAttemptQuarantinePort,
        },
        web_quiescence_handshake::{
            PreparedWebAcknowledgement, WebPlaybackQuiescencePort, WebQuiescenceHandshake,
            WebQuiescencePortFailure,
        },
        UpdateDispatchRequest, UpdateIntent, UpdatePhase, UpdateReceipt, UpdateRuntime,
        UpdateSnapshot, UpdateSnapshotSink,
    },
};

const SMOKE_PREFERENCE_KEY: &str = "settings.fabAutoHide";
const SMOKE_PREFERENCE_VALUE: bool = true;
const SMOKE_HISTORY_KEY: &str = "updater-smoke:database-sentinel";
const SMOKE_HISTORY_NAME: &str = "Draft N-1 to N";
const SMOKE_HISTORY_ARTIST: &str = "MineRadio updater smoke";
const FORBIDDEN_SMOKE_ENVIRONMENT: &[&str] = &[
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_RUNTIME_URL",
    "ACTIONS_CACHE_URL",
    "ACTIONS_RESULTS_URL",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "GITHUB_ENV",
    "GITHUB_OUTPUT",
    "GITHUB_PATH",
    "GITHUB_STATE",
    "GITHUB_STEP_SUMMARY",
];

#[derive(Default)]
struct SmokeSnapshotSink;

impl UpdateSnapshotSink for SmokeSnapshotSink {
    fn publish(&self, _snapshot: UpdateSnapshot) {}
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DraftDownloadEvidence {
    candidate_id: String,
    version: String,
    phase: UpdatePhase,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DraftInstallEvidence {
    candidate_id: String,
    version: String,
    phase: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SeedStateEvidence {
    migration_version: i64,
    startup_count: i64,
    database_sentinel: String,
    preference_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyStateEvidence {
    migration_version: i64,
    startup_count: i64,
    candidate_id: String,
    target_version: String,
    database_preserved: bool,
    typed_preference_preserved: bool,
    checkpoint_consumed: bool,
    updater_cache_clean: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessBoundaryEvidence {
    github_token_absent: bool,
    gh_token_absent: bool,
    ci_credentials_absent: bool,
    process_elevated: bool,
}

#[derive(Clone, Default)]
struct SmokeWebPlaybackPort;

impl SmokeWebPlaybackPort {
    fn checkpoint(
        operation_id: &str,
    ) -> Result<PlaybackExitCheckpointV1, WebQuiescencePortFailure> {
        let mut checkpoint: PlaybackExitCheckpointV1 = serde_json::from_str(include_str!(
            "runtime/updater/fixtures/playback-exit-checkpoint-v1.json"
        ))
        .map_err(|_| WebQuiescencePortFailure::Failed)?;
        checkpoint.operation_id = operation_id.to_owned();
        Ok(checkpoint)
    }
}

impl WebPlaybackQuiescencePort for SmokeWebPlaybackPort {
    fn stage_checkpoint<'a>(
        &'a self,
        request: &'a PrepareWebQuiescenceRequest,
        _timeout: Duration,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<PlaybackExitCheckpointV1, WebQuiescencePortFailure>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { Self::checkpoint(&request.identity.operation_id) })
    }

    fn confirm_checkpoint_persisted<'a>(
        &'a self,
        identity: &'a WebQuiescenceIdentity,
        evidence: &'a crate::runtime::updater::quiescence::CheckpointEvidence,
        _timeout: Duration,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<PreparedWebAcknowledgement, WebQuiescencePortFailure>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(PreparedWebAcknowledgement {
                identity: identity.clone(),
                evidence: evidence.clone(),
            })
        })
    }

    fn seal_for_exit<'a>(
        &'a self,
        identity: &'a WebQuiescenceIdentity,
        evidence: &'a crate::runtime::updater::quiescence::CheckpointEvidence,
        _timeout: Duration,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<PreparedWebAcknowledgement, WebQuiescencePortFailure>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(PreparedWebAcknowledgement {
                identity: identity.clone(),
                evidence: evidence.clone(),
            })
        })
    }

    fn rollback<'a>(
        &'a self,
        request: &'a RollbackWebQuiescenceRequest,
        _timeout: Duration,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<RollbackAcknowledgement, WebQuiescencePortFailure>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(match request.checkpoint.as_ref() {
                Some(checkpoint) => RollbackAcknowledgement::Restored(checkpoint.evidence.clone()),
                None => RollbackAcknowledgement::NoOpNotPrepared,
            })
        })
    }
}

#[derive(Default)]
struct SmokeNativeInstallOwners;

impl SmokeNativeInstallOwners {
    fn receipt(
        operation: &UpdateInstallGateClaim,
        stage: NativeInstallStage,
    ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
        Ok(NativeOwnerReceipt::exact(
            operation,
            stage,
            format!("smoke-{stage:?}-receipt"),
        ))
    }
}

impl NativeInstallOwnerPort for SmokeNativeInstallOwners {
    fn acquire_transition(
        &self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
        Self::receipt(operation, NativeInstallStage::Transition)
    }

    fn disable_full_desktop_without_persisting_preference(
        &self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
        Self::receipt(operation, NativeInstallStage::FullDesktop)
    }

    fn capture_and_stop_wallpaper(
        &self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
        Self::receipt(operation, NativeInstallStage::Wallpaper)
    }

    fn stop_and_join_desktop_lyrics_worker(
        &self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
        Self::receipt(operation, NativeInstallStage::DesktopLyrics)
    }

    fn verify_prepared(
        &self,
        _operation: &UpdateInstallGateClaim,
        receipts: &[NativeOwnerReceipt],
    ) -> Result<(), NativeOwnerError> {
        let expected = [
            NativeInstallStage::Transition,
            NativeInstallStage::FullDesktop,
            NativeInstallStage::Wallpaper,
            NativeInstallStage::DesktopLyrics,
        ];
        (receipts.iter().map(NativeOwnerReceipt::stage).eq(expected))
            .then_some(())
            .ok_or_else(|| NativeOwnerError::new("UPDATE_SMOKE_NATIVE_ORDER_REJECTED"))
    }

    fn rollback_owner(
        &self,
        _operation: &UpdateInstallGateClaim,
        _receipt: &NativeOwnerReceipt,
    ) -> Result<(), NativeOwnerError> {
        Ok(())
    }

    fn verify_rollback(&self, _operation: &UpdateInstallGateClaim) -> Result<(), NativeOwnerError> {
        Ok(())
    }
}

#[derive(Default)]
struct SmokeInstallExitState {
    prepared: Mutex<Option<(String, u64)>>,
    committed: Arc<AtomicBool>,
}

struct SmokeInfallibleExitCapability {
    committed: Arc<AtomicBool>,
}

impl InfallibleInstallExitCapability for SmokeInfallibleExitCapability {
    fn exit_after_installer_spawn(self: Box<Self>) {
        // harness 必须先输出 bounded evidence 再自然退出；真实 NSIS 已由生产 Adapter 启动。
        self.committed.store(true, Ordering::Release);
    }
}

impl InstallExitOwnershipPort for SmokeInstallExitState {
    fn prepare_update_exit(
        &self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<InstallExitOwnershipReceipt, InstallExitOwnershipError> {
        let mut prepared = self
            .prepared
            .lock()
            .map_err(|_| InstallExitOwnershipError::new("UPDATE_SMOKE_EXIT_LOCK_FAILED"))?;
        if prepared.is_some() {
            return Err(InstallExitOwnershipError::new(
                "UPDATE_SMOKE_EXIT_ALREADY_PREPARED",
            ));
        }
        *prepared = Some((operation.operation_id().to_owned(), operation.generation()));
        Ok(InstallExitOwnershipReceipt::exact(
            operation,
            "smoke-install-exit-receipt",
        ))
    }

    fn seal_update_exit(
        &self,
        operation: &UpdateInstallGateClaim,
        _receipt: &InstallExitOwnershipReceipt,
    ) -> Result<Box<dyn InfallibleInstallExitCapability>, InstallExitOwnershipError> {
        let prepared = self
            .prepared
            .lock()
            .map_err(|_| InstallExitOwnershipError::new("UPDATE_SMOKE_EXIT_LOCK_FAILED"))?;
        if prepared.as_ref() != Some(&(operation.operation_id().to_owned(), operation.generation()))
        {
            return Err(InstallExitOwnershipError::new(
                "UPDATE_SMOKE_EXIT_IDENTITY_REJECTED",
            ));
        }
        Ok(Box::new(SmokeInfallibleExitCapability {
            committed: Arc::clone(&self.committed),
        }))
    }

    fn release_update_exit(
        &self,
        operation: &UpdateInstallGateClaim,
        _receipt: &InstallExitOwnershipReceipt,
    ) -> Result<(), InstallExitOwnershipError> {
        let mut prepared = self
            .prepared
            .lock()
            .map_err(|_| InstallExitOwnershipError::new("UPDATE_SMOKE_EXIT_LOCK_FAILED"))?;
        if prepared.as_ref() != Some(&(operation.operation_id().to_owned(), operation.generation()))
        {
            return Err(InstallExitOwnershipError::new(
                "UPDATE_SMOKE_EXIT_IDENTITY_REJECTED",
            ));
        }
        *prepared = None;
        Ok(())
    }

    fn retain_recovery_required(&self, _evidence: InstallExitRecoveryEvidence) {}
}

fn strict_absolute<'a>(path: &'a OsString, label: &str) -> Result<&'a Path, String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(format!("{label} 必须是绝对路径"));
    }
    Ok(path)
}

#[cfg(windows)]
fn current_process_is_elevated() -> Result<bool, String> {
    use std::{mem::size_of, ptr::null_mut};

    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    let mut token: HANDLE = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0
        || token.is_null()
    {
        return Err("无法读取 smoke 进程 token".into());
    }
    let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut returned = 0_u32;
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    };
    unsafe {
        CloseHandle(token);
    }
    if ok == 0 {
        return Err("无法确认 smoke 进程 elevation".into());
    }
    Ok(elevation.TokenIsElevated != 0)
}

#[cfg(not(windows))]
fn current_process_is_elevated() -> Result<bool, String> {
    Err("N-1 到 N 安装 smoke 只允许在 Windows 运行".into())
}

fn process_boundary() -> Result<ProcessBoundaryEvidence, String> {
    let github_token_absent = std::env::var_os("GITHUB_TOKEN").is_none();
    let gh_token_absent = std::env::var_os("GH_TOKEN").is_none();
    let ci_credentials_absent = FORBIDDEN_SMOKE_ENVIRONMENT
        .iter()
        .all(|name| std::env::var_os(name).is_none());
    if !ci_credentials_absent {
        return Err("smoke harness 不得继承 GitHub token 或 runner capability".into());
    }
    let process_elevated = current_process_is_elevated()?;
    if process_elevated {
        return Err("安装 smoke 必须在非提权标准用户 token 下运行".into());
    }
    Ok(ProcessBoundaryEvidence {
        github_token_absent,
        gh_token_absent,
        ci_credentials_absent,
        process_elevated,
    })
}

fn print_json(value: &impl Serialize, label: &str) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string(value).map_err(|_| format!("无法序列化 {label}"))?
    );
    Ok(())
}

fn seed_state(app_data_directory: &Path) -> Result<SeedStateEvidence, String> {
    let database = db::initialize(app_data_directory).map_err(|error| error.to_string())?;
    db::commit_preferences_transaction(
        &database.conn,
        PreferenceTransactionRequest {
            operations: vec![PreferenceMutation::Set {
                key: SMOKE_PREFERENCE_KEY.to_owned(),
                schema_version: 1,
                value: serde_json::json!(SMOKE_PREFERENCE_VALUE),
            }],
        },
    )
    .map_err(|error| error.to_string())?;
    db::add_listen_history(
        &database.conn,
        SMOKE_HISTORY_KEY,
        SMOKE_HISTORY_NAME,
        SMOKE_HISTORY_ARTIST,
        None,
        Some("updater-smoke"),
        42_000,
        true,
    )
    .map_err(|error| error.to_string())?;
    let status = db::build_database_status(&database.conn, &database.path)
        .map_err(|error| error.to_string())?;
    Ok(SeedStateEvidence {
        migration_version: status.migration_version,
        startup_count: status.startup_count,
        database_sentinel: SMOKE_HISTORY_KEY.to_owned(),
        preference_key: SMOKE_PREFERENCE_KEY.to_owned(),
    })
}

fn open_database_read_only(
    app_data_directory: &Path,
) -> Result<(Connection, std::path::PathBuf), String> {
    let path = app_data_directory.join("mineradio.db");
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    Ok((connection, path))
}

fn now_millis() -> Result<u64, String> {
    let value = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时间早于 Unix epoch".to_owned())?
        .as_millis();
    u64::try_from(value)
        .ok()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| "系统时间超出 JavaScript 安全整数范围".to_owned())
}

fn verify_state(
    app_data_directory: &Path,
    expected_candidate_id: &str,
    expected_target_version: &str,
    baseline_startup_count: i64,
) -> Result<VerifyStateEvidence, String> {
    let (connection, database_path) = open_database_read_only(app_data_directory)?;
    let status = db::build_database_status(&connection, &database_path)
        .map_err(|error| error.to_string())?;
    if status.migration_version < 3 || status.startup_count <= baseline_startup_count {
        return Err("数据库未被候选版本跨升级保留并重新打开".into());
    }
    let history_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM listen_history \
             WHERE song_key = ?1 AND name = ?2 AND artist = ?3 \
               AND source = 'updater-smoke' AND listen_ms = 42000 AND completed = 1",
            [SMOKE_HISTORY_KEY, SMOKE_HISTORY_NAME, SMOKE_HISTORY_ARTIST],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if history_count != 1 {
        return Err("数据库 sentinel 未跨升级保留".into());
    }
    let preferences =
        db::get_preferences_snapshot(&connection).map_err(|error| error.to_string())?;
    let expected = serde_json::json!(SMOKE_PREFERENCE_VALUE);
    if preferences
        .values
        .get(SMOKE_PREFERENCE_KEY)
        .map(|value| (&value.schema_version, &value.value))
        != Some((&1, &expected))
    {
        return Err("typed preference 未跨升级保留".into());
    }

    let updater = app_data_directory.join("updater");
    for forbidden in [
        "cache-v1",
        "install-attempt-v1.json",
        "playback-exit-checkpoint-v1.json",
        "web-quiescence-v1.json",
    ] {
        if updater.join(forbidden).exists() {
            return Err(format!("升级后仍残留 updater authority: {forbidden}"));
        }
    }
    let recovered_identity = match NativeWebQuiescenceStore::for_app_data(app_data_directory)
        .reconcile_startup(false, now_millis()?)
        .map_err(|error| error.to_string())?
    {
        WebQuiescenceReconciliation::CompletedRecovered(identity) => identity,
        _ => return Err("升级后缺少有效的 playback checkpoint completion".into()),
    };
    if recovered_identity.candidate_id != expected_candidate_id {
        return Err("playback checkpoint completion 与候选 identity 不一致".into());
    }

    let reconciliation = match InstallAttemptStore::for_app_data(app_data_directory)
        .recover()
        .map_err(|error| error.to_string())?
    {
        InstallAttemptRecovery::ConsumedReceipt(reconciliation) => reconciliation,
        _ => return Err("升级后缺少已消费的 install-attempt receipt".into()),
    };
    if reconciliation.disposition() != ReconciliationDisposition::Applied
        || reconciliation.attempt().candidate_id() != expected_candidate_id
        || reconciliation.attempt().target_version() != expected_target_version
    {
        return Err("install-attempt receipt 与候选版本不一致".into());
    }

    Ok(VerifyStateEvidence {
        migration_version: status.migration_version,
        startup_count: status.startup_count,
        candidate_id: expected_candidate_id.to_owned(),
        target_version: expected_target_version.to_owned(),
        database_preserved: true,
        typed_preference_preserved: true,
        checkpoint_consumed: true,
        updater_cache_clean: true,
    })
}

fn tauri_public_key(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|_| "无法读取 Tauri 配置".to_owned())?;
    let config: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Tauri 配置不是有效 JSON".to_owned())?;
    config
        .pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "Tauri 配置缺少 updater 公钥".to_owned())
}

fn verify_draft_download(
    staging_directory: &Path,
    updater_directory: &Path,
    tauri_config: &Path,
    tag: String,
    commit_sha: String,
    current_version: String,
) -> Result<DraftDownloadEvidence, String> {
    let config = DraftCandidateConfig::new(staging_directory, tag, commit_sha)
        .map_err(|error| error.message)?;
    let public_key = tauri_public_key(tauri_config)?;
    let source =
        Arc::new(DraftCandidateSource::new(&config, &public_key).map_err(|error| error.message)?);
    let downloader = Arc::new(
        staged_installer_downloader(&config, updater_directory).map_err(|error| error.message)?,
    );
    let runtime = UpdateRuntime::with_downloader(
        current_version,
        source,
        Arc::new(SmokeSnapshotSink),
        downloader,
    );
    if runtime.dispatch(UpdateDispatchRequest {
        expected_revision: 0,
        intent: UpdateIntent::CheckNow,
    }) != UpdateReceipt::Accepted
        || !tauri::async_runtime::block_on(runtime.run_pending_check())
    {
        return Err("Draft candidate check 未被 Runtime 接受".into());
    }
    let available = runtime.snapshot();
    if available.phase != UpdatePhase::Available {
        return Err("Draft candidate 未进入 available".into());
    }
    let candidate = available
        .candidate
        .ok_or_else(|| "Draft Runtime 缺少候选".to_owned())?;
    if runtime.dispatch(UpdateDispatchRequest {
        expected_revision: available.revision,
        intent: UpdateIntent::Download {
            candidate_id: candidate.id.clone(),
        },
    }) != UpdateReceipt::Accepted
        || !tauri::async_runtime::block_on(runtime.run_pending_download())
    {
        return Err("Draft candidate 下载未被 Runtime 接受".into());
    }
    let ready = runtime.snapshot();
    if ready.phase != UpdatePhase::ReadyToInstall || ready.fault.is_some() {
        return Err("Draft candidate 未通过 Downloader/Verifier/cache".into());
    }
    Ok(DraftDownloadEvidence {
        candidate_id: candidate.id,
        version: candidate.version,
        phase: ready.phase,
    })
}

fn install_draft(
    staging_directory: &Path,
    app_data_directory: &Path,
    tauri_config: &Path,
    tag: String,
    commit_sha: String,
    current_version: String,
) -> Result<DraftInstallEvidence, String> {
    // 安装命令必须独立重验进程边界，不能依赖同一 workflow 中更早的检查结果。
    process_boundary()?;
    install_draft_with_spawn_port(
        staging_directory,
        app_data_directory,
        tauri_config,
        tag,
        commit_sha,
        current_version,
        Arc::new(CurrentUserNsisSpawnPort),
    )
}

#[allow(clippy::too_many_arguments)]
fn install_draft_with_spawn_port(
    staging_directory: &Path,
    app_data_directory: &Path,
    tauri_config: &Path,
    tag: String,
    commit_sha: String,
    current_version: String,
    installer_spawn: Arc<dyn NsisInstallerSpawnPort>,
) -> Result<DraftInstallEvidence, String> {
    let config = DraftCandidateConfig::new(staging_directory, tag, commit_sha)
        .map_err(|error| error.message)?;
    let public_key = tauri_public_key(tauri_config)?;
    let updater_directory = app_data_directory.join("updater");
    let source =
        Arc::new(DraftCandidateSource::new(&config, &public_key).map_err(|error| error.message)?);
    let downloader = Arc::new(
        staged_installer_downloader(&config, &updater_directory).map_err(|error| error.message)?,
    );
    let policy_store = Arc::new(NativeUpdatePolicyStore::for_app_data(app_data_directory));
    let attempts = Arc::new(InstallAttemptStore::for_app_data(app_data_directory));
    let web_handshake = Arc::new(WebQuiescenceHandshake::new(
        NativeWebQuiescenceStore::for_app_data(app_data_directory),
        SmokeWebPlaybackPort,
        Duration::from_secs(5),
    ));
    let rejection_policy = Arc::new(NativeInstallAttemptRejectionPolicy::new(Arc::clone(
        &policy_store,
    )));
    let startup_recovery = Arc::new(InstallAttemptStartupRecovery::new(
        Arc::clone(&attempts),
        Arc::new(VerifiedCacheInstallAttemptPort::new(
            VerifiedCacheStore::new(&updater_directory, &public_key)
                .map_err(|error| error.code.to_owned())?,
        )),
        web_handshake.clone(),
        Arc::new(VerifiedCacheInstallAttemptQuarantinePort::new(
            &updater_directory,
            rejection_policy,
        )),
    ));
    let exit_state = Arc::new(SmokeInstallExitState::default());
    let coordinator = Arc::new(UpdateInstallCoordinator::new(
        web_handshake,
        NativeInstallQuiescence::new(
            UpdateInstallGate::default(),
            Arc::new(SmokeNativeInstallOwners),
        ),
        Arc::new(
            VerifiedCacheStore::new(&updater_directory, &public_key)
                .map_err(|error| error.code.to_owned())?,
        ),
        attempts,
        exit_state.clone(),
        installer_spawn,
        LocalRelaunchArguments::none_for_smoke(),
        Duration::from_secs(5),
    ));
    let runtime = UpdateRuntime::with_production_dependencies(
        current_version,
        source,
        Arc::new(SmokeSnapshotSink),
        downloader,
        startup_recovery,
        policy_store as Arc<dyn UpdatePolicyStore>,
        Arc::new(RuntimeUpdateInstallerAdapter::new(Arc::clone(&coordinator))),
    )
    .map_err(|error| error.code().to_owned())?;

    if !tauri::async_runtime::block_on(runtime.run_pending_cache_recovery()) {
        return Err("Draft cache recovery 未执行".into());
    }
    let idle = runtime.snapshot();
    if idle.phase != UpdatePhase::Idle || idle.fault.is_some() {
        return Err("Draft cache recovery 未进入 idle".into());
    }
    if runtime.dispatch(UpdateDispatchRequest {
        expected_revision: idle.revision,
        intent: UpdateIntent::CheckNow,
    }) != UpdateReceipt::Accepted
        || !tauri::async_runtime::block_on(runtime.run_pending_check())
    {
        return Err("Draft candidate check 未被生产 Runtime 接受".into());
    }
    let available = runtime.snapshot();
    let candidate = available
        .candidate
        .clone()
        .ok_or_else(|| "Draft Runtime 缺少候选".to_owned())?;
    if available.phase != UpdatePhase::Available || available.fault.is_some() {
        return Err("Draft candidate 未进入 available".into());
    }
    if runtime.dispatch(UpdateDispatchRequest {
        expected_revision: available.revision,
        intent: UpdateIntent::Download {
            candidate_id: candidate.id.clone(),
        },
    }) != UpdateReceipt::Accepted
        || !tauri::async_runtime::block_on(runtime.run_pending_download())
    {
        return Err("Draft candidate 下载未被生产 Runtime 接受".into());
    }
    let ready = runtime.snapshot();
    if ready.phase != UpdatePhase::ReadyToInstall || ready.fault.is_some() {
        return Err("Draft candidate 未通过生产 Downloader/Verifier/cache".into());
    }
    if runtime.dispatch(UpdateDispatchRequest {
        expected_revision: ready.revision,
        intent: UpdateIntent::InstallAndRestart {
            candidate_id: candidate.id.clone(),
        },
    }) != UpdateReceipt::Accepted
        || !tauri::async_runtime::block_on(runtime.run_pending_install_transaction())
    {
        return Err("Draft candidate 安装未被生产 Runtime 接受".into());
    }
    let installing = runtime.snapshot();
    if installing.phase != UpdatePhase::Installing
        || installing.fault.is_some()
        || coordinator.phase() != UpdateInstallCoordinatorPhase::InstallerSpawned
        || !exit_state.committed.load(Ordering::Acquire)
    {
        return Err("Draft 安装事务未完成 installer-spawned 交接".into());
    }

    Ok(DraftInstallEvidence {
        candidate_id: candidate.id,
        version: candidate.version,
        phase: "installer-spawned",
    })
}

fn probe_public(
    tauri_config: &Path,
    current_version: String,
    expected_version: String,
    expected_candidate_id: String,
) -> Result<(), String> {
    let public_key = tauri_public_key(tauri_config)?;
    let source = Arc::new(GitHubReleaseSource::new(&public_key).map_err(|error| error.message)?);
    let runtime = UpdateRuntime::new(current_version, source, Arc::new(SmokeSnapshotSink));
    if runtime.dispatch(UpdateDispatchRequest {
        expected_revision: 0,
        intent: UpdateIntent::CheckNow,
    }) != UpdateReceipt::Accepted
        || !tauri::async_runtime::block_on(runtime.run_pending_check())
    {
        return Err("公开 discovery probe 未执行".into());
    }
    let snapshot = runtime.snapshot();
    let candidate = snapshot
        .candidate
        .ok_or_else(|| "公开 /latest 未返回预期候选".to_owned())?;
    if snapshot.phase != UpdatePhase::Available
        || candidate.version != expected_version
        || candidate.id != expected_candidate_id
        || snapshot.fault.is_some()
    {
        return Err("公开 /latest 候选 identity 与 Draft smoke 不一致".into());
    }
    Ok(())
}

fn next(arguments: &mut impl Iterator<Item = OsString>, label: &str) -> Result<OsString, String> {
    arguments.next().ok_or_else(|| format!("缺少参数: {label}"))
}

pub fn run_cli(arguments: impl IntoIterator<Item = OsString>) -> Result<(), String> {
    let mut arguments = arguments.into_iter();
    let command = next(&mut arguments, "command")?;
    match command.to_str() {
        Some("seed-state") => {
            let app_data = next(&mut arguments, "app-data")?;
            if arguments.next().is_some() {
                return Err("seed-state 参数过多".into());
            }
            let evidence = seed_state(strict_absolute(&app_data, "app-data")?)?;
            print_json(&evidence, "seed-state evidence")
        }
        Some("verify-state") => {
            let app_data = next(&mut arguments, "app-data")?;
            let candidate_id = next(&mut arguments, "candidate-id")?;
            let target_version = next(&mut arguments, "target-version")?;
            let baseline_startup_count = next(&mut arguments, "baseline-startup-count")?;
            if arguments.next().is_some() {
                return Err("verify-state 参数过多".into());
            }
            let baseline_startup_count = baseline_startup_count
                .to_str()
                .ok_or_else(|| "baseline-startup-count 不是 UTF-8".to_owned())?
                .parse::<i64>()
                .map_err(|_| "baseline-startup-count 必须是整数".to_owned())?;
            let evidence = verify_state(
                strict_absolute(&app_data, "app-data")?,
                &candidate_id.to_string_lossy(),
                &target_version.to_string_lossy(),
                baseline_startup_count,
            )?;
            print_json(&evidence, "verify-state evidence")
        }
        Some("verify-process-boundary") => {
            if arguments.next().is_some() {
                return Err("verify-process-boundary 参数过多".into());
            }
            print_json(&process_boundary()?, "process-boundary evidence")
        }
        Some("verify-draft-download") => {
            let staging = next(&mut arguments, "staging")?;
            let updater = next(&mut arguments, "updater")?;
            let tauri_config = next(&mut arguments, "tauri-config")?;
            let tag = next(&mut arguments, "tag")?;
            let commit = next(&mut arguments, "commit")?;
            let current = next(&mut arguments, "current-version")?;
            if arguments.next().is_some() {
                return Err("verify-draft-download 参数过多".into());
            }
            let evidence = verify_draft_download(
                strict_absolute(&staging, "staging")?,
                strict_absolute(&updater, "updater")?,
                strict_absolute(&tauri_config, "tauri-config")?,
                tag.to_string_lossy().into_owned(),
                commit.to_string_lossy().into_owned(),
                current.to_string_lossy().into_owned(),
            )?;
            print_json(&evidence, "Draft smoke evidence")
        }
        Some("install-draft") => {
            let staging = next(&mut arguments, "staging")?;
            let app_data = next(&mut arguments, "app-data")?;
            let tauri_config = next(&mut arguments, "tauri-config")?;
            let tag = next(&mut arguments, "tag")?;
            let commit = next(&mut arguments, "commit")?;
            let current = next(&mut arguments, "current-version")?;
            if arguments.next().is_some() {
                return Err("install-draft 参数过多".into());
            }
            let evidence = install_draft(
                strict_absolute(&staging, "staging")?,
                strict_absolute(&app_data, "app-data")?,
                strict_absolute(&tauri_config, "tauri-config")?,
                tag.to_string_lossy().into_owned(),
                commit.to_string_lossy().into_owned(),
                current.to_string_lossy().into_owned(),
            )?;
            print_json(&evidence, "Draft install evidence")
        }
        Some("probe-public") => {
            let tauri_config = next(&mut arguments, "tauri-config")?;
            let current = next(&mut arguments, "current-version")?;
            let expected_version = next(&mut arguments, "expected-version")?;
            let expected_candidate = next(&mut arguments, "expected-candidate-id")?;
            if arguments.next().is_some() {
                return Err("probe-public 参数过多".into());
            }
            probe_public(
                strict_absolute(&tauri_config, "tauri-config")?,
                current.to_string_lossy().into_owned(),
                expected_version.to_string_lossy().into_owned(),
                expected_candidate.to_string_lossy().into_owned(),
            )
        }
        _ => Err(
            "用法: updater-smoke <seed-state|verify-state|verify-process-boundary|verify-draft-download|install-draft|probe-public> ..."
                .into(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        ffi::{OsStr, OsString},
        fs,
        path::PathBuf,
        sync::{Arc, Mutex},
        time::SystemTime,
    };

    use serde::Deserialize;

    use super::*;
    use crate::runtime::updater::{
        install_attempt::InstallAttemptInput,
        nsis_install::{NsisSpawnPortError, NsisSpawnRequest},
        quiescence::PlaybackExitCheckpointV1,
    };

    const RAW_PROVENANCE: &[u8] = include_bytes!("runtime/updater/fixtures/provenance-v2.json");
    const CONTRACT_JSON: &str =
        include_str!("runtime/updater/fixtures/provenance-v2-contract.json");
    const TAG: &str = "v1.2.3";
    const COMMIT_SHA: &str = "0123456789abcdef0123456789abcdef01234567";
    const INSTALLER_NAME: &str = "MineRadio-Tauri_1.2.3_x64-setup.exe";

    #[derive(Deserialize)]
    struct ContractFixture {
        encoded_public_key: String,
        provenance_signature: String,
        installer_signature: String,
        expected_candidate_id: String,
        github_locator: String,
    }

    #[derive(Default)]
    struct RecordingNsisSpawnPort {
        requests: Mutex<Vec<(PathBuf, OsString)>>,
    }

    impl NsisInstallerSpawnPort for RecordingNsisSpawnPort {
        fn spawn(&self, request: NsisSpawnRequest<'_>) -> Result<(), NsisSpawnPortError> {
            self.requests.lock().unwrap().push((
                request.installer_path().to_path_buf(),
                request.raw_parameters().to_os_string(),
            ));
            Ok(())
        }
    }

    #[test]
    fn cli_contract_exposes_the_real_install_draft_path() {
        let error = run_cli([OsString::from("unknown")]).expect_err("未知命令必须失败");
        assert!(error.contains("install-draft"));
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "mineradio-updater-smoke-state-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_draft_staging(root: &Path, contract: &ContractFixture) {
        let manifest = serde_json::json!({
            "version": "1.2.3",
            "notes": "修复播放链路",
            "pub_date": "2026-07-31T00:00:00Z",
            "platforms": {
                "windows-x86_64-nsis": {
                    "signature": contract.installer_signature,
                    "url": contract.github_locator,
                },
                "windows-x86_64": {
                    "signature": contract.installer_signature,
                    "url": contract.github_locator,
                }
            }
        });
        fs::write(
            root.join("latest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(
            root.join(format!("{INSTALLER_NAME}.sig")),
            &contract.installer_signature,
        )
        .unwrap();
        fs::write(root.join("release-provenance.json"), RAW_PROVENANCE).unwrap();
        fs::write(
            root.join("release-provenance.json.sig"),
            &contract.provenance_signature,
        )
        .unwrap();
        fs::write(root.join(INSTALLER_NAME), b"installer").unwrap();
    }

    #[test]
    #[cfg(all(windows, target_arch = "x86_64"))]
    fn draft_install_uses_the_production_runtime_and_fixed_nsis_spawn_plan() {
        let root = TestDirectory::new();
        let staging = root.0.join("staging");
        let app_data = root.0.join("app-data");
        fs::create_dir(&staging).unwrap();
        fs::create_dir(&app_data).unwrap();
        let contract: ContractFixture = serde_json::from_str(CONTRACT_JSON).unwrap();
        write_draft_staging(&staging, &contract);
        let tauri_config = root.0.join("tauri.conf.json");
        fs::write(
            &tauri_config,
            serde_json::to_vec(&serde_json::json!({
                "plugins": { "updater": { "pubkey": contract.encoded_public_key } }
            }))
            .unwrap(),
        )
        .unwrap();
        let spawn = Arc::new(RecordingNsisSpawnPort::default());

        let evidence = install_draft_with_spawn_port(
            &staging,
            &app_data,
            &tauri_config,
            TAG.into(),
            COMMIT_SHA.into(),
            "1.2.2".into(),
            spawn.clone(),
        )
        .unwrap();

        assert_eq!(evidence.version, "1.2.3");
        assert_eq!(evidence.candidate_id, contract.expected_candidate_id);
        assert_eq!(evidence.phase, "installer-spawned");
        let requests = spawn.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0.file_name(), Some(OsStr::new("installer.exe")));
        assert_eq!(requests[0].1, OsStr::new("/P /R /UPDATE /ARGS"));
        assert!(app_data.join("updater/install-attempt-v1.json").is_file());
        assert!(app_data
            .join("updater/playback-exit-checkpoint-v1.json")
            .is_file());
    }

    #[test]
    #[cfg(all(windows, target_arch = "x86_64"))]
    fn tampered_draft_installer_never_reaches_the_nsis_spawn_port() {
        let root = TestDirectory::new();
        let staging = root.0.join("staging");
        let app_data = root.0.join("app-data");
        fs::create_dir(&staging).unwrap();
        fs::create_dir(&app_data).unwrap();
        let contract: ContractFixture = serde_json::from_str(CONTRACT_JSON).unwrap();
        write_draft_staging(&staging, &contract);
        fs::write(staging.join(INSTALLER_NAME), b"tampered").unwrap();
        let tauri_config = root.0.join("tauri.conf.json");
        fs::write(
            &tauri_config,
            serde_json::to_vec(&serde_json::json!({
                "plugins": { "updater": { "pubkey": contract.encoded_public_key } }
            }))
            .unwrap(),
        )
        .unwrap();
        let spawn = Arc::new(RecordingNsisSpawnPort::default());

        let error = install_draft_with_spawn_port(
            &staging,
            &app_data,
            &tauri_config,
            TAG.into(),
            COMMIT_SHA.into(),
            "1.2.2".into(),
            spawn.clone(),
        )
        .expect_err("被篡改的安装器必须 fail closed");

        assert!(error.contains("Downloader/Verifier/cache"));
        assert!(spawn.requests.lock().unwrap().is_empty());
        assert!(!app_data.join("updater/install-attempt-v1.json").exists());
    }

    #[test]
    fn seed_state_writes_real_database_and_typed_preference() {
        let root = TestDirectory::new();

        let seed = seed_state(&root.0).unwrap();
        let database = db::initialize(&root.0).unwrap();
        let snapshot = db::get_preferences_snapshot(&database.conn).unwrap();

        assert!(database.path.is_file());
        assert_eq!(seed.startup_count, 1);
        assert_eq!(
            snapshot.values.get(SMOKE_PREFERENCE_KEY).unwrap().value,
            serde_json::json!(SMOKE_PREFERENCE_VALUE)
        );
        let history_count: i64 = database
            .conn
            .query_row(
                "SELECT COUNT(*) FROM listen_history WHERE song_key = ?1",
                [SMOKE_HISTORY_KEY],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(history_count, 1);
    }

    #[test]
    fn post_upgrade_validation_requires_consumed_checkpoint_and_clean_cache() {
        let root = TestDirectory::new();
        let seed = seed_state(&root.0).unwrap();
        let candidate_id = "a".repeat(64);
        let store = NativeWebQuiescenceStore::for_app_data(&root.0);
        let request = store.begin_prepare(&candidate_id, 1).unwrap();
        let mut checkpoint: PlaybackExitCheckpointV1 = serde_json::from_str(include_str!(
            "runtime/updater/fixtures/playback-exit-checkpoint-v1.json"
        ))
        .unwrap();
        checkpoint.operation_id = request.identity.operation_id.clone();
        let evidence = store
            .persist_checkpoint(&request.identity, &checkpoint)
            .unwrap();
        store
            .acknowledge_prepared(&request.identity, &evidence, 2)
            .unwrap();

        let attempts = InstallAttemptStore::for_app_data(&root.0);
        let marker = attempts
            .publish(InstallAttemptInput {
                operation_id: request.identity.operation_id.clone(),
                operation_generation: request.identity.operation_generation,
                candidate_id: candidate_id.clone(),
                target_version: "1.2.3".into(),
                provenance_sha256: "b".repeat(64),
                candidate_metadata_digest: "c".repeat(64),
                installer_sha256: "d".repeat(64),
                installer_size: 9,
                checkpoint_receipt: evidence.receipt.clone(),
                checkpoint_digest: evidence.digest.clone(),
                created_at: 2,
            })
            .unwrap();
        attempts
            .complete_reconciliation(&marker, ReconciliationDisposition::Applied, 3)
            .unwrap();
        store
            .consume_applied_install(&request.identity, &evidence, 3)
            .unwrap();
        let reconciliation = match attempts.recover().unwrap() {
            InstallAttemptRecovery::Reconciled(reconciliation) => reconciliation,
            other => panic!("expected reconciled attempt, got {other:?}"),
        };
        attempts.consume_reconciliation(&reconciliation).unwrap();
        db::initialize(&root.0).unwrap();

        let verified = verify_state(&root.0, &candidate_id, "1.2.3", seed.startup_count).unwrap();
        assert_eq!(verified.candidate_id, candidate_id);
        assert!(verified.startup_count > seed.startup_count);

        let updater = root.0.join("updater");
        fs::create_dir(updater.join("cache-v1")).unwrap();
        assert!(verify_state(&root.0, &"a".repeat(64), "1.2.3", seed.startup_count).is_err());
    }
}
