use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use crate::runtime::updater::{
    cache::{CacheRecoveryFault, InstallAttemptArtifactIdentity, VerifiedCacheStore},
    download::{VerifiedInstallerArtifact, VerifiedInstallerIdentity},
    install_attempt::{
        InstallAttemptInput, InstallAttemptMarkerV1, InstallAttemptReconciliationV1,
        InstallAttemptStore,
    },
    nsis_install::{LocalRelaunchArguments, NsisInstallPlan, NsisInstallerSpawnPort},
    quiescence::{WebQuiescenceIdentity, WebQuiescenceReconciliation},
    web_quiescence_handshake::{
        PreparedWebQuiescence, WebPlaybackQuiescencePort, WebQuiescenceHandshake,
    },
    UpdateFaultStage, UpdateInstallFault, UpdateInstallOutcome, UpdateInstaller,
};

use super::{
    update_install_exit::{InstallExitOwnershipPort, InstallExitRecovery, SealedInstallExit},
    update_install_quiescence::{
        NativeInstallLease, NativeInstallQuiescence, NativePrepareFailure,
    },
};

type CoordinatorFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum UpdateInstallCoordinatorStage {
    Authority,
    WebPrepare,
    NativePrepare,
    CacheRevalidation,
    InstallPlan,
    MarkerPublish,
    ExitSeal,
    InstallerSpawn,
    InstallerIdentity,
    MarkerTombstone,
    NativeRollback,
    WebRollback,
    MarkerConsume,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct UpdateInstallCoordinatorFault {
    pub(crate) stage: UpdateInstallCoordinatorStage,
    pub(crate) code: String,
    pub(crate) recovery_required: bool,
}

impl UpdateInstallCoordinatorFault {
    fn new(stage: UpdateInstallCoordinatorStage, code: impl Into<String>) -> Self {
        Self {
            stage,
            code: code.into(),
            recovery_required: false,
        }
    }

    fn recovery(stage: UpdateInstallCoordinatorStage, code: impl Into<String>) -> Self {
        Self {
            stage,
            code: code.into(),
            recovery_required: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum UpdateInstallCoordinatorOutcome {
    InstallerSpawned,
    RecoveryCompleted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RuntimeInstallFaultProjection {
    stage: UpdateFaultStage,
    retryable: bool,
    message: &'static str,
    fallback_code: &'static str,
}

fn project_runtime_install_fault(
    stage: UpdateInstallCoordinatorStage,
) -> RuntimeInstallFaultProjection {
    match stage {
        UpdateInstallCoordinatorStage::Authority => RuntimeInstallFaultProjection {
            stage: UpdateFaultStage::Install,
            retryable: false,
            message: "安装授权已失效，无法继续本次安装",
            fallback_code: "UPDATE_INSTALL_AUTHORITY_FAILED",
        },
        UpdateInstallCoordinatorStage::WebPrepare => RuntimeInstallFaultProjection {
            stage: UpdateFaultStage::Quiesce,
            retryable: true,
            message: "无法安全暂停播放状态",
            fallback_code: "UPDATE_WEB_QUIESCENCE_FAILED",
        },
        UpdateInstallCoordinatorStage::NativePrepare => RuntimeInstallFaultProjection {
            stage: UpdateFaultStage::Quiesce,
            retryable: true,
            message: "无法安全暂停桌面运行时",
            fallback_code: "UPDATE_INSTALL_NATIVE_PREPARE_FAILED",
        },
        UpdateInstallCoordinatorStage::CacheRevalidation => RuntimeInstallFaultProjection {
            stage: UpdateFaultStage::Cache,
            retryable: false,
            message: "已验证安装包复核失败",
            fallback_code: "UPDATE_CACHE_REVALIDATION_FAILED",
        },
        UpdateInstallCoordinatorStage::InstallPlan => RuntimeInstallFaultProjection {
            stage: UpdateFaultStage::Install,
            retryable: false,
            message: "无法生成安全的安装计划",
            fallback_code: "UPDATE_INSTALL_PLAN_FAILED",
        },
        UpdateInstallCoordinatorStage::MarkerPublish => RuntimeInstallFaultProjection {
            stage: UpdateFaultStage::Install,
            retryable: true,
            message: "无法持久化安装事务",
            fallback_code: "UPDATE_INSTALL_MARKER_PUBLISH_FAILED",
        },
        UpdateInstallCoordinatorStage::ExitSeal => RuntimeInstallFaultProjection {
            stage: UpdateFaultStage::Install,
            retryable: true,
            message: "无法封存安装退出事务",
            fallback_code: "UPDATE_INSTALL_EXIT_SEAL_FAILED",
        },
        UpdateInstallCoordinatorStage::InstallerSpawn => RuntimeInstallFaultProjection {
            stage: UpdateFaultStage::Install,
            retryable: true,
            message: "无法启动已验证的更新安装包",
            fallback_code: "UPDATE_INSTALL_SPAWN_FAILED",
        },
        UpdateInstallCoordinatorStage::InstallerIdentity => RuntimeInstallFaultProjection {
            stage: UpdateFaultStage::Install,
            retryable: false,
            message: "安装包身份复核失败",
            fallback_code: "UPDATE_INSTALL_IDENTITY_FAILED",
        },
        UpdateInstallCoordinatorStage::MarkerTombstone => RuntimeInstallFaultProjection {
            stage: UpdateFaultStage::Install,
            retryable: true,
            message: "安装事务标记清理尚未完成",
            fallback_code: "UPDATE_INSTALL_MARKER_TOMBSTONE_FAILED",
        },
        UpdateInstallCoordinatorStage::NativeRollback => RuntimeInstallFaultProjection {
            stage: UpdateFaultStage::Quiesce,
            retryable: true,
            message: "桌面运行时恢复尚未完成",
            fallback_code: "UPDATE_INSTALL_NATIVE_ROLLBACK_FAILED",
        },
        UpdateInstallCoordinatorStage::WebRollback => RuntimeInstallFaultProjection {
            stage: UpdateFaultStage::Quiesce,
            retryable: true,
            message: "播放状态恢复尚未完成",
            fallback_code: "UPDATE_WEB_QUIESCENCE_ROLLBACK_FAILED",
        },
        UpdateInstallCoordinatorStage::MarkerConsume => RuntimeInstallFaultProjection {
            stage: UpdateFaultStage::Install,
            retryable: true,
            message: "安装事务收尾尚未完成",
            fallback_code: "UPDATE_INSTALL_MARKER_CONSUME_FAILED",
        },
    }
}

fn stable_runtime_fault_code(raw: &str, fallback: &'static str) -> String {
    let is_stable_code = raw.len() <= 96
        && raw.starts_with("UPDATE_")
        && raw
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_');
    if is_stable_code {
        raw.to_owned()
    } else {
        fallback.to_owned()
    }
}

fn runtime_install_fault_retryable(
    projection: RuntimeInstallFaultProjection,
    recovery_required: bool,
) -> bool {
    recovery_required || projection.retryable
}

fn map_runtime_install_fault(fault: UpdateInstallCoordinatorFault) -> UpdateInstallFault {
    let projection = project_runtime_install_fault(fault.stage);
    let retryable = runtime_install_fault_retryable(projection, fault.recovery_required);
    let code = stable_runtime_fault_code(&fault.code, projection.fallback_code);
    UpdateInstallFault::new(
        projection.stage,
        code,
        retryable,
        projection.message,
        fault.recovery_required,
    )
}

fn map_runtime_install_outcome(outcome: UpdateInstallCoordinatorOutcome) -> UpdateInstallOutcome {
    match outcome {
        UpdateInstallCoordinatorOutcome::InstallerSpawned => UpdateInstallOutcome::InstallerSpawned,
        UpdateInstallCoordinatorOutcome::RecoveryCompleted => {
            UpdateInstallOutcome::RecoveryCompleted
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum UpdateInstallCoordinatorPhase {
    Idle,
    Preparing,
    RecoveryRequired,
    InstallerSpawned,
}

pub(crate) trait UpdateInstallCoordinatorPort: Send + Sync {
    fn install_exact<'a>(
        &'a self,
        candidate_id: String,
        artifact: VerifiedInstallerArtifact,
        started_at: u64,
    ) -> CoordinatorFuture<'a, Result<UpdateInstallCoordinatorOutcome, UpdateInstallCoordinatorFault>>;

    fn retry_recovery(
        &self,
        updated_at: u64,
    ) -> CoordinatorFuture<'_, Result<UpdateInstallCoordinatorOutcome, UpdateInstallCoordinatorFault>>;

    fn phase(&self) -> UpdateInstallCoordinatorPhase;
}

pub(crate) trait UpdateInstallCachePort: Send + Sync {
    fn inspect_exact<'a>(
        &'a self,
        expected: &'a InstallAttemptArtifactIdentity,
    ) -> CoordinatorFuture<'a, Result<VerifiedInstallerArtifact, CacheRecoveryFault>>;
}

impl UpdateInstallCachePort for VerifiedCacheStore {
    fn inspect_exact<'a>(
        &'a self,
        expected: &'a InstallAttemptArtifactIdentity,
    ) -> CoordinatorFuture<'a, Result<VerifiedInstallerArtifact, CacheRecoveryFault>> {
        Box::pin(async move {
            self.inspect_install_attempt_artifact(expected)
                .await
                .map(|recovered| recovered.artifact)
        })
    }
}

pub(crate) trait UpdateInstallAttemptPort: Send + Sync {
    fn publish(&self, input: InstallAttemptInput) -> Result<InstallAttemptMarkerV1, String>;

    fn tombstone_pre_spawn_abort(
        &self,
        marker: &InstallAttemptMarkerV1,
        aborted_at: u64,
    ) -> Result<InstallAttemptReconciliationV1, String>;

    fn consume(&self, reconciliation: &InstallAttemptReconciliationV1) -> Result<(), String>;
}

impl UpdateInstallAttemptPort for InstallAttemptStore {
    fn publish(&self, input: InstallAttemptInput) -> Result<InstallAttemptMarkerV1, String> {
        InstallAttemptStore::publish(self, input).map_err(|error| error.code().to_owned())
    }

    fn tombstone_pre_spawn_abort(
        &self,
        marker: &InstallAttemptMarkerV1,
        aborted_at: u64,
    ) -> Result<InstallAttemptReconciliationV1, String> {
        InstallAttemptStore::tombstone_pre_spawn_abort(self, marker, aborted_at)
            .map_err(|error| error.code().to_owned())
    }

    fn consume(&self, reconciliation: &InstallAttemptReconciliationV1) -> Result<(), String> {
        self.consume_reconciliation(reconciliation)
            .map(|_| ())
            .map_err(|error| error.code().to_owned())
    }
}

pub(crate) trait UpdateInstallWebPort: Send + Sync {
    fn prepare<'a>(
        &'a self,
        candidate_id: &'a str,
        updated_at: u64,
    ) -> CoordinatorFuture<'a, Result<PreparedWebQuiescence, String>>;

    fn mark_rollback_required(
        &self,
        identity: &WebQuiescenceIdentity,
        updated_at: u64,
    ) -> Result<(), String>;

    fn seal_for_exit<'a>(
        &'a self,
        prepared: &'a PreparedWebQuiescence,
    ) -> CoordinatorFuture<'a, Result<(), String>>;

    fn confirm_native_rollback(
        &self,
        identity: &WebQuiescenceIdentity,
        updated_at: u64,
    ) -> Result<(), String>;

    fn rollback<'a>(
        &'a self,
        identity: &'a WebQuiescenceIdentity,
        updated_at: u64,
    ) -> CoordinatorFuture<'a, Result<(), String>>;

    fn rollback_cancelled_prepare(
        &self,
        updated_at: u64,
    ) -> CoordinatorFuture<'_, Result<(), String>>;
}

impl<P: WebPlaybackQuiescencePort> UpdateInstallWebPort for WebQuiescenceHandshake<P> {
    fn prepare<'a>(
        &'a self,
        candidate_id: &'a str,
        updated_at: u64,
    ) -> CoordinatorFuture<'a, Result<PreparedWebQuiescence, String>> {
        Box::pin(async move {
            WebQuiescenceHandshake::prepare(self, candidate_id, updated_at)
                .await
                .map_err(|error| error.code().to_owned())
        })
    }

    fn mark_rollback_required(
        &self,
        identity: &WebQuiescenceIdentity,
        updated_at: u64,
    ) -> Result<(), String> {
        self.mark_pre_spawn_failure(identity, updated_at)
            .map_err(|error| error.code().to_owned())
    }

    fn seal_for_exit<'a>(
        &'a self,
        prepared: &'a PreparedWebQuiescence,
    ) -> CoordinatorFuture<'a, Result<(), String>> {
        Box::pin(async move {
            WebQuiescenceHandshake::seal_for_exit(self, prepared)
                .await
                .map_err(|error| error.code().to_owned())
        })
    }

    fn confirm_native_rollback(
        &self,
        identity: &WebQuiescenceIdentity,
        updated_at: u64,
    ) -> Result<(), String> {
        self.store()
            .confirm_native_rollback(identity, updated_at)
            .map(|_| ())
            .map_err(|error| error.code().to_owned())
    }

    fn rollback<'a>(
        &'a self,
        identity: &'a WebQuiescenceIdentity,
        updated_at: u64,
    ) -> CoordinatorFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.rollback_after_native_confirmation(identity, updated_at)
                .await
                .map(|_| ())
                .map_err(|error| error.code().to_owned())
        })
    }

    fn rollback_cancelled_prepare(
        &self,
        updated_at: u64,
    ) -> CoordinatorFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let identity = match self
                .store()
                .reconcile_web(updated_at)
                .map_err(|error| error.code().to_owned())?
            {
                WebQuiescenceReconciliation::Idle
                | WebQuiescenceReconciliation::CompletedRecovered(_) => return Ok(()),
                WebQuiescenceReconciliation::RequestPrepare(request) => request.identity,
                WebQuiescenceReconciliation::RepeatPreparedAcknowledgement { identity, .. }
                | WebQuiescenceReconciliation::NativeRollbackRequired(identity) => identity,
                WebQuiescenceReconciliation::RequestRollback(request) => {
                    return self
                        .rollback_after_native_confirmation(&request.identity, updated_at)
                        .await
                        .map(|_| ())
                        .map_err(|error| error.code().to_owned());
                }
                WebQuiescenceReconciliation::InstallAttemptPending { .. } => {
                    return Err("UPDATE_INSTALL_ATTEMPT_RECOVERY_REQUIRED".to_owned())
                }
            };
            self.mark_pre_spawn_failure(&identity, updated_at)
                .map_err(|error| error.code().to_owned())?;
            self.store()
                .confirm_native_rollback(&identity, updated_at)
                .map_err(|error| error.code().to_owned())?;
            self.rollback_after_native_confirmation(&identity, updated_at)
                .await
                .map(|_| ())
                .map_err(|error| error.code().to_owned())
        })
    }
}

#[derive(Clone)]
struct NativePrepareTask {
    result: Arc<Mutex<Option<Result<NativeInstallLease, NativePrepareFailure>>>>,
    completed: Arc<tokio::sync::Notify>,
}

impl NativePrepareTask {
    fn start(
        native: NativeInstallQuiescence,
        operation_id: String,
        operation_generation: u64,
        drain_timeout: Duration,
    ) -> Self {
        let task = Self {
            result: Arc::new(Mutex::new(None)),
            completed: Arc::new(tokio::sync::Notify::new()),
        };
        let worker = task.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result =
                native.prepare_exact_blocking(&operation_id, operation_generation, drain_timeout);
            *worker
                .result
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(result);
            worker.completed.notify_waiters();
        });
        task
    }

    async fn take(&self) -> Result<NativeInstallLease, NativePrepareFailure> {
        loop {
            let notified = self.completed.notified();
            if let Some(result) = self
                .result
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take()
            {
                return result;
            }
            notified.await;
        }
    }
}

enum RecoveryOwnership {
    None,
    Native(Box<NativeInstallLease>),
    Exit(Box<InstallExitRecovery>),
    Sealed(Box<SealedInstallExit>),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RecoveryStep {
    TombstoneMarker,
    RollbackNative,
    MarkWebRollback,
    ConfirmNativeRollback,
    AwaitWebRollback,
    RevalidateCache,
    ConsumeMarker,
}

struct PendingRecovery {
    web: PreparedWebQuiescence,
    expected: Option<InstallAttemptArtifactIdentity>,
    marker: Option<InstallAttemptMarkerV1>,
    reconciliation: Option<InstallAttemptReconciliationV1>,
    ownership: RecoveryOwnership,
    step: RecoveryStep,
}

enum CoordinatorState {
    Idle,
    WebPreparing,
    WebPrepared(PreparedWebQuiescence),
    NativePreparing {
        web: PreparedWebQuiescence,
        task: NativePrepareTask,
        expected: InstallAttemptArtifactIdentity,
        expected_identity: VerifiedInstallerIdentity,
    },
    NativePrepared {
        web: PreparedWebQuiescence,
        lease: Box<NativeInstallLease>,
        expected: InstallAttemptArtifactIdentity,
        expected_identity: VerifiedInstallerIdentity,
    },
    MarkerPublished {
        web: PreparedWebQuiescence,
        lease: Option<Box<NativeInstallLease>>,
        marker: InstallAttemptMarkerV1,
        plan: Option<NsisInstallPlan>,
        expected: InstallAttemptArtifactIdentity,
        expected_identity: VerifiedInstallerIdentity,
    },
    Sealed {
        web: PreparedWebQuiescence,
        sealed: Option<Box<SealedInstallExit>>,
        marker: InstallAttemptMarkerV1,
        plan: Option<NsisInstallPlan>,
        expected: InstallAttemptArtifactIdentity,
        expected_identity: VerifiedInstallerIdentity,
    },
    Recovery(PendingRecovery),
    InstallerSpawned,
}

enum RetryPreparation {
    WebPreparing,
    WebPrepared,
    NativePreparing(NativePrepareTask),
    NativePrepared,
    MarkerPublished,
    Sealed,
}

struct SealedSpawnTransaction {
    web: PreparedWebQuiescence,
    sealed: Box<SealedInstallExit>,
    marker: InstallAttemptMarkerV1,
    plan: NsisInstallPlan,
    expected: InstallAttemptArtifactIdentity,
    expected_identity: VerifiedInstallerIdentity,
}

pub(crate) struct UpdateInstallCoordinator {
    web: Arc<dyn UpdateInstallWebPort>,
    native: NativeInstallQuiescence,
    cache: Arc<dyn UpdateInstallCachePort>,
    attempts: Arc<dyn UpdateInstallAttemptPort>,
    exit_owners: Arc<dyn InstallExitOwnershipPort>,
    installer: Arc<dyn NsisInstallerSpawnPort>,
    relaunch_arguments: LocalRelaunchArguments,
    native_drain_timeout: Duration,
    operation: tokio::sync::Mutex<()>,
    state: Mutex<CoordinatorState>,
}

impl UpdateInstallCoordinator {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        web: Arc<dyn UpdateInstallWebPort>,
        native: NativeInstallQuiescence,
        cache: Arc<dyn UpdateInstallCachePort>,
        attempts: Arc<dyn UpdateInstallAttemptPort>,
        exit_owners: Arc<dyn InstallExitOwnershipPort>,
        installer: Arc<dyn NsisInstallerSpawnPort>,
        relaunch_arguments: LocalRelaunchArguments,
        native_drain_timeout: Duration,
    ) -> Self {
        Self {
            web,
            native,
            cache,
            attempts,
            exit_owners,
            installer,
            relaunch_arguments,
            native_drain_timeout,
            operation: tokio::sync::Mutex::new(()),
            state: Mutex::new(CoordinatorState::Idle),
        }
    }

    fn phase_inner(state: &CoordinatorState) -> UpdateInstallCoordinatorPhase {
        match state {
            CoordinatorState::Idle => UpdateInstallCoordinatorPhase::Idle,
            CoordinatorState::Recovery(_) => UpdateInstallCoordinatorPhase::RecoveryRequired,
            CoordinatorState::InstallerSpawned => UpdateInstallCoordinatorPhase::InstallerSpawned,
            CoordinatorState::WebPreparing
            | CoordinatorState::WebPrepared(_)
            | CoordinatorState::NativePreparing { .. }
            | CoordinatorState::NativePrepared { .. }
            | CoordinatorState::MarkerPublished { .. }
            | CoordinatorState::Sealed { .. } => UpdateInstallCoordinatorPhase::Preparing,
        }
    }

    fn phase(&self) -> UpdateInstallCoordinatorPhase {
        Self::phase_inner(
            &self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    async fn install_inner(
        &self,
        candidate_id: String,
        artifact: VerifiedInstallerArtifact,
        started_at: u64,
    ) -> Result<UpdateInstallCoordinatorOutcome, UpdateInstallCoordinatorFault> {
        if artifact.candidate_id().as_str() != candidate_id {
            return Err(UpdateInstallCoordinatorFault::new(
                UpdateInstallCoordinatorStage::Authority,
                "UPDATE_INSTALL_CANDIDATE_STALE",
            ));
        }
        let expected_identity = artifact.identity().clone();
        let expected = InstallAttemptArtifactIdentity::new(
            expected_identity.candidate_id().as_str(),
            expected_identity.version(),
            expected_identity.provenance_sha256(),
            expected_identity.metadata_digest(),
            expected_identity.installer_sha256(),
            expected_identity.installer_size(),
        )
        .map_err(|fault| {
            UpdateInstallCoordinatorFault::new(UpdateInstallCoordinatorStage::Authority, fault.code)
        })?;
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !matches!(*state, CoordinatorState::Idle) {
                return Err(UpdateInstallCoordinatorFault::recovery(
                    UpdateInstallCoordinatorStage::Authority,
                    "UPDATE_INSTALL_OPERATION_ACTIVE",
                ));
            }
            *state = CoordinatorState::WebPreparing;
        }

        let web = match self.web.prepare(&candidate_id, started_at).await {
            Ok(web) => web,
            Err(code) => {
                let fault = UpdateInstallCoordinatorFault::new(
                    UpdateInstallCoordinatorStage::WebPrepare,
                    code,
                );
                return self.recover_cancelled_web_prepare(fault, started_at).await;
            }
        };
        *self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            CoordinatorState::WebPrepared(web.clone());
        if web.identity.candidate_id != candidate_id {
            let fault = UpdateInstallCoordinatorFault::new(
                UpdateInstallCoordinatorStage::WebPrepare,
                "UPDATE_WEB_QUIESCENCE_STALE_ACKNOWLEDGEMENT",
            );
            self.begin_recovery_from_web_prepared()?;
            return self.recover_and_return(fault, started_at).await;
        }

        let task = NativePrepareTask::start(
            self.native.clone(),
            web.identity.operation_id.clone(),
            web.identity.operation_generation,
            self.native_drain_timeout,
        );
        *self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            CoordinatorState::NativePreparing {
                web: web.clone(),
                task: task.clone(),
                expected: expected.clone(),
                expected_identity: expected_identity.clone(),
            };
        let lease = match task.take().await {
            Ok(lease) => lease,
            Err(failure) => {
                let fault = UpdateInstallCoordinatorFault::new(
                    UpdateInstallCoordinatorStage::NativePrepare,
                    failure.error.code.clone(),
                );
                self.begin_recovery_from_native_prepare_failure(failure)?;
                return self.recover_and_return(fault, started_at).await;
            }
        };
        *self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            CoordinatorState::NativePrepared {
                web: web.clone(),
                lease: Box::new(lease),
                expected: expected.clone(),
                expected_identity: expected_identity.clone(),
            };

        let revalidated = match self.cache.inspect_exact(&expected).await {
            Ok(revalidated) => revalidated,
            Err(cache_fault) => {
                let fault = UpdateInstallCoordinatorFault::new(
                    UpdateInstallCoordinatorStage::CacheRevalidation,
                    cache_fault.code,
                );
                self.begin_recovery_from_native_prepared()?;
                return self.recover_and_return(fault, started_at).await;
            }
        };
        if revalidated.identity() != &expected_identity {
            let fault = UpdateInstallCoordinatorFault::new(
                UpdateInstallCoordinatorStage::CacheRevalidation,
                "UPDATE_CACHE_IDENTITY_CONFLICT",
            );
            self.begin_recovery_from_native_prepared()?;
            return self.recover_and_return(fault, started_at).await;
        }
        let plan = match NsisInstallPlan::from_verified_artifact(
            &revalidated,
            &expected_identity,
            self.relaunch_arguments.clone(),
        ) {
            Ok(plan) => plan,
            Err(error) => {
                let fault = UpdateInstallCoordinatorFault::new(
                    UpdateInstallCoordinatorStage::InstallPlan,
                    error.code(),
                );
                self.begin_recovery_from_native_prepared()?;
                return self.recover_and_return(fault, started_at).await;
            }
        };
        let marker = match self.attempts.publish(InstallAttemptInput {
            operation_id: web.identity.operation_id.clone(),
            operation_generation: web.identity.operation_generation,
            candidate_id: expected_identity.candidate_id().as_str().to_owned(),
            target_version: expected_identity.version().to_owned(),
            provenance_sha256: expected_identity.provenance_sha256().to_owned(),
            candidate_metadata_digest: expected_identity.metadata_digest().to_owned(),
            installer_sha256: expected_identity.installer_sha256().to_owned(),
            installer_size: expected_identity.installer_size(),
            checkpoint_receipt: web.evidence.receipt.clone(),
            checkpoint_digest: web.evidence.digest.clone(),
            created_at: started_at,
        }) {
            Ok(marker) => marker,
            Err(code) => {
                let fault = UpdateInstallCoordinatorFault::new(
                    UpdateInstallCoordinatorStage::MarkerPublish,
                    code,
                );
                self.begin_recovery_from_native_prepared()?;
                return self.recover_and_return(fault, started_at).await;
            }
        };

        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let previous = std::mem::replace(&mut *state, CoordinatorState::Idle);
            let CoordinatorState::NativePrepared { lease, .. } = previous else {
                *state = previous;
                return Err(UpdateInstallCoordinatorFault::recovery(
                    UpdateInstallCoordinatorStage::MarkerPublish,
                    "UPDATE_INSTALL_COORDINATOR_STATE_CONFLICT",
                ));
            };
            *state = CoordinatorState::MarkerPublished {
                web: web.clone(),
                lease: Some(lease),
                marker: marker.clone(),
                plan: Some(plan),
                expected: expected.clone(),
                expected_identity: expected_identity.clone(),
            };
        }
        if let Err(code) = self.web.seal_for_exit(&web).await {
            let fault =
                UpdateInstallCoordinatorFault::new(UpdateInstallCoordinatorStage::ExitSeal, code);
            self.begin_recovery_from_marker(None)?;
            return self.recover_and_return(fault, started_at).await;
        }
        let lease = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let CoordinatorState::MarkerPublished { lease, .. } = &mut *state else {
                return Err(UpdateInstallCoordinatorFault::recovery(
                    UpdateInstallCoordinatorStage::ExitSeal,
                    "UPDATE_INSTALL_COORDINATOR_STATE_CONFLICT",
                ));
            };
            lease.take().ok_or_else(|| {
                UpdateInstallCoordinatorFault::recovery(
                    UpdateInstallCoordinatorStage::ExitSeal,
                    "UPDATE_INSTALL_NATIVE_LEASE_MISSING",
                )
            })?
        };
        let operation = lease.operation().clone();
        let sealed = match (*lease).seal(&operation, Arc::clone(&self.exit_owners)) {
            Ok(sealed) => sealed,
            Err(mut failure) => {
                let fault = UpdateInstallCoordinatorFault::new(
                    UpdateInstallCoordinatorStage::ExitSeal,
                    failure.error.code,
                );
                let ownership = failure
                    .recovery
                    .take()
                    .map(RecoveryOwnership::Exit)
                    .unwrap_or(RecoveryOwnership::None);
                self.begin_recovery_from_marker(Some(ownership))?;
                return match self.drive_recovery(started_at).await {
                    Ok(()) => Err(fault),
                    Err(_) => Err(UpdateInstallCoordinatorFault {
                        recovery_required: true,
                        ..fault
                    }),
                };
            }
        };
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let previous = std::mem::replace(&mut *state, CoordinatorState::Idle);
            let CoordinatorState::MarkerPublished {
                web,
                marker,
                plan,
                expected,
                expected_identity,
                ..
            } = previous
            else {
                *state = previous;
                return Err(UpdateInstallCoordinatorFault::recovery(
                    UpdateInstallCoordinatorStage::ExitSeal,
                    "UPDATE_INSTALL_COORDINATOR_STATE_CONFLICT",
                ));
            };
            *state = CoordinatorState::Sealed {
                web,
                sealed: Some(Box::new(sealed)),
                marker,
                plan,
                expected,
                expected_identity,
            };
        }

        let transaction = match self.take_sealed_spawn_transaction() {
            Ok(transaction) => transaction,
            Err(fault) => {
                self.begin_recovery_from_sealed()?;
                return match self.drive_recovery(started_at).await {
                    Ok(()) => Err(fault),
                    Err(_) => Err(UpdateInstallCoordinatorFault {
                        recovery_required: true,
                        ..fault
                    }),
                };
            }
        };
        let SealedSpawnTransaction {
            web,
            sealed,
            marker,
            plan,
            expected,
            expected_identity,
        } = transaction;
        let spawned = match plan.spawn_with_sealed_exit(sealed, self.installer.as_ref()) {
            Ok(spawned) => spawned,
            Err(failure) => {
                let fault = UpdateInstallCoordinatorFault::new(
                    UpdateInstallCoordinatorStage::InstallerSpawn,
                    failure.error().code(),
                );
                *self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) =
                    CoordinatorState::Sealed {
                        web,
                        sealed: Some(failure.into_sealed_exit()),
                        marker,
                        plan: None,
                        expected,
                        expected_identity,
                    };
                self.begin_recovery_from_sealed()?;
                return match self.drive_recovery(started_at).await {
                    Ok(()) => Err(fault),
                    Err(_) => Err(UpdateInstallCoordinatorFault {
                        recovery_required: true,
                        ..fault
                    }),
                };
            }
        };
        // spawn 成功后只剩这个不可失败动作：不加锁、不等待、不做 identity 分支。
        spawned.commit_after_spawn();
        Ok(UpdateInstallCoordinatorOutcome::InstallerSpawned)
    }

    fn take_sealed_spawn_transaction(
        &self,
    ) -> Result<SealedSpawnTransaction, UpdateInstallCoordinatorFault> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous = std::mem::replace(&mut *state, CoordinatorState::Idle);
        let CoordinatorState::Sealed {
            web,
            sealed,
            marker,
            plan,
            expected,
            expected_identity,
        } = previous
        else {
            *state = previous;
            return Err(UpdateInstallCoordinatorFault::recovery(
                UpdateInstallCoordinatorStage::InstallerSpawn,
                "UPDATE_INSTALL_COORDINATOR_STATE_CONFLICT",
            ));
        };
        let (sealed, plan) = match (sealed, plan) {
            (Some(sealed), Some(plan)) => (sealed, plan),
            (sealed, plan) => {
                *state = CoordinatorState::Sealed {
                    web,
                    sealed,
                    marker,
                    plan,
                    expected,
                    expected_identity,
                };
                return Err(UpdateInstallCoordinatorFault::recovery(
                    UpdateInstallCoordinatorStage::InstallerSpawn,
                    "UPDATE_INSTALL_SEALED_TRANSACTION_INCOMPLETE",
                ));
            }
        };
        if plan.identity() != &expected_identity {
            *state = CoordinatorState::Sealed {
                web,
                sealed: Some(sealed),
                marker,
                plan: Some(plan),
                expected,
                expected_identity,
            };
            return Err(UpdateInstallCoordinatorFault::new(
                UpdateInstallCoordinatorStage::InstallerIdentity,
                "UPDATE_INSTALL_SPAWN_IDENTITY_CONFLICT",
            ));
        }
        // 同一 operation mutex 仍被 caller 持有；从此点到同步 spawn 不存在 await。
        // 先冻结终态，保证 spawn 成功后无需再次访问 coordinator state。
        *state = CoordinatorState::InstallerSpawned;
        Ok(SealedSpawnTransaction {
            web,
            sealed,
            marker,
            plan,
            expected,
            expected_identity,
        })
    }

    async fn recover_and_return(
        &self,
        fault: UpdateInstallCoordinatorFault,
        updated_at: u64,
    ) -> Result<UpdateInstallCoordinatorOutcome, UpdateInstallCoordinatorFault> {
        match self.drive_recovery(updated_at).await {
            Ok(()) => Err(fault),
            Err(_) => Err(UpdateInstallCoordinatorFault {
                recovery_required: true,
                ..fault
            }),
        }
    }

    async fn recover_cancelled_web_prepare(
        &self,
        fault: UpdateInstallCoordinatorFault,
        updated_at: u64,
    ) -> Result<UpdateInstallCoordinatorOutcome, UpdateInstallCoordinatorFault> {
        match self.web.rollback_cancelled_prepare(updated_at).await {
            Ok(()) => {
                *self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = CoordinatorState::Idle;
                Err(fault)
            }
            Err(_) => Err(UpdateInstallCoordinatorFault {
                recovery_required: true,
                ..fault
            }),
        }
    }

    fn begin_recovery_from_web_prepared(&self) -> Result<(), UpdateInstallCoordinatorFault> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous = std::mem::replace(&mut *state, CoordinatorState::Idle);
        let CoordinatorState::WebPrepared(web) = previous else {
            *state = previous;
            return Err(UpdateInstallCoordinatorFault::recovery(
                UpdateInstallCoordinatorStage::WebRollback,
                "UPDATE_INSTALL_COORDINATOR_STATE_CONFLICT",
            ));
        };
        *state = CoordinatorState::Recovery(PendingRecovery {
            web,
            expected: None,
            marker: None,
            reconciliation: None,
            ownership: RecoveryOwnership::None,
            step: RecoveryStep::RollbackNative,
        });
        Ok(())
    }

    fn begin_recovery_from_native_prepare_failure(
        &self,
        mut failure: NativePrepareFailure,
    ) -> Result<(), UpdateInstallCoordinatorFault> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous = std::mem::replace(&mut *state, CoordinatorState::Idle);
        let CoordinatorState::NativePreparing { web, expected, .. } = previous else {
            *state = previous;
            return Err(UpdateInstallCoordinatorFault::recovery(
                UpdateInstallCoordinatorStage::NativeRollback,
                "UPDATE_INSTALL_COORDINATOR_STATE_CONFLICT",
            ));
        };
        let ownership = failure
            .recovery_lease
            .take()
            .map(RecoveryOwnership::Native)
            .unwrap_or(RecoveryOwnership::None);
        *state = CoordinatorState::Recovery(PendingRecovery {
            web,
            expected: Some(expected),
            marker: None,
            reconciliation: None,
            ownership,
            step: RecoveryStep::RollbackNative,
        });
        Ok(())
    }

    fn begin_recovery_from_native_preparing_lease(
        &self,
        lease: NativeInstallLease,
    ) -> Result<(), UpdateInstallCoordinatorFault> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous = std::mem::replace(&mut *state, CoordinatorState::Idle);
        let CoordinatorState::NativePreparing { web, expected, .. } = previous else {
            *state = previous;
            return Err(UpdateInstallCoordinatorFault::recovery(
                UpdateInstallCoordinatorStage::NativeRollback,
                "UPDATE_INSTALL_COORDINATOR_STATE_CONFLICT",
            ));
        };
        *state = CoordinatorState::Recovery(PendingRecovery {
            web,
            expected: Some(expected),
            marker: None,
            reconciliation: None,
            ownership: RecoveryOwnership::Native(Box::new(lease)),
            step: RecoveryStep::RollbackNative,
        });
        Ok(())
    }

    fn begin_recovery_from_native_prepared(&self) -> Result<(), UpdateInstallCoordinatorFault> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous = std::mem::replace(&mut *state, CoordinatorState::Idle);
        let CoordinatorState::NativePrepared {
            web,
            lease,
            expected,
            ..
        } = previous
        else {
            *state = previous;
            return Err(UpdateInstallCoordinatorFault::recovery(
                UpdateInstallCoordinatorStage::NativeRollback,
                "UPDATE_INSTALL_COORDINATOR_STATE_CONFLICT",
            ));
        };
        *state = CoordinatorState::Recovery(PendingRecovery {
            web,
            expected: Some(expected),
            marker: None,
            reconciliation: None,
            ownership: RecoveryOwnership::Native(lease),
            step: RecoveryStep::RollbackNative,
        });
        Ok(())
    }

    fn begin_recovery_from_sealed(&self) -> Result<(), UpdateInstallCoordinatorFault> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous = std::mem::replace(&mut *state, CoordinatorState::Idle);
        let CoordinatorState::Sealed {
            web,
            mut sealed,
            marker,
            expected,
            expected_identity,
            ..
        } = previous
        else {
            *state = previous;
            return Err(UpdateInstallCoordinatorFault::recovery(
                UpdateInstallCoordinatorStage::InstallerSpawn,
                "UPDATE_INSTALL_COORDINATOR_STATE_CONFLICT",
            ));
        };
        let Some(sealed) = sealed.take() else {
            *state = CoordinatorState::Sealed {
                web,
                sealed: None,
                marker,
                plan: None,
                expected,
                expected_identity,
            };
            return Err(UpdateInstallCoordinatorFault::recovery(
                UpdateInstallCoordinatorStage::InstallerSpawn,
                "UPDATE_INSTALL_SEALED_EXIT_MISSING",
            ));
        };
        *state = CoordinatorState::Recovery(PendingRecovery {
            web,
            expected: Some(expected),
            marker: Some(marker),
            reconciliation: None,
            ownership: RecoveryOwnership::Sealed(sealed),
            step: RecoveryStep::TombstoneMarker,
        });
        Ok(())
    }

    fn begin_recovery_from_marker(
        &self,
        explicit_ownership: Option<RecoveryOwnership>,
    ) -> Result<(), UpdateInstallCoordinatorFault> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous = std::mem::replace(&mut *state, CoordinatorState::Idle);
        let CoordinatorState::MarkerPublished {
            web,
            lease,
            marker,
            expected,
            expected_identity,
            ..
        } = previous
        else {
            *state = previous;
            return Err(UpdateInstallCoordinatorFault::recovery(
                UpdateInstallCoordinatorStage::ExitSeal,
                "UPDATE_INSTALL_COORDINATOR_STATE_CONFLICT",
            ));
        };
        let ownership = match (explicit_ownership, lease) {
            (Some(ownership), None) => ownership,
            (None, Some(lease)) => RecoveryOwnership::Native(lease),
            (None, None) => RecoveryOwnership::None,
            (Some(ownership), Some(lease)) => {
                *state = CoordinatorState::MarkerPublished {
                    web,
                    lease: Some(lease),
                    marker,
                    plan: None,
                    expected,
                    expected_identity,
                };
                drop(ownership);
                return Err(UpdateInstallCoordinatorFault::recovery(
                    UpdateInstallCoordinatorStage::ExitSeal,
                    "UPDATE_INSTALL_DUPLICATE_RECOVERY_OWNERSHIP",
                ));
            }
        };
        *state = CoordinatorState::Recovery(PendingRecovery {
            web,
            expected: Some(expected),
            marker: Some(marker),
            reconciliation: None,
            ownership,
            step: RecoveryStep::TombstoneMarker,
        });
        Ok(())
    }

    async fn drive_recovery(&self, updated_at: u64) -> Result<(), UpdateInstallCoordinatorFault> {
        loop {
            let step = {
                let state = self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                match &*state {
                    CoordinatorState::Recovery(pending) => pending.step,
                    CoordinatorState::Idle => return Ok(()),
                    _ => {
                        return Err(UpdateInstallCoordinatorFault::recovery(
                            UpdateInstallCoordinatorStage::Authority,
                            "UPDATE_INSTALL_COORDINATOR_STATE_CONFLICT",
                        ))
                    }
                }
            };
            match step {
                RecoveryStep::TombstoneMarker => {
                    let marker = {
                        let state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let CoordinatorState::Recovery(pending) = &*state else {
                            unreachable!()
                        };
                        pending.marker.clone()
                    };
                    if let Some(marker) = marker {
                        let reconciliation = self
                            .attempts
                            .tombstone_pre_spawn_abort(&marker, updated_at)
                            .map_err(|code| {
                                UpdateInstallCoordinatorFault::recovery(
                                    UpdateInstallCoordinatorStage::MarkerTombstone,
                                    code,
                                )
                            })?;
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let CoordinatorState::Recovery(pending) = &mut *state else {
                            unreachable!()
                        };
                        pending.reconciliation = Some(reconciliation);
                        pending.step = RecoveryStep::RollbackNative;
                    } else {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let CoordinatorState::Recovery(pending) = &mut *state else {
                            unreachable!()
                        };
                        pending.step = RecoveryStep::RollbackNative;
                    }
                }
                RecoveryStep::RollbackNative => {
                    let (ownership, operation) = {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let CoordinatorState::Recovery(pending) = &mut *state else {
                            unreachable!()
                        };
                        let ownership =
                            std::mem::replace(&mut pending.ownership, RecoveryOwnership::None);
                        let operation = match &ownership {
                            RecoveryOwnership::None => None,
                            RecoveryOwnership::Native(lease) => Some(lease.operation().clone()),
                            RecoveryOwnership::Exit(recovery) => Some(recovery.operation().clone()),
                            RecoveryOwnership::Sealed(sealed) => Some(sealed.operation().clone()),
                        };
                        (ownership, operation)
                    };
                    let rollback = match ownership {
                        RecoveryOwnership::None => Ok(RecoveryOwnership::None),
                        RecoveryOwnership::Native(mut lease) => {
                            let operation = operation.as_ref().expect("native operation");
                            match lease.rollback_exact(operation) {
                                Ok(_) => Ok(RecoveryOwnership::None),
                                Err(error) => Err((error.code, RecoveryOwnership::Native(lease))),
                            }
                        }
                        RecoveryOwnership::Exit(recovery) => {
                            let operation = operation.as_ref().expect("exit operation");
                            match recovery.rollback_before_spawn(operation) {
                                Ok(_) => Ok(RecoveryOwnership::None),
                                Err(failure) => Err((
                                    failure.error.code,
                                    RecoveryOwnership::Exit(failure.recovery),
                                )),
                            }
                        }
                        RecoveryOwnership::Sealed(sealed) => {
                            let operation = operation.as_ref().expect("sealed operation");
                            match sealed.rollback_before_spawn(operation) {
                                Ok(_) => Ok(RecoveryOwnership::None),
                                Err(failure) => Err((
                                    failure.error.code,
                                    RecoveryOwnership::Exit(failure.recovery),
                                )),
                            }
                        }
                    };
                    match rollback {
                        Ok(ownership) => {
                            let mut state = self
                                .state
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            let CoordinatorState::Recovery(pending) = &mut *state else {
                                unreachable!()
                            };
                            pending.ownership = ownership;
                            pending.step = RecoveryStep::MarkWebRollback;
                        }
                        Err((code, ownership)) => {
                            let mut state = self
                                .state
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            let CoordinatorState::Recovery(pending) = &mut *state else {
                                unreachable!()
                            };
                            pending.ownership = ownership;
                            return Err(UpdateInstallCoordinatorFault::recovery(
                                UpdateInstallCoordinatorStage::NativeRollback,
                                code,
                            ));
                        }
                    }
                }
                RecoveryStep::MarkWebRollback => {
                    let identity = self.recovery_identity()?;
                    self.web
                        .mark_rollback_required(&identity, updated_at)
                        .map_err(|code| {
                            UpdateInstallCoordinatorFault::recovery(
                                UpdateInstallCoordinatorStage::WebRollback,
                                code,
                            )
                        })?;
                    self.advance_recovery(RecoveryStep::ConfirmNativeRollback)?;
                }
                RecoveryStep::ConfirmNativeRollback => {
                    let identity = self.recovery_identity()?;
                    self.web
                        .confirm_native_rollback(&identity, updated_at)
                        .map_err(|code| {
                            UpdateInstallCoordinatorFault::recovery(
                                UpdateInstallCoordinatorStage::WebRollback,
                                code,
                            )
                        })?;
                    self.advance_recovery(RecoveryStep::AwaitWebRollback)?;
                }
                RecoveryStep::AwaitWebRollback => {
                    let identity = self.recovery_identity()?;
                    self.web
                        .rollback(&identity, updated_at)
                        .await
                        .map_err(|code| {
                            UpdateInstallCoordinatorFault::recovery(
                                UpdateInstallCoordinatorStage::WebRollback,
                                code,
                            )
                        })?;
                    let has_marker = {
                        let state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        matches!(&*state, CoordinatorState::Recovery(pending) if pending.marker.is_some())
                    };
                    self.advance_recovery(if has_marker {
                        RecoveryStep::RevalidateCache
                    } else {
                        RecoveryStep::ConsumeMarker
                    })?;
                }
                RecoveryStep::RevalidateCache => {
                    let expected = {
                        let state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let CoordinatorState::Recovery(pending) = &*state else {
                            unreachable!()
                        };
                        pending.expected.clone().ok_or_else(|| {
                            UpdateInstallCoordinatorFault::recovery(
                                UpdateInstallCoordinatorStage::CacheRevalidation,
                                "UPDATE_INSTALL_RECOVERY_IDENTITY_MISSING",
                            )
                        })?
                    };
                    self.cache.inspect_exact(&expected).await.map_err(|fault| {
                        UpdateInstallCoordinatorFault::recovery(
                            UpdateInstallCoordinatorStage::CacheRevalidation,
                            fault.code,
                        )
                    })?;
                    self.advance_recovery(RecoveryStep::ConsumeMarker)?;
                }
                RecoveryStep::ConsumeMarker => {
                    let reconciliation = {
                        let state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let CoordinatorState::Recovery(pending) = &*state else {
                            unreachable!()
                        };
                        pending.reconciliation.clone()
                    };
                    if let Some(reconciliation) = reconciliation {
                        self.attempts.consume(&reconciliation).map_err(|code| {
                            UpdateInstallCoordinatorFault::recovery(
                                UpdateInstallCoordinatorStage::MarkerConsume,
                                code,
                            )
                        })?;
                    }
                    *self
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) =
                        CoordinatorState::Idle;
                    return Ok(());
                }
            }
        }
    }

    fn recovery_identity(&self) -> Result<WebQuiescenceIdentity, UpdateInstallCoordinatorFault> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match &*state {
            CoordinatorState::Recovery(pending) => Ok(pending.web.identity.clone()),
            _ => Err(UpdateInstallCoordinatorFault::recovery(
                UpdateInstallCoordinatorStage::Authority,
                "UPDATE_INSTALL_COORDINATOR_STATE_CONFLICT",
            )),
        }
    }

    fn advance_recovery(&self, step: RecoveryStep) -> Result<(), UpdateInstallCoordinatorFault> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let CoordinatorState::Recovery(pending) = &mut *state else {
            return Err(UpdateInstallCoordinatorFault::recovery(
                UpdateInstallCoordinatorStage::Authority,
                "UPDATE_INSTALL_COORDINATOR_STATE_CONFLICT",
            ));
        };
        pending.step = step;
        Ok(())
    }

    async fn retry_inner(
        &self,
        updated_at: u64,
    ) -> Result<UpdateInstallCoordinatorOutcome, UpdateInstallCoordinatorFault> {
        let preparation = {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match &*state {
                CoordinatorState::Idle => {
                    return Ok(UpdateInstallCoordinatorOutcome::RecoveryCompleted)
                }
                CoordinatorState::Recovery(_) => None,
                CoordinatorState::InstallerSpawned => {
                    return Err(UpdateInstallCoordinatorFault::new(
                        UpdateInstallCoordinatorStage::Authority,
                        "UPDATE_INSTALL_ALREADY_SPAWNED",
                    ))
                }
                CoordinatorState::WebPreparing => Some(RetryPreparation::WebPreparing),
                CoordinatorState::WebPrepared(_) => Some(RetryPreparation::WebPrepared),
                CoordinatorState::NativePreparing { task, .. } => {
                    Some(RetryPreparation::NativePreparing(task.clone()))
                }
                CoordinatorState::NativePrepared { .. } => Some(RetryPreparation::NativePrepared),
                CoordinatorState::MarkerPublished { .. } => Some(RetryPreparation::MarkerPublished),
                CoordinatorState::Sealed { .. } => Some(RetryPreparation::Sealed),
            }
        };

        match preparation {
            None => {}
            Some(RetryPreparation::WebPreparing) => {
                self.web
                    .rollback_cancelled_prepare(updated_at)
                    .await
                    .map_err(|code| {
                        UpdateInstallCoordinatorFault::recovery(
                            UpdateInstallCoordinatorStage::WebRollback,
                            code,
                        )
                    })?;
                *self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = CoordinatorState::Idle;
                return Ok(UpdateInstallCoordinatorOutcome::RecoveryCompleted);
            }
            Some(RetryPreparation::WebPrepared) => {
                self.begin_recovery_from_web_prepared()?;
            }
            Some(RetryPreparation::NativePreparing(task)) => match task.take().await {
                Ok(lease) => self.begin_recovery_from_native_preparing_lease(lease)?,
                Err(failure) => self.begin_recovery_from_native_prepare_failure(failure)?,
            },
            Some(RetryPreparation::NativePrepared) => {
                self.begin_recovery_from_native_prepared()?;
            }
            Some(RetryPreparation::MarkerPublished) => {
                self.begin_recovery_from_marker(None)?;
            }
            Some(RetryPreparation::Sealed) => {
                self.begin_recovery_from_sealed()?;
            }
        }

        self.drive_recovery(updated_at).await?;
        Ok(UpdateInstallCoordinatorOutcome::RecoveryCompleted)
    }
}

impl UpdateInstallCoordinatorPort for UpdateInstallCoordinator {
    fn install_exact<'a>(
        &'a self,
        candidate_id: String,
        artifact: VerifiedInstallerArtifact,
        started_at: u64,
    ) -> CoordinatorFuture<'a, Result<UpdateInstallCoordinatorOutcome, UpdateInstallCoordinatorFault>>
    {
        Box::pin(async move {
            let _operation = self.operation.lock().await;
            self.install_inner(candidate_id, artifact, started_at).await
        })
    }

    fn retry_recovery(
        &self,
        updated_at: u64,
    ) -> CoordinatorFuture<'_, Result<UpdateInstallCoordinatorOutcome, UpdateInstallCoordinatorFault>>
    {
        Box::pin(async move {
            let _operation = self.operation.lock().await;
            self.retry_inner(updated_at).await
        })
    }

    fn phase(&self) -> UpdateInstallCoordinatorPhase {
        UpdateInstallCoordinator::phase(self)
    }
}

#[derive(Clone)]
pub(crate) struct RuntimeUpdateInstallerAdapter {
    coordinator: Arc<UpdateInstallCoordinator>,
}

impl RuntimeUpdateInstallerAdapter {
    pub(crate) fn new(coordinator: Arc<UpdateInstallCoordinator>) -> Self {
        Self { coordinator }
    }
}

impl UpdateInstaller for RuntimeUpdateInstallerAdapter {
    fn install_exact<'a>(
        &'a self,
        candidate_id: String,
        artifact: VerifiedInstallerArtifact,
        started_at: u64,
    ) -> Pin<Box<dyn Future<Output = Result<UpdateInstallOutcome, UpdateInstallFault>> + Send + 'a>>
    {
        Box::pin(async move {
            UpdateInstallCoordinatorPort::install_exact(
                self.coordinator.as_ref(),
                candidate_id,
                artifact,
                started_at,
            )
            .await
            .map(map_runtime_install_outcome)
            .map_err(map_runtime_install_fault)
        })
    }

    fn retry_recovery(
        &self,
        updated_at: u64,
    ) -> Pin<Box<dyn Future<Output = Result<UpdateInstallOutcome, UpdateInstallFault>> + Send + '_>>
    {
        Box::pin(async move {
            UpdateInstallCoordinatorPort::retry_recovery(self.coordinator.as_ref(), updated_at)
                .await
                .map(map_runtime_install_outcome)
                .map_err(map_runtime_install_fault)
        })
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Condvar, Mutex,
        },
        time::SystemTime,
    };

    use crate::runtime::updater::{
        cache::InstallAttemptArtifactIdentity,
        download::VerifiedInstallerArtifact,
        provenance::ReleaseCandidateId,
        quiescence::{CheckpointEvidence, PlaybackExitCheckpointV1, WebQuiescenceIdentity},
    };

    use super::*;
    use crate::app::{
        update_install_exit::{
            InfallibleInstallExitCapability, InstallExitOwnershipError,
            InstallExitOwnershipReceipt, InstallExitRecoveryEvidence,
        },
        update_install_gate::UpdateInstallGateClaim,
        update_install_quiescence::{
            NativeInstallOwnerPort, NativeInstallStage, NativeOwnerError,
            NativeOwnerPrepareFailure, NativeOwnerReceipt,
        },
    };
    use crate::runtime::updater::nsis_install::{NsisSpawnPortError, NsisSpawnRequest};

    #[test]
    fn runtime_installer_adapter_maps_every_coordinator_stage_to_a_stable_core_domain() {
        let cases = [
            (
                UpdateInstallCoordinatorStage::Authority,
                UpdateFaultStage::Install,
                false,
            ),
            (
                UpdateInstallCoordinatorStage::WebPrepare,
                UpdateFaultStage::Quiesce,
                true,
            ),
            (
                UpdateInstallCoordinatorStage::NativePrepare,
                UpdateFaultStage::Quiesce,
                true,
            ),
            (
                UpdateInstallCoordinatorStage::CacheRevalidation,
                UpdateFaultStage::Cache,
                false,
            ),
            (
                UpdateInstallCoordinatorStage::InstallPlan,
                UpdateFaultStage::Install,
                false,
            ),
            (
                UpdateInstallCoordinatorStage::MarkerPublish,
                UpdateFaultStage::Install,
                true,
            ),
            (
                UpdateInstallCoordinatorStage::ExitSeal,
                UpdateFaultStage::Install,
                true,
            ),
            (
                UpdateInstallCoordinatorStage::InstallerSpawn,
                UpdateFaultStage::Install,
                true,
            ),
            (
                UpdateInstallCoordinatorStage::InstallerIdentity,
                UpdateFaultStage::Install,
                false,
            ),
            (
                UpdateInstallCoordinatorStage::MarkerTombstone,
                UpdateFaultStage::Install,
                true,
            ),
            (
                UpdateInstallCoordinatorStage::NativeRollback,
                UpdateFaultStage::Quiesce,
                true,
            ),
            (
                UpdateInstallCoordinatorStage::WebRollback,
                UpdateFaultStage::Quiesce,
                true,
            ),
            (
                UpdateInstallCoordinatorStage::MarkerConsume,
                UpdateFaultStage::Install,
                true,
            ),
        ];

        for (coordinator_stage, core_stage, retryable) in cases {
            let projection = project_runtime_install_fault(coordinator_stage);
            assert_eq!(projection.stage, core_stage);
            assert_eq!(projection.retryable, retryable);
            assert!(!projection.message.is_empty());
            assert!(!projection.message.contains("http"));
            assert!(!projection.message.contains('/'));
            assert!(!projection.message.contains('\\'));
        }
    }

    #[test]
    fn runtime_installer_adapter_preserves_only_bounded_typed_codes() {
        let fallback = "UPDATE_INSTALL_FAILED";
        assert_eq!(
            stable_runtime_fault_code("UPDATE_INSTALL_SPAWN_FAILED", fallback),
            "UPDATE_INSTALL_SPAWN_FAILED"
        );
        assert_eq!(
            stable_runtime_fault_code(
                "https://release-assets.githubusercontent.com/file.exe?token=secret",
                fallback,
            ),
            fallback
        );
        assert_eq!(
            stable_runtime_fault_code(r"C:\\Users\\name\\installer.exe", fallback),
            fallback
        );
        assert_eq!(
            stable_runtime_fault_code(&format!("UPDATE_{}", "A".repeat(100)), fallback),
            fallback
        );
        assert_eq!(
            stable_runtime_fault_code("UPDATE_INSTALL_FAILED\u{202e}EXE", fallback),
            fallback
        );
    }

    #[test]
    fn runtime_installer_adapter_forces_recovery_faults_to_retryable() {
        let authority = project_runtime_install_fault(UpdateInstallCoordinatorStage::Authority);
        assert!(!runtime_install_fault_retryable(authority, false));
        assert!(runtime_install_fault_retryable(authority, true));
    }

    #[test]
    fn runtime_installer_adapter_maps_terminal_outcomes_exactly() {
        assert_eq!(
            map_runtime_install_outcome(UpdateInstallCoordinatorOutcome::InstallerSpawned),
            UpdateInstallOutcome::InstallerSpawned
        );
        assert_eq!(
            map_runtime_install_outcome(UpdateInstallCoordinatorOutcome::RecoveryCompleted),
            UpdateInstallOutcome::RecoveryCompleted
        );
    }

    struct FakeWeb {
        events: Arc<Mutex<Vec<&'static str>>>,
    }

    impl UpdateInstallWebPort for FakeWeb {
        fn prepare<'a>(
            &'a self,
            candidate_id: &'a str,
            _updated_at: u64,
        ) -> CoordinatorFuture<'a, Result<PreparedWebQuiescence, String>> {
            Box::pin(async move {
                self.events.lock().unwrap().push("web.prepare");
                let identity = WebQuiescenceIdentity {
                    operation_id: "a".repeat(32),
                    operation_generation: 7,
                    candidate_id: candidate_id.to_owned(),
                };
                let checkpoint: PlaybackExitCheckpointV1 = serde_json::from_str(include_str!(
                    "../runtime/updater/fixtures/playback-exit-checkpoint-v1.json"
                ))
                .unwrap();
                Ok(PreparedWebQuiescence {
                    identity,
                    checkpoint,
                    evidence: CheckpointEvidence {
                        receipt: "b".repeat(32),
                        digest: "c".repeat(64),
                    },
                })
            })
        }

        fn mark_rollback_required(
            &self,
            _identity: &WebQuiescenceIdentity,
            _updated_at: u64,
        ) -> Result<(), String> {
            self.events.lock().unwrap().push("web.mark-rollback");
            Ok(())
        }

        fn seal_for_exit<'a>(
            &'a self,
            _prepared: &'a PreparedWebQuiescence,
        ) -> CoordinatorFuture<'a, Result<(), String>> {
            Box::pin(async move {
                self.events.lock().unwrap().push("web.seal");
                Ok(())
            })
        }

        fn confirm_native_rollback(
            &self,
            _identity: &WebQuiescenceIdentity,
            _updated_at: u64,
        ) -> Result<(), String> {
            self.events.lock().unwrap().push("web.confirm-native");
            Ok(())
        }

        fn rollback<'a>(
            &'a self,
            _identity: &'a WebQuiescenceIdentity,
            _updated_at: u64,
        ) -> CoordinatorFuture<'a, Result<(), String>> {
            Box::pin(async move {
                self.events.lock().unwrap().push("web.rollback");
                Ok(())
            })
        }

        fn rollback_cancelled_prepare(
            &self,
            _updated_at: u64,
        ) -> CoordinatorFuture<'_, Result<(), String>> {
            Box::pin(async move {
                self.events.lock().unwrap().push("web.rollback-orphan");
                Ok(())
            })
        }
    }

    struct BlockingSealWeb {
        inner: FakeWeb,
        entered: Arc<tokio::sync::Notify>,
    }

    impl UpdateInstallWebPort for BlockingSealWeb {
        fn prepare<'a>(
            &'a self,
            candidate_id: &'a str,
            updated_at: u64,
        ) -> CoordinatorFuture<'a, Result<PreparedWebQuiescence, String>> {
            self.inner.prepare(candidate_id, updated_at)
        }

        fn mark_rollback_required(
            &self,
            identity: &WebQuiescenceIdentity,
            updated_at: u64,
        ) -> Result<(), String> {
            self.inner.mark_rollback_required(identity, updated_at)
        }

        fn seal_for_exit<'a>(
            &'a self,
            _prepared: &'a PreparedWebQuiescence,
        ) -> CoordinatorFuture<'a, Result<(), String>> {
            Box::pin(async move {
                self.inner.events.lock().unwrap().push("web.seal");
                self.entered.notify_one();
                std::future::pending::<()>().await;
                Ok(())
            })
        }

        fn confirm_native_rollback(
            &self,
            identity: &WebQuiescenceIdentity,
            updated_at: u64,
        ) -> Result<(), String> {
            self.inner.confirm_native_rollback(identity, updated_at)
        }

        fn rollback<'a>(
            &'a self,
            identity: &'a WebQuiescenceIdentity,
            updated_at: u64,
        ) -> CoordinatorFuture<'a, Result<(), String>> {
            self.inner.rollback(identity, updated_at)
        }

        fn rollback_cancelled_prepare(
            &self,
            updated_at: u64,
        ) -> CoordinatorFuture<'_, Result<(), String>> {
            self.inner.rollback_cancelled_prepare(updated_at)
        }
    }

    struct FakeCache {
        events: Arc<Mutex<Vec<&'static str>>>,
        artifact: VerifiedInstallerArtifact,
    }

    impl UpdateInstallCachePort for FakeCache {
        fn inspect_exact<'a>(
            &'a self,
            _expected: &'a InstallAttemptArtifactIdentity,
        ) -> CoordinatorFuture<'a, Result<VerifiedInstallerArtifact, CacheRecoveryFault>> {
            Box::pin(async move {
                self.events.lock().unwrap().push("cache.revalidate");
                Ok(self.artifact.clone())
            })
        }
    }

    struct BlockingFirstCache {
        events: Arc<Mutex<Vec<&'static str>>>,
        artifact: VerifiedInstallerArtifact,
        block_first: AtomicBool,
        entered: Arc<tokio::sync::Notify>,
    }

    impl UpdateInstallCachePort for BlockingFirstCache {
        fn inspect_exact<'a>(
            &'a self,
            _expected: &'a InstallAttemptArtifactIdentity,
        ) -> CoordinatorFuture<'a, Result<VerifiedInstallerArtifact, CacheRecoveryFault>> {
            Box::pin(async move {
                self.events.lock().unwrap().push("cache.revalidate");
                if self.block_first.swap(false, Ordering::SeqCst) {
                    self.entered.notify_one();
                    std::future::pending::<()>().await;
                }
                Ok(self.artifact.clone())
            })
        }
    }

    struct FakeAttempts {
        events: Arc<Mutex<Vec<&'static str>>>,
        store: InstallAttemptStore,
    }

    impl UpdateInstallAttemptPort for FakeAttempts {
        fn publish(&self, input: InstallAttemptInput) -> Result<InstallAttemptMarkerV1, String> {
            self.events.lock().unwrap().push("marker.publish");
            self.store
                .publish(input)
                .map_err(|error| error.code().to_owned())
        }

        fn tombstone_pre_spawn_abort(
            &self,
            marker: &InstallAttemptMarkerV1,
            aborted_at: u64,
        ) -> Result<InstallAttemptReconciliationV1, String> {
            self.events.lock().unwrap().push("marker.tombstone");
            self.store
                .tombstone_pre_spawn_abort(marker, aborted_at)
                .map_err(|error| error.code().to_owned())
        }

        fn consume(&self, reconciliation: &InstallAttemptReconciliationV1) -> Result<(), String> {
            self.events.lock().unwrap().push("marker.consume");
            self.store
                .consume_reconciliation(reconciliation)
                .map(|_| ())
                .map_err(|error| error.code().to_owned())
        }
    }

    struct FakeNativeOwners {
        events: Arc<Mutex<Vec<&'static str>>>,
        prepare_blocker: Option<Arc<PrepareBlocker>>,
    }

    struct PrepareBlocker {
        entered: tokio::sync::Notify,
        release: Mutex<bool>,
        released: Condvar,
    }

    impl PrepareBlocker {
        fn new() -> Self {
            Self {
                entered: tokio::sync::Notify::new(),
                release: Mutex::new(false),
                released: Condvar::new(),
            }
        }

        fn wait(&self) {
            self.entered.notify_one();
            let mut released = self.release.lock().unwrap();
            while !*released {
                released = self.released.wait(released).unwrap();
            }
        }

        fn release(&self) {
            *self.release.lock().unwrap() = true;
            self.released.notify_all();
        }
    }

    impl FakeNativeOwners {
        fn receipt(
            operation: &UpdateInstallGateClaim,
            stage: NativeInstallStage,
        ) -> NativeOwnerReceipt {
            NativeOwnerReceipt::exact(operation, stage, format!("receipt-{stage:?}"))
        }
    }

    impl NativeInstallOwnerPort for FakeNativeOwners {
        fn acquire_transition(
            &self,
            operation: &UpdateInstallGateClaim,
        ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
            self.events.lock().unwrap().push("native.prepare");
            if let Some(blocker) = &self.prepare_blocker {
                blocker.wait();
            }
            Ok(Self::receipt(operation, NativeInstallStage::Transition))
        }

        fn disable_full_desktop_without_persisting_preference(
            &self,
            operation: &UpdateInstallGateClaim,
        ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
            Ok(Self::receipt(operation, NativeInstallStage::FullDesktop))
        }

        fn capture_and_stop_wallpaper(
            &self,
            operation: &UpdateInstallGateClaim,
        ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
            Ok(Self::receipt(operation, NativeInstallStage::Wallpaper))
        }

        fn stop_and_join_desktop_lyrics_worker(
            &self,
            operation: &UpdateInstallGateClaim,
        ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
            Ok(Self::receipt(operation, NativeInstallStage::DesktopLyrics))
        }

        fn verify_prepared(
            &self,
            _operation: &UpdateInstallGateClaim,
            _receipts: &[NativeOwnerReceipt],
        ) -> Result<(), NativeOwnerError> {
            Ok(())
        }

        fn rollback_owner(
            &self,
            _operation: &UpdateInstallGateClaim,
            _receipt: &NativeOwnerReceipt,
        ) -> Result<(), NativeOwnerError> {
            self.events.lock().unwrap().push("native.rollback");
            Ok(())
        }

        fn verify_rollback(
            &self,
            _operation: &UpdateInstallGateClaim,
        ) -> Result<(), NativeOwnerError> {
            Ok(())
        }
    }

    struct FakeExitCapability {
        events: Arc<Mutex<Vec<&'static str>>>,
    }

    impl InfallibleInstallExitCapability for FakeExitCapability {
        fn exit_after_installer_spawn(self: Box<Self>) {
            self.events.lock().unwrap().push("exit.commit");
        }
    }

    struct FakeExitOwners {
        events: Arc<Mutex<Vec<&'static str>>>,
        fail_seal: bool,
        fail_release_once: AtomicBool,
    }

    impl InstallExitOwnershipPort for FakeExitOwners {
        fn prepare_update_exit(
            &self,
            operation: &UpdateInstallGateClaim,
        ) -> Result<InstallExitOwnershipReceipt, InstallExitOwnershipError> {
            self.events.lock().unwrap().push("exit.prepare");
            Ok(InstallExitOwnershipReceipt::exact(
                operation,
                "exit-receipt",
            ))
        }

        fn seal_update_exit(
            &self,
            _operation: &UpdateInstallGateClaim,
            _receipt: &InstallExitOwnershipReceipt,
        ) -> Result<Box<dyn InfallibleInstallExitCapability>, InstallExitOwnershipError> {
            self.events.lock().unwrap().push("exit.seal");
            if self.fail_seal {
                return Err(InstallExitOwnershipError::new(
                    "UPDATE_EXIT_SEAL_INJECTED_FAILURE",
                ));
            }
            Ok(Box::new(FakeExitCapability {
                events: Arc::clone(&self.events),
            }))
        }

        fn release_update_exit(
            &self,
            _operation: &UpdateInstallGateClaim,
            _receipt: &InstallExitOwnershipReceipt,
        ) -> Result<(), InstallExitOwnershipError> {
            self.events.lock().unwrap().push("exit.release");
            if self.fail_release_once.swap(false, Ordering::SeqCst) {
                return Err(InstallExitOwnershipError::new(
                    "UPDATE_EXIT_RELEASE_INJECTED_FAILURE",
                ));
            }
            Ok(())
        }

        fn retain_recovery_required(&self, _evidence: InstallExitRecoveryEvidence) {}
    }

    struct FakeSpawn {
        events: Arc<Mutex<Vec<&'static str>>>,
        fail: bool,
    }

    impl NsisInstallerSpawnPort for FakeSpawn {
        fn spawn(&self, _request: NsisSpawnRequest<'_>) -> Result<(), NsisSpawnPortError> {
            self.events.lock().unwrap().push("installer.spawn");
            if self.fail {
                Err(NsisSpawnPortError::new())
            } else {
                Ok(())
            }
        }
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "mineradio-install-coordinator-{label}-{}-{unique}",
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

    #[cfg(windows)]
    #[test]
    fn exact_install_follows_the_only_irreversible_order() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let root = TestDirectory::new("happy");
        let candidate_id = ReleaseCandidateId::parse("d".repeat(64)).unwrap();
        let installer_path = std::env::temp_dir()
            .join("mineradio-coordinator-happy")
            .join("installer.exe");
        let artifact = VerifiedInstallerArtifact::fake_at(candidate_id, installer_path);
        let native = NativeInstallQuiescence::new(
            super::super::update_install_gate::UpdateInstallGate::default(),
            Arc::new(FakeNativeOwners {
                events: Arc::clone(&events),
                prepare_blocker: None,
            }),
        );
        let coordinator = UpdateInstallCoordinator::new(
            Arc::new(FakeWeb {
                events: Arc::clone(&events),
            }),
            native,
            Arc::new(FakeCache {
                events: Arc::clone(&events),
                artifact: artifact.clone(),
            }),
            Arc::new(FakeAttempts {
                events: Arc::clone(&events),
                store: InstallAttemptStore::with_updater_directory(&root.0),
            }),
            Arc::new(FakeExitOwners {
                events: Arc::clone(&events),
                fail_seal: false,
                fail_release_once: AtomicBool::new(false),
            }),
            Arc::new(FakeSpawn {
                events: Arc::clone(&events),
                fail: false,
            }),
            LocalRelaunchArguments::none_for_test(),
            Duration::from_secs(1),
        );

        let outcome = tauri::async_runtime::block_on(coordinator.install_exact(
            artifact.candidate_id().as_str().to_owned(),
            artifact,
            100,
        ))
        .expect("exact verified install 应成功");

        assert_eq!(outcome, UpdateInstallCoordinatorOutcome::InstallerSpawned);
        assert_eq!(
            events.lock().unwrap().as_slice(),
            [
                "web.prepare",
                "native.prepare",
                "cache.revalidate",
                "marker.publish",
                "web.seal",
                "exit.prepare",
                "exit.seal",
                "installer.spawn",
                "exit.commit",
            ]
        );
        assert_eq!(
            coordinator.phase(),
            UpdateInstallCoordinatorPhase::InstallerSpawned
        );
    }

    #[cfg(windows)]
    #[test]
    fn spawn_failure_tombstones_before_releasing_owned_runtime_and_restores_web() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let root = TestDirectory::new("spawn-failure");
        let candidate_id = ReleaseCandidateId::parse("d".repeat(64)).unwrap();
        let installer_path = std::env::temp_dir()
            .join("mineradio-coordinator-spawn-failure")
            .join("installer.exe");
        let artifact = VerifiedInstallerArtifact::fake_at(candidate_id, installer_path);
        let native = NativeInstallQuiescence::new(
            super::super::update_install_gate::UpdateInstallGate::default(),
            Arc::new(FakeNativeOwners {
                events: Arc::clone(&events),
                prepare_blocker: None,
            }),
        );
        let coordinator = UpdateInstallCoordinator::new(
            Arc::new(FakeWeb {
                events: Arc::clone(&events),
            }),
            native,
            Arc::new(FakeCache {
                events: Arc::clone(&events),
                artifact: artifact.clone(),
            }),
            Arc::new(FakeAttempts {
                events: Arc::clone(&events),
                store: InstallAttemptStore::with_updater_directory(&root.0),
            }),
            Arc::new(FakeExitOwners {
                events: Arc::clone(&events),
                fail_seal: false,
                fail_release_once: AtomicBool::new(false),
            }),
            Arc::new(FakeSpawn {
                events: Arc::clone(&events),
                fail: true,
            }),
            LocalRelaunchArguments::none_for_test(),
            Duration::from_secs(1),
        );

        let fault = tauri::async_runtime::block_on(coordinator.install_exact(
            artifact.candidate_id().as_str().to_owned(),
            artifact,
            100,
        ))
        .expect_err("spawn failure 必须返回 typed fault");

        assert_eq!(fault.stage, UpdateInstallCoordinatorStage::InstallerSpawn);
        assert_eq!(fault.code, "UPDATE_INSTALL_SPAWN_FAILED");
        assert!(!fault.recovery_required);
        assert_eq!(coordinator.phase(), UpdateInstallCoordinatorPhase::Idle);
        assert_eq!(
            events.lock().unwrap().as_slice(),
            [
                "web.prepare",
                "native.prepare",
                "cache.revalidate",
                "marker.publish",
                "web.seal",
                "exit.prepare",
                "exit.seal",
                "installer.spawn",
                "marker.tombstone",
                "exit.release",
                "native.rollback",
                "native.rollback",
                "native.rollback",
                "native.rollback",
                "web.mark-rollback",
                "web.confirm-native",
                "web.rollback",
                "cache.revalidate",
                "marker.consume",
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn seal_failure_tombstones_before_consuming_owned_recovery() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let root = TestDirectory::new("seal-failure");
        let candidate_id = ReleaseCandidateId::parse("d".repeat(64)).unwrap();
        let installer_path = std::env::temp_dir()
            .join("mineradio-coordinator-seal-failure")
            .join("installer.exe");
        let artifact = VerifiedInstallerArtifact::fake_at(candidate_id, installer_path);
        let native = NativeInstallQuiescence::new(
            super::super::update_install_gate::UpdateInstallGate::default(),
            Arc::new(FakeNativeOwners {
                events: Arc::clone(&events),
                prepare_blocker: None,
            }),
        );
        let coordinator = UpdateInstallCoordinator::new(
            Arc::new(FakeWeb {
                events: Arc::clone(&events),
            }),
            native,
            Arc::new(FakeCache {
                events: Arc::clone(&events),
                artifact: artifact.clone(),
            }),
            Arc::new(FakeAttempts {
                events: Arc::clone(&events),
                store: InstallAttemptStore::with_updater_directory(&root.0),
            }),
            Arc::new(FakeExitOwners {
                events: Arc::clone(&events),
                fail_seal: true,
                fail_release_once: AtomicBool::new(false),
            }),
            Arc::new(FakeSpawn {
                events: Arc::clone(&events),
                fail: false,
            }),
            LocalRelaunchArguments::none_for_test(),
            Duration::from_secs(1),
        );

        let fault = tauri::async_runtime::block_on(coordinator.install_exact(
            artifact.candidate_id().as_str().to_owned(),
            artifact,
            100,
        ))
        .expect_err("seal failure 必须返回 typed fault");

        assert_eq!(fault.stage, UpdateInstallCoordinatorStage::ExitSeal);
        assert_eq!(fault.code, "UPDATE_EXIT_SEAL_INJECTED_FAILURE");
        assert!(!fault.recovery_required);
        assert_eq!(coordinator.phase(), UpdateInstallCoordinatorPhase::Idle);
        assert_eq!(
            events.lock().unwrap().as_slice(),
            [
                "web.prepare",
                "native.prepare",
                "cache.revalidate",
                "marker.publish",
                "web.seal",
                "exit.prepare",
                "exit.seal",
                "marker.tombstone",
                "exit.release",
                "native.rollback",
                "native.rollback",
                "native.rollback",
                "native.rollback",
                "web.mark-rollback",
                "web.confirm-native",
                "web.rollback",
                "cache.revalidate",
                "marker.consume",
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn retry_recovery_keeps_owned_exit_and_resumes_after_transient_release_failure() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let root = TestDirectory::new("retry-owned-exit");
        let candidate_id = ReleaseCandidateId::parse("d".repeat(64)).unwrap();
        let installer_path = std::env::temp_dir()
            .join("mineradio-coordinator-retry-owned-exit")
            .join("installer.exe");
        let artifact = VerifiedInstallerArtifact::fake_at(candidate_id, installer_path);
        let native = NativeInstallQuiescence::new(
            super::super::update_install_gate::UpdateInstallGate::default(),
            Arc::new(FakeNativeOwners {
                events: Arc::clone(&events),
                prepare_blocker: None,
            }),
        );
        let coordinator = UpdateInstallCoordinator::new(
            Arc::new(FakeWeb {
                events: Arc::clone(&events),
            }),
            native,
            Arc::new(FakeCache {
                events: Arc::clone(&events),
                artifact: artifact.clone(),
            }),
            Arc::new(FakeAttempts {
                events: Arc::clone(&events),
                store: InstallAttemptStore::with_updater_directory(&root.0),
            }),
            Arc::new(FakeExitOwners {
                events: Arc::clone(&events),
                fail_seal: false,
                fail_release_once: AtomicBool::new(true),
            }),
            Arc::new(FakeSpawn {
                events: Arc::clone(&events),
                fail: true,
            }),
            LocalRelaunchArguments::none_for_test(),
            Duration::from_secs(1),
        );

        let fault = tauri::async_runtime::block_on(coordinator.install_exact(
            artifact.candidate_id().as_str().to_owned(),
            artifact,
            100,
        ))
        .expect_err("首次 release failure 必须保留 recovery ownership");
        assert_eq!(fault.stage, UpdateInstallCoordinatorStage::InstallerSpawn);
        assert!(fault.recovery_required);
        assert_eq!(
            coordinator.phase(),
            UpdateInstallCoordinatorPhase::RecoveryRequired
        );

        let recovered = tauri::async_runtime::block_on(coordinator.retry_recovery(101))
            .expect("重试必须从保留的 owned exit 继续恢复");
        assert_eq!(
            recovered,
            UpdateInstallCoordinatorOutcome::RecoveryCompleted
        );
        assert_eq!(coordinator.phase(), UpdateInstallCoordinatorPhase::Idle);
        assert_eq!(
            events.lock().unwrap().as_slice(),
            [
                "web.prepare",
                "native.prepare",
                "cache.revalidate",
                "marker.publish",
                "web.seal",
                "exit.prepare",
                "exit.seal",
                "installer.spawn",
                "marker.tombstone",
                "exit.release",
                "exit.release",
                "native.rollback",
                "native.rollback",
                "native.rollback",
                "native.rollback",
                "web.mark-rollback",
                "web.confirm-native",
                "web.rollback",
                "cache.revalidate",
                "marker.consume",
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn cancelled_cache_revalidation_keeps_native_lease_for_explicit_recovery() {
        tauri::async_runtime::block_on(async {
            let events = Arc::new(Mutex::new(Vec::new()));
            let root = TestDirectory::new("cancelled-cache");
            let candidate_id = ReleaseCandidateId::parse("d".repeat(64)).unwrap();
            let installer_path = std::env::temp_dir()
                .join("mineradio-coordinator-cancelled-cache")
                .join("installer.exe");
            let artifact = VerifiedInstallerArtifact::fake_at(candidate_id, installer_path);
            let entered = Arc::new(tokio::sync::Notify::new());
            let native = NativeInstallQuiescence::new(
                super::super::update_install_gate::UpdateInstallGate::default(),
                Arc::new(FakeNativeOwners {
                    events: Arc::clone(&events),
                    prepare_blocker: None,
                }),
            );
            let coordinator = Arc::new(UpdateInstallCoordinator::new(
                Arc::new(FakeWeb {
                    events: Arc::clone(&events),
                }),
                native,
                Arc::new(BlockingFirstCache {
                    events: Arc::clone(&events),
                    artifact: artifact.clone(),
                    block_first: AtomicBool::new(true),
                    entered: Arc::clone(&entered),
                }),
                Arc::new(FakeAttempts {
                    events: Arc::clone(&events),
                    store: InstallAttemptStore::with_updater_directory(&root.0),
                }),
                Arc::new(FakeExitOwners {
                    events: Arc::clone(&events),
                    fail_seal: false,
                    fail_release_once: AtomicBool::new(false),
                }),
                Arc::new(FakeSpawn {
                    events: Arc::clone(&events),
                    fail: false,
                }),
                LocalRelaunchArguments::none_for_test(),
                Duration::from_secs(1),
            ));

            let worker = Arc::clone(&coordinator);
            let install_artifact = artifact.clone();
            let install = tauri::async_runtime::spawn(async move {
                worker
                    .install_exact(
                        install_artifact.candidate_id().as_str().to_owned(),
                        install_artifact,
                        100,
                    )
                    .await
            });
            entered.notified().await;
            install.abort();
            let _ = install.await;

            assert_eq!(
                coordinator.phase(),
                UpdateInstallCoordinatorPhase::Preparing
            );
            let recovered = coordinator
                .retry_recovery(101)
                .await
                .expect("取消后的显式恢复必须消费保留的 native lease");
            assert_eq!(
                recovered,
                UpdateInstallCoordinatorOutcome::RecoveryCompleted
            );
            assert_eq!(coordinator.phase(), UpdateInstallCoordinatorPhase::Idle);
            assert_eq!(
                events.lock().unwrap().as_slice(),
                [
                    "web.prepare",
                    "native.prepare",
                    "cache.revalidate",
                    "native.rollback",
                    "native.rollback",
                    "native.rollback",
                    "native.rollback",
                    "web.mark-rollback",
                    "web.confirm-native",
                    "web.rollback",
                ]
            );
        });
    }

    #[cfg(windows)]
    #[test]
    fn cancelled_native_prepare_task_transfers_completed_lease_to_retry_recovery() {
        tauri::async_runtime::block_on(async {
            let events = Arc::new(Mutex::new(Vec::new()));
            let root = TestDirectory::new("cancelled-native-prepare");
            let candidate_id = ReleaseCandidateId::parse("d".repeat(64)).unwrap();
            let installer_path = std::env::temp_dir()
                .join("mineradio-coordinator-cancelled-native-prepare")
                .join("installer.exe");
            let artifact = VerifiedInstallerArtifact::fake_at(candidate_id, installer_path);
            let blocker = Arc::new(PrepareBlocker::new());
            let native = NativeInstallQuiescence::new(
                super::super::update_install_gate::UpdateInstallGate::default(),
                Arc::new(FakeNativeOwners {
                    events: Arc::clone(&events),
                    prepare_blocker: Some(Arc::clone(&blocker)),
                }),
            );
            let coordinator = Arc::new(UpdateInstallCoordinator::new(
                Arc::new(FakeWeb {
                    events: Arc::clone(&events),
                }),
                native,
                Arc::new(FakeCache {
                    events: Arc::clone(&events),
                    artifact: artifact.clone(),
                }),
                Arc::new(FakeAttempts {
                    events: Arc::clone(&events),
                    store: InstallAttemptStore::with_updater_directory(&root.0),
                }),
                Arc::new(FakeExitOwners {
                    events: Arc::clone(&events),
                    fail_seal: false,
                    fail_release_once: AtomicBool::new(false),
                }),
                Arc::new(FakeSpawn {
                    events: Arc::clone(&events),
                    fail: false,
                }),
                LocalRelaunchArguments::none_for_test(),
                Duration::from_secs(1),
            ));

            let worker = Arc::clone(&coordinator);
            let install_artifact = artifact.clone();
            let install = tauri::async_runtime::spawn(async move {
                worker
                    .install_exact(
                        install_artifact.candidate_id().as_str().to_owned(),
                        install_artifact,
                        100,
                    )
                    .await
            });
            blocker.entered.notified().await;
            install.abort();
            let _ = install.await;
            blocker.release();

            let recovered = coordinator
                .retry_recovery(101)
                .await
                .expect("后台完成的 native lease 必须由 retry 接管并恢复");
            assert_eq!(
                recovered,
                UpdateInstallCoordinatorOutcome::RecoveryCompleted
            );
            assert_eq!(coordinator.phase(), UpdateInstallCoordinatorPhase::Idle);
            assert_eq!(
                events.lock().unwrap().as_slice(),
                [
                    "web.prepare",
                    "native.prepare",
                    "native.rollback",
                    "native.rollback",
                    "native.rollback",
                    "native.rollback",
                    "web.mark-rollback",
                    "web.confirm-native",
                    "web.rollback",
                ]
            );
        });
    }

    #[cfg(windows)]
    #[test]
    fn cancelled_web_exit_ack_tombstones_marker_before_releasing_native_lease() {
        tauri::async_runtime::block_on(async {
            let events = Arc::new(Mutex::new(Vec::new()));
            let root = TestDirectory::new("cancelled-web-exit-ack");
            let candidate_id = ReleaseCandidateId::parse("d".repeat(64)).unwrap();
            let installer_path = std::env::temp_dir()
                .join("mineradio-coordinator-cancelled-web-exit-ack")
                .join("installer.exe");
            let artifact = VerifiedInstallerArtifact::fake_at(candidate_id, installer_path);
            let entered = Arc::new(tokio::sync::Notify::new());
            let native = NativeInstallQuiescence::new(
                super::super::update_install_gate::UpdateInstallGate::default(),
                Arc::new(FakeNativeOwners {
                    events: Arc::clone(&events),
                    prepare_blocker: None,
                }),
            );
            let coordinator = Arc::new(UpdateInstallCoordinator::new(
                Arc::new(BlockingSealWeb {
                    inner: FakeWeb {
                        events: Arc::clone(&events),
                    },
                    entered: Arc::clone(&entered),
                }),
                native,
                Arc::new(FakeCache {
                    events: Arc::clone(&events),
                    artifact: artifact.clone(),
                }),
                Arc::new(FakeAttempts {
                    events: Arc::clone(&events),
                    store: InstallAttemptStore::with_updater_directory(&root.0),
                }),
                Arc::new(FakeExitOwners {
                    events: Arc::clone(&events),
                    fail_seal: false,
                    fail_release_once: AtomicBool::new(false),
                }),
                Arc::new(FakeSpawn {
                    events: Arc::clone(&events),
                    fail: false,
                }),
                LocalRelaunchArguments::none_for_test(),
                Duration::from_secs(1),
            ));

            let worker = Arc::clone(&coordinator);
            let install_artifact = artifact.clone();
            let install = tauri::async_runtime::spawn(async move {
                worker
                    .install_exact(
                        install_artifact.candidate_id().as_str().to_owned(),
                        install_artifact,
                        100,
                    )
                    .await
            });
            entered.notified().await;
            install.abort();
            let _ = install.await;

            let recovered = coordinator
                .retry_recovery(101)
                .await
                .expect("marker 发布后的取消必须先 tombstone 再恢复");
            assert_eq!(
                recovered,
                UpdateInstallCoordinatorOutcome::RecoveryCompleted
            );
            assert_eq!(coordinator.phase(), UpdateInstallCoordinatorPhase::Idle);
            assert_eq!(
                events.lock().unwrap().as_slice(),
                [
                    "web.prepare",
                    "native.prepare",
                    "cache.revalidate",
                    "marker.publish",
                    "web.seal",
                    "marker.tombstone",
                    "native.rollback",
                    "native.rollback",
                    "native.rollback",
                    "native.rollback",
                    "web.mark-rollback",
                    "web.confirm-native",
                    "web.rollback",
                    "cache.revalidate",
                    "marker.consume",
                ]
            );
        });
    }
}
