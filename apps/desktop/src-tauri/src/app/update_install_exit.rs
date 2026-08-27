use std::{fmt, sync::Arc};

use tauri::Manager;

use crate::AppState;

use super::{
    update_install_gate::UpdateInstallGateClaim,
    update_install_quiescence::{NativeInstallLease, NativeInstallStage},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InstallExitStage {
    PreparedLease,
    OwnershipPrepare,
    OwnershipSeal,
    OwnershipRelease,
    NativeRollback,
}

impl InstallExitStage {
    fn name(self) -> &'static str {
        match self {
            Self::PreparedLease => "prepared-lease",
            Self::OwnershipPrepare => "ownership-prepare",
            Self::OwnershipSeal => "ownership-seal",
            Self::OwnershipRelease => "ownership-release",
            Self::NativeRollback => "native-rollback",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallExitOwnershipError {
    code: String,
}

impl InstallExitOwnershipError {
    pub(crate) fn new(code: impl Into<String>) -> Self {
        let code = code.into();
        let code = if valid_stable_code(&code) {
            code
        } else {
            "INSTALL_EXIT_OWNER_FAILED".to_owned()
        };
        Self { code }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallExitError {
    pub stage: InstallExitStage,
    pub code: String,
}

impl InstallExitError {
    fn stable(stage: InstallExitStage, code: &'static str) -> Self {
        Self {
            stage,
            code: code.to_owned(),
        }
    }

    fn owner(stage: InstallExitStage, error: InstallExitOwnershipError) -> Self {
        Self {
            stage,
            code: error.code,
        }
    }
}

impl fmt::Display for InstallExitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}:{}", self.stage.name(), self.code)
    }
}

impl std::error::Error for InstallExitError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallExitOwnershipReceipt {
    operation: UpdateInstallGateClaim,
    token: String,
}

impl InstallExitOwnershipReceipt {
    pub(crate) fn exact(operation: &UpdateInstallGateClaim, token: impl Into<String>) -> Self {
        Self {
            operation: operation.clone(),
            token: token.into(),
        }
    }

    fn is_exact_for(&self, operation: &UpdateInstallGateClaim) -> bool {
        &self.operation == operation && valid_receipt_token(&self.token)
    }
}

pub trait InfallibleInstallExitCapability: Send {
    /// 实现只能调用预先取得的退出 capability；不得等待、加锁或执行清理。
    fn exit_after_installer_spawn(self: Box<Self>);
}

pub trait InstallExitOwnershipPort: Send + Sync {
    fn prepare_update_exit(
        &self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<InstallExitOwnershipReceipt, InstallExitOwnershipError>;

    fn seal_update_exit(
        &self,
        operation: &UpdateInstallGateClaim,
        receipt: &InstallExitOwnershipReceipt,
    ) -> Result<Box<dyn InfallibleInstallExitCapability>, InstallExitOwnershipError>;

    fn release_update_exit(
        &self,
        operation: &UpdateInstallGateClaim,
        receipt: &InstallExitOwnershipReceipt,
    ) -> Result<(), InstallExitOwnershipError>;

    /// Drop 只能把 exact ownership 推进为 recovery-required；不得假装 rollback 成功。
    fn retain_recovery_required(&self, evidence: InstallExitRecoveryEvidence);
}

#[derive(Clone)]
pub(crate) struct TauriInstallExitOwnership {
    app: tauri::AppHandle,
}

impl TauriInstallExitOwnership {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    fn with_window_runtime<T>(
        &self,
        action: impl FnOnce(&mut crate::runtime::window::WindowRuntimeState) -> T,
    ) -> Result<T, InstallExitOwnershipError> {
        let state = self.app.state::<AppState>();
        let mut runtime = state.window_runtime.lock().map_err(|_| {
            InstallExitOwnershipError::new("UPDATE_EXIT_LIFECYCLE_LOCK_UNAVAILABLE")
        })?;
        Ok(action(&mut runtime))
    }
}

struct TauriInfallibleExitCapability {
    app: tauri::AppHandle,
}

impl InfallibleInstallExitCapability for TauriInfallibleExitCapability {
    fn exit_after_installer_spawn(self: Box<Self>) {
        // installer spawn 是最后不可逆动作。所有 Tauri/native cleanup 已在 seal 前
        // 完成；这里不能再进入 event loop、取得锁或触发可失败 cleanup。
        let _ = self.app;
        std::process::exit(0);
    }
}

impl InstallExitOwnershipPort for TauriInstallExitOwnership {
    fn prepare_update_exit(
        &self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<InstallExitOwnershipReceipt, InstallExitOwnershipError> {
        let token = random_receipt_token()?;
        let prepared = self.with_window_runtime(|runtime| {
            runtime.prepare_update_exit(operation.operation_id(), operation.generation(), &token)
        })?;
        if !prepared {
            return Err(InstallExitOwnershipError::new(
                "UPDATE_EXIT_LIFECYCLE_OWNERSHIP_UNAVAILABLE",
            ));
        }
        Ok(InstallExitOwnershipReceipt::exact(operation, token))
    }

    fn seal_update_exit(
        &self,
        operation: &UpdateInstallGateClaim,
        receipt: &InstallExitOwnershipReceipt,
    ) -> Result<Box<dyn InfallibleInstallExitCapability>, InstallExitOwnershipError> {
        if !receipt.is_exact_for(operation) {
            return Err(InstallExitOwnershipError::new(
                "INSTALL_EXIT_RECEIPT_INVALID",
            ));
        }
        let sealed = self.with_window_runtime(|runtime| {
            runtime.seal_update_exit(
                operation.operation_id(),
                operation.generation(),
                &receipt.token,
            )
        })?;
        if !sealed {
            return Err(InstallExitOwnershipError::new(
                "UPDATE_EXIT_LIFECYCLE_SEAL_REJECTED",
            ));
        }
        Ok(Box::new(TauriInfallibleExitCapability {
            app: self.app.clone(),
        }))
    }

    fn release_update_exit(
        &self,
        operation: &UpdateInstallGateClaim,
        receipt: &InstallExitOwnershipReceipt,
    ) -> Result<(), InstallExitOwnershipError> {
        if !receipt.is_exact_for(operation) {
            return Err(InstallExitOwnershipError::new(
                "INSTALL_EXIT_RECEIPT_INVALID",
            ));
        }
        let released = self.with_window_runtime(|runtime| {
            runtime.release_update_exit(
                operation.operation_id(),
                operation.generation(),
                &receipt.token,
            )
        })?;
        released
            .then_some(())
            .ok_or_else(|| InstallExitOwnershipError::new("UPDATE_EXIT_LIFECYCLE_RELEASE_REJECTED"))
    }

    fn retain_recovery_required(&self, evidence: InstallExitRecoveryEvidence) {
        let Some(receipt) = evidence.exit_receipt else {
            return;
        };
        let _ = self.with_window_runtime(|runtime| {
            runtime.retain_update_exit_recovery(
                &evidence.operation_id,
                evidence.operation_generation,
                &receipt,
            )
        });
    }
}

fn random_receipt_token() -> Result<String, InstallExitOwnershipError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| InstallExitOwnershipError::new("UPDATE_EXIT_RECEIPT_RANDOM_FAILED"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallExitRecoveryEvidence {
    pub operation_id: String,
    pub operation_generation: u64,
    pub exit_receipt: Option<String>,
    pub prepared_stages: Vec<NativeInstallStage>,
}

impl InstallExitRecoveryEvidence {
    fn exact(
        operation: &UpdateInstallGateClaim,
        receipt: Option<&InstallExitOwnershipReceipt>,
        prepared_stages: Vec<NativeInstallStage>,
    ) -> Self {
        Self {
            operation_id: operation.operation_id().to_owned(),
            operation_generation: operation.generation(),
            exit_receipt: receipt.map(|receipt| receipt.token.clone()),
            prepared_stages,
        }
    }
}

#[must_use = "sealed install exit 必须 commit 或显式 rollback"]
pub struct SealedInstallExit {
    operation: UpdateInstallGateClaim,
    exit_owners: Arc<dyn InstallExitOwnershipPort>,
    exit_receipt: Option<InstallExitOwnershipReceipt>,
    native_lease: Option<NativeInstallLease>,
    exit_capability: Option<Box<dyn InfallibleInstallExitCapability>>,
    disposition: SealedInstallExitDisposition,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SealedInstallExitDisposition {
    Sealed,
    Committed,
    RecoveryTransferred,
}

impl fmt::Debug for SealedInstallExit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealedInstallExit")
            .field("operation", &self.operation)
            .field("disposition", &self.disposition)
            .finish_non_exhaustive()
    }
}

impl SealedInstallExit {
    pub fn operation(&self) -> &UpdateInstallGateClaim {
        &self.operation
    }

    pub fn commit_after_spawn(mut self) {
        // 从这里开始禁止调用 Port 或 Native lease；所有可失败工作都已在 seal 完成。
        self.disposition = SealedInstallExitDisposition::Committed;
        let capability = self
            .exit_capability
            .take()
            .expect("sealed exit 必须持有预先取得的 infallible capability");
        let _ = self.exit_receipt.take();
        let _ = self.native_lease.take();
        capability.exit_after_installer_spawn();
    }

    pub fn rollback_before_spawn(
        mut self,
        expected_operation: &UpdateInstallGateClaim,
    ) -> Result<InstallExitRollbackOutcome, InstallExitRollbackFailure> {
        self.disposition = SealedInstallExitDisposition::RecoveryTransferred;
        let recovery = InstallExitRecovery {
            operation: self.operation.clone(),
            exit_owners: Arc::clone(&self.exit_owners),
            exit_receipt: self.exit_receipt.take(),
            native_lease: self.native_lease.take(),
            resolved: false,
        };
        self.exit_capability = None;
        recovery.rollback_before_spawn(expected_operation)
    }
}

impl Drop for SealedInstallExit {
    fn drop(&mut self) {
        if self.disposition != SealedInstallExitDisposition::Sealed {
            return;
        }
        let Some(lease) = &self.native_lease else {
            return;
        };
        self.exit_owners
            .retain_recovery_required(InstallExitRecoveryEvidence::exact(
                &self.operation,
                self.exit_receipt.as_ref(),
                lease.prepared_stages(),
            ));
    }
}

#[derive(Debug)]
pub struct InstallExitSealFailure {
    pub error: InstallExitError,
    pub rollback_error: Option<InstallExitError>,
    pub recovery: Option<Box<InstallExitRecovery>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InstallExitRollbackOutcome {
    Restored,
}

#[derive(Debug)]
pub struct InstallExitRollbackFailure {
    pub error: InstallExitError,
    pub recovery: Box<InstallExitRecovery>,
}

#[must_use = "install exit recovery 必须显式 rollback"]
pub struct InstallExitRecovery {
    operation: UpdateInstallGateClaim,
    exit_owners: Arc<dyn InstallExitOwnershipPort>,
    exit_receipt: Option<InstallExitOwnershipReceipt>,
    native_lease: Option<NativeInstallLease>,
    resolved: bool,
}

impl fmt::Debug for InstallExitRecovery {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InstallExitRecovery")
            .field("operation", &self.operation)
            .field("has_exit_receipt", &self.exit_receipt.is_some())
            .field("has_native_lease", &self.native_lease.is_some())
            .field("resolved", &self.resolved)
            .finish_non_exhaustive()
    }
}

impl InstallExitRecovery {
    pub fn operation(&self) -> &UpdateInstallGateClaim {
        &self.operation
    }

    pub fn rollback_before_spawn(
        mut self,
        expected_operation: &UpdateInstallGateClaim,
    ) -> Result<InstallExitRollbackOutcome, InstallExitRollbackFailure> {
        if expected_operation != &self.operation {
            return Err(InstallExitRollbackFailure {
                error: InstallExitError::stable(
                    InstallExitStage::PreparedLease,
                    "UPDATE_INSTALL_CLAIM_STALE",
                ),
                recovery: Box::new(self),
            });
        }

        if let Some(receipt) = self.exit_receipt.as_ref() {
            if let Err(error) = self
                .exit_owners
                .release_update_exit(expected_operation, receipt)
            {
                return Err(InstallExitRollbackFailure {
                    error: InstallExitError::owner(InstallExitStage::OwnershipRelease, error),
                    recovery: Box::new(self),
                });
            }
            self.exit_receipt = None;
        }

        if let Some(lease) = self.native_lease.as_mut() {
            if let Err(error) = lease.rollback_exact(expected_operation) {
                return Err(InstallExitRollbackFailure {
                    error: InstallExitError {
                        stage: InstallExitStage::NativeRollback,
                        code: error.code,
                    },
                    recovery: Box::new(self),
                });
            }
            self.native_lease = None;
        }

        self.resolved = true;
        Ok(InstallExitRollbackOutcome::Restored)
    }
}

impl Drop for InstallExitRecovery {
    fn drop(&mut self) {
        if self.resolved {
            return;
        }
        let prepared_stages = self
            .native_lease
            .as_ref()
            .map(NativeInstallLease::prepared_stages)
            .unwrap_or_default();
        self.exit_owners
            .retain_recovery_required(InstallExitRecoveryEvidence::exact(
                &self.operation,
                self.exit_receipt.as_ref(),
                prepared_stages,
            ));
    }
}

fn preserve_failed_seal(
    error: InstallExitError,
    recovery: InstallExitRecovery,
) -> InstallExitSealFailure {
    // install-attempt marker 已在 seal 前 durable。补偿顺序由上层事务协调器控制：
    // 先发布 exact NotApplied tombstone，再消费这里保留的 ownership 做 rollback。
    InstallExitSealFailure {
        error,
        rollback_error: None,
        recovery: Some(Box::new(recovery)),
    }
}

pub(crate) fn seal_native_install(
    lease: NativeInstallLease,
    expected_operation: &UpdateInstallGateClaim,
    exit_owners: Arc<dyn InstallExitOwnershipPort>,
) -> Result<SealedInstallExit, InstallExitSealFailure> {
    if lease.operation() != expected_operation {
        let actual_operation = lease.operation().clone();
        return Err(InstallExitSealFailure {
            error: InstallExitError::stable(
                InstallExitStage::PreparedLease,
                "UPDATE_INSTALL_CLAIM_STALE",
            ),
            rollback_error: None,
            recovery: Some(Box::new(InstallExitRecovery {
                operation: actual_operation,
                exit_owners,
                exit_receipt: None,
                native_lease: Some(lease),
                resolved: false,
            })),
        });
    }
    if let Err(error) = lease.validate_prepared_exact(expected_operation) {
        return Err(preserve_failed_seal(
            InstallExitError {
                stage: InstallExitStage::PreparedLease,
                code: error.code,
            },
            InstallExitRecovery {
                operation: expected_operation.clone(),
                exit_owners,
                exit_receipt: None,
                native_lease: Some(lease),
                resolved: false,
            },
        ));
    }
    let receipt = match exit_owners.prepare_update_exit(expected_operation) {
        Ok(receipt) => receipt,
        Err(error) => {
            return Err(preserve_failed_seal(
                InstallExitError::owner(InstallExitStage::OwnershipPrepare, error),
                InstallExitRecovery {
                    operation: expected_operation.clone(),
                    exit_owners,
                    exit_receipt: None,
                    native_lease: Some(lease),
                    resolved: false,
                },
            ));
        }
    };
    if !receipt.is_exact_for(expected_operation) {
        return Err(preserve_failed_seal(
            InstallExitError::stable(
                InstallExitStage::OwnershipPrepare,
                "INSTALL_EXIT_RECEIPT_INVALID",
            ),
            InstallExitRecovery {
                operation: expected_operation.clone(),
                exit_owners,
                exit_receipt: Some(receipt),
                native_lease: Some(lease),
                resolved: false,
            },
        ));
    }
    if let Err(error) = lease.recheck_prepared_exact(expected_operation) {
        return Err(preserve_failed_seal(
            InstallExitError {
                stage: InstallExitStage::PreparedLease,
                code: error.code,
            },
            InstallExitRecovery {
                operation: expected_operation.clone(),
                exit_owners,
                exit_receipt: Some(receipt),
                native_lease: Some(lease),
                resolved: false,
            },
        ));
    }
    let capability = match exit_owners.seal_update_exit(expected_operation, &receipt) {
        Ok(capability) => capability,
        Err(error) => {
            return Err(preserve_failed_seal(
                InstallExitError::owner(InstallExitStage::OwnershipSeal, error),
                InstallExitRecovery {
                    operation: expected_operation.clone(),
                    exit_owners,
                    exit_receipt: Some(receipt),
                    native_lease: Some(lease),
                    resolved: false,
                },
            ));
        }
    };
    Ok(SealedInstallExit {
        operation: expected_operation.clone(),
        exit_owners,
        exit_receipt: Some(receipt),
        native_lease: Some(lease),
        exit_capability: Some(capability),
        disposition: SealedInstallExitDisposition::Sealed,
    })
}

fn valid_stable_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn valid_receipt_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.chars().any(|character| character.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{
        update_install_gate::{UpdateInstallGate, UpdateInstallGateClaim},
        update_install_quiescence::{
            NativeInstallLease, NativeInstallOwnerPort, NativeInstallQuiescence,
            NativeInstallStage, NativeOwnerError, NativeOwnerPrepareFailure, NativeOwnerReceipt,
        },
    };
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    struct PreparedOwners {
        calls: Arc<Mutex<Vec<String>>>,
        fail_rollback_once: Mutex<Option<NativeInstallStage>>,
        fail_verify_on_call: Option<usize>,
        verify_calls: Mutex<usize>,
    }

    impl PreparedOwners {
        fn receipt(
            operation: &UpdateInstallGateClaim,
            stage: NativeInstallStage,
        ) -> NativeOwnerReceipt {
            NativeOwnerReceipt::exact(operation, stage, format!("{stage:?}-receipt"))
        }
    }

    impl NativeInstallOwnerPort for PreparedOwners {
        fn acquire_transition(
            &self,
            operation: &UpdateInstallGateClaim,
        ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
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
            let mut calls = self.verify_calls.lock().expect("verify calls");
            *calls += 1;
            if self.fail_verify_on_call == Some(*calls) {
                return Err(NativeOwnerError::new("INJECTED_NATIVE_RECHECK_FAILURE"));
            }
            Ok(())
        }

        fn rollback_owner(
            &self,
            _operation: &UpdateInstallGateClaim,
            receipt: &NativeOwnerReceipt,
        ) -> Result<(), NativeOwnerError> {
            self.calls
                .lock()
                .expect("native calls")
                .push(format!("rollback-{:?}", receipt.stage()));
            let mut failure = self
                .fail_rollback_once
                .lock()
                .expect("native rollback failure");
            if failure.as_ref() == Some(&receipt.stage()) {
                *failure = None;
                return Err(NativeOwnerError::new("INJECTED_NATIVE_ROLLBACK_FAILURE"));
            }
            Ok(())
        }

        fn verify_rollback(
            &self,
            _operation: &UpdateInstallGateClaim,
        ) -> Result<(), NativeOwnerError> {
            self.calls
                .lock()
                .expect("native calls")
                .push("verify-native-rollback".to_owned());
            Ok(())
        }
    }

    struct RecordingExitCapability {
        calls: Arc<Mutex<Vec<&'static str>>>,
    }

    impl InfallibleInstallExitCapability for RecordingExitCapability {
        fn exit_after_installer_spawn(self: Box<Self>) {
            self.calls.lock().expect("calls").push("exit");
        }
    }

    struct RecordingExitOwners {
        calls: Arc<Mutex<Vec<&'static str>>>,
        fail_seal: bool,
        fail_release_once: Mutex<bool>,
    }

    impl InstallExitOwnershipPort for RecordingExitOwners {
        fn prepare_update_exit(
            &self,
            operation: &UpdateInstallGateClaim,
        ) -> Result<InstallExitOwnershipReceipt, InstallExitOwnershipError> {
            self.calls.lock().expect("calls").push("prepare-exit");
            Ok(InstallExitOwnershipReceipt::exact(
                operation,
                "exit-owner-receipt",
            ))
        }

        fn seal_update_exit(
            &self,
            _operation: &UpdateInstallGateClaim,
            _receipt: &InstallExitOwnershipReceipt,
        ) -> Result<Box<dyn InfallibleInstallExitCapability>, InstallExitOwnershipError> {
            self.calls.lock().expect("calls").push("seal-exit");
            if self.fail_seal {
                return Err(InstallExitOwnershipError::new("INJECTED_EXIT_SEAL_FAILURE"));
            }
            Ok(Box::new(RecordingExitCapability {
                calls: Arc::clone(&self.calls),
            }))
        }

        fn release_update_exit(
            &self,
            _operation: &UpdateInstallGateClaim,
            _receipt: &InstallExitOwnershipReceipt,
        ) -> Result<(), InstallExitOwnershipError> {
            self.calls.lock().expect("calls").push("release-exit");
            let mut fail = self.fail_release_once.lock().expect("fail release");
            if *fail {
                *fail = false;
                return Err(InstallExitOwnershipError::new(
                    "INJECTED_EXIT_RELEASE_FAILURE",
                ));
            }
            Ok(())
        }

        fn retain_recovery_required(&self, _evidence: InstallExitRecoveryEvidence) {
            self.calls.lock().expect("calls").push("recovery-required");
        }
    }

    struct PrepareFailExitOwners {
        calls: Arc<Mutex<Vec<&'static str>>>,
    }

    impl InstallExitOwnershipPort for PrepareFailExitOwners {
        fn prepare_update_exit(
            &self,
            _operation: &UpdateInstallGateClaim,
        ) -> Result<InstallExitOwnershipReceipt, InstallExitOwnershipError> {
            self.calls.lock().expect("calls").push("prepare-exit");
            Err(InstallExitOwnershipError::new(
                "INJECTED_EXIT_PREPARE_FAILURE",
            ))
        }

        fn seal_update_exit(
            &self,
            _operation: &UpdateInstallGateClaim,
            _receipt: &InstallExitOwnershipReceipt,
        ) -> Result<Box<dyn InfallibleInstallExitCapability>, InstallExitOwnershipError> {
            panic!("prepare failure 后不得调用 seal")
        }

        fn release_update_exit(
            &self,
            _operation: &UpdateInstallGateClaim,
            _receipt: &InstallExitOwnershipReceipt,
        ) -> Result<(), InstallExitOwnershipError> {
            panic!("prepare failure 没有 ownership 可 release")
        }

        fn retain_recovery_required(&self, _evidence: InstallExitRecoveryEvidence) {
            self.calls.lock().expect("calls").push("recovery-required");
        }
    }

    fn prepared_native_lease(
        gate: &UpdateInstallGate,
        native_calls: Arc<Mutex<Vec<String>>>,
    ) -> NativeInstallLease {
        prepared_native_lease_with_failure(gate, native_calls, None, None)
    }

    fn prepared_native_lease_with_failure(
        gate: &UpdateInstallGate,
        native_calls: Arc<Mutex<Vec<String>>>,
        fail_rollback_once: Option<NativeInstallStage>,
        fail_verify_on_call: Option<usize>,
    ) -> NativeInstallLease {
        let coordinator = NativeInstallQuiescence::new(
            gate.clone(),
            Arc::new(PreparedOwners {
                calls: native_calls,
                fail_rollback_once: Mutex::new(fail_rollback_once),
                fail_verify_on_call,
                verify_calls: Mutex::new(0),
            }),
        );
        match tauri::async_runtime::block_on(
            coordinator.prepare("install-op-1", Duration::from_millis(50)),
        ) {
            Ok(lease) => lease,
            Err(_) => panic!("native prepare 应成功"),
        }
    }

    #[test]
    fn exact_prepared_lease_seals_and_commit_consumes_infallible_exit_once() {
        let gate = UpdateInstallGate::default();
        let lease = prepared_native_lease(&gate, Arc::new(Mutex::new(Vec::new())));
        let operation = lease.operation().clone();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let port = Arc::new(RecordingExitOwners {
            calls: Arc::clone(&calls),
            fail_seal: false,
            fail_release_once: Mutex::new(false),
        });

        let sealed = lease.seal(&operation, port).expect("seal should succeed");
        assert_eq!(
            calls.lock().expect("calls").as_slice(),
            ["prepare-exit", "seal-exit"]
        );

        sealed.commit_after_spawn();

        assert_eq!(
            calls.lock().expect("calls").as_slice(),
            ["prepare-exit", "seal-exit", "exit"]
        );
    }

    #[test]
    fn spawn_failure_releases_exit_before_reverse_native_rollback_and_reopens_gate() {
        let gate = UpdateInstallGate::default();
        let native_calls = Arc::new(Mutex::new(Vec::new()));
        let lease = prepared_native_lease(&gate, Arc::clone(&native_calls));
        let operation = lease.operation().clone();
        let exit_calls = Arc::new(Mutex::new(Vec::new()));
        let port = Arc::new(RecordingExitOwners {
            calls: Arc::clone(&exit_calls),
            fail_seal: false,
            fail_release_once: Mutex::new(false),
        });
        let sealed = lease.seal(&operation, port).expect("seal should succeed");
        exit_calls.lock().expect("exit calls").clear();

        let outcome = sealed
            .rollback_before_spawn(&operation)
            .expect("spawn failure 应完整 rollback");

        assert_eq!(outcome, InstallExitRollbackOutcome::Restored);
        assert_eq!(
            exit_calls.lock().expect("exit calls").as_slice(),
            ["release-exit"]
        );
        assert_eq!(
            native_calls.lock().expect("native calls").as_slice(),
            [
                "rollback-DesktopLyrics",
                "rollback-Wallpaper",
                "rollback-FullDesktop",
                "rollback-Transition",
                "verify-native-rollback",
            ]
        );
        assert!(gate.enter_mutation().is_ok());
    }

    #[test]
    fn release_failure_returns_retryable_exact_recovery_without_touching_native_owners() {
        let gate = UpdateInstallGate::default();
        let native_calls = Arc::new(Mutex::new(Vec::new()));
        let lease = prepared_native_lease(&gate, Arc::clone(&native_calls));
        let operation = lease.operation().clone();
        let exit_calls = Arc::new(Mutex::new(Vec::new()));
        let port = Arc::new(RecordingExitOwners {
            calls: Arc::clone(&exit_calls),
            fail_seal: false,
            fail_release_once: Mutex::new(true),
        });
        let sealed = lease.seal(&operation, port).expect("seal should succeed");
        exit_calls.lock().expect("exit calls").clear();

        let failure = sealed
            .rollback_before_spawn(&operation)
            .expect_err("首次 release 应失败并返回 recovery");

        assert_eq!(failure.error.stage, InstallExitStage::OwnershipRelease);
        assert_eq!(failure.error.code, "INJECTED_EXIT_RELEASE_FAILURE");
        assert!(native_calls.lock().expect("native calls").is_empty());
        assert!(gate.enter_mutation().is_err());

        let outcome = failure
            .recovery
            .rollback_before_spawn(&operation)
            .expect("同一 recovery token 应可重试");
        assert_eq!(outcome, InstallExitRollbackOutcome::Restored);
        assert_eq!(
            exit_calls.lock().expect("exit calls").as_slice(),
            ["release-exit", "release-exit"]
        );
        assert!(gate.enter_mutation().is_ok());
    }

    #[test]
    fn native_rollback_failure_keeps_recovery_after_exit_ownership_is_released() {
        let gate = UpdateInstallGate::default();
        let native_calls = Arc::new(Mutex::new(Vec::new()));
        let lease = prepared_native_lease_with_failure(
            &gate,
            Arc::clone(&native_calls),
            Some(NativeInstallStage::DesktopLyrics),
            None,
        );
        let operation = lease.operation().clone();
        let exit_calls = Arc::new(Mutex::new(Vec::new()));
        let port = Arc::new(RecordingExitOwners {
            calls: Arc::clone(&exit_calls),
            fail_seal: false,
            fail_release_once: Mutex::new(false),
        });
        let sealed = lease.seal(&operation, port).expect("seal should succeed");
        exit_calls.lock().expect("exit calls").clear();

        let failure = sealed
            .rollback_before_spawn(&operation)
            .expect_err("首次 native rollback 应失败并返回 recovery");

        assert_eq!(failure.error.stage, InstallExitStage::NativeRollback);
        assert_eq!(failure.error.code, "INJECTED_NATIVE_ROLLBACK_FAILURE");
        assert_eq!(
            exit_calls.lock().expect("exit calls").as_slice(),
            ["release-exit"]
        );
        assert_eq!(
            native_calls.lock().expect("native calls").as_slice(),
            ["rollback-DesktopLyrics"]
        );
        assert!(gate.enter_mutation().is_err());

        failure
            .recovery
            .rollback_before_spawn(&operation)
            .expect("native recovery 应从失败 owner 重试");
        assert_eq!(
            exit_calls.lock().expect("exit calls").as_slice(),
            ["release-exit"]
        );
        assert_eq!(
            native_calls.lock().expect("native calls").as_slice(),
            [
                "rollback-DesktopLyrics",
                "rollback-DesktopLyrics",
                "rollback-Wallpaper",
                "rollback-FullDesktop",
                "rollback-Transition",
                "verify-native-rollback",
            ]
        );
        assert!(gate.enter_mutation().is_ok());
    }

    #[test]
    fn seal_failure_returns_owned_recovery_without_rolling_back_before_marker_tombstone() {
        let gate = UpdateInstallGate::default();
        let native_calls = Arc::new(Mutex::new(Vec::new()));
        let lease = prepared_native_lease(&gate, Arc::clone(&native_calls));
        let operation = lease.operation().clone();
        let exit_calls = Arc::new(Mutex::new(Vec::new()));
        let port = Arc::new(RecordingExitOwners {
            calls: Arc::clone(&exit_calls),
            fail_seal: true,
            fail_release_once: Mutex::new(false),
        });

        let failure = lease
            .seal(&operation, port)
            .expect_err("exit ownership seal 失败必须补偿");

        assert_eq!(failure.error.stage, InstallExitStage::OwnershipSeal);
        assert_eq!(failure.error.code, "INJECTED_EXIT_SEAL_FAILURE");
        assert!(failure.rollback_error.is_none());
        assert!(failure.recovery.is_some());
        assert_eq!(
            exit_calls.lock().expect("exit calls").as_slice(),
            ["prepare-exit", "seal-exit"]
        );
        assert!(native_calls.lock().expect("native calls").is_empty());
        assert!(gate.enter_mutation().is_err());

        failure
            .recovery
            .expect("seal failure 必须保留 exact ownership")
            .rollback_before_spawn(&operation)
            .expect("durable marker tombstone 后应可显式补偿");
        assert!(gate.enter_mutation().is_ok());
    }

    #[test]
    fn exit_ownership_prepare_failure_returns_native_recovery_for_ordered_compensation() {
        let gate = UpdateInstallGate::default();
        let native_calls = Arc::new(Mutex::new(Vec::new()));
        let lease = prepared_native_lease(&gate, Arc::clone(&native_calls));
        let operation = lease.operation().clone();
        let exit_calls = Arc::new(Mutex::new(Vec::new()));
        let port = Arc::new(PrepareFailExitOwners {
            calls: Arc::clone(&exit_calls),
        });

        let failure = lease
            .seal(&operation, port)
            .expect_err("exit ownership prepare 失败必须保留 native recovery");

        assert_eq!(failure.error.stage, InstallExitStage::OwnershipPrepare);
        assert_eq!(failure.error.code, "INJECTED_EXIT_PREPARE_FAILURE");
        assert!(failure.rollback_error.is_none());
        assert!(failure.recovery.is_some());
        assert_eq!(
            exit_calls.lock().expect("exit calls").as_slice(),
            ["prepare-exit"]
        );
        assert!(native_calls.lock().expect("native calls").is_empty());
        assert!(gate.enter_mutation().is_err());

        failure
            .recovery
            .expect("prepare failure 必须保留 exact native lease")
            .rollback_before_spawn(&operation)
            .expect("durable marker 处理后应可显式恢复 native");
        assert!(gate.enter_mutation().is_ok());
    }

    #[test]
    fn seal_compensation_failure_returns_exact_recovery_for_explicit_retry() {
        let gate = UpdateInstallGate::default();
        let native_calls = Arc::new(Mutex::new(Vec::new()));
        let lease = prepared_native_lease(&gate, Arc::clone(&native_calls));
        let operation = lease.operation().clone();
        let exit_calls = Arc::new(Mutex::new(Vec::new()));
        let port = Arc::new(RecordingExitOwners {
            calls: Arc::clone(&exit_calls),
            fail_seal: true,
            fail_release_once: Mutex::new(true),
        });

        let failure = lease
            .seal(&operation, port)
            .expect_err("seal 与 release 双重失败必须返回 recovery");

        assert_eq!(failure.error.stage, InstallExitStage::OwnershipSeal);
        assert!(failure.rollback_error.is_none());
        assert!(native_calls.lock().expect("native calls").is_empty());
        assert!(gate.enter_mutation().is_err());

        let retry = failure
            .recovery
            .expect("失败必须保留 recovery")
            .rollback_before_spawn(&operation)
            .expect_err("第一次显式 recovery 应暴露 transient release failure");
        assert_eq!(retry.error.stage, InstallExitStage::OwnershipRelease);
        assert_eq!(
            exit_calls.lock().expect("exit calls").as_slice(),
            ["prepare-exit", "seal-exit", "release-exit"]
        );
        assert!(native_calls.lock().expect("native calls").is_empty());

        retry
            .recovery
            .rollback_before_spawn(&operation)
            .expect("第二次 retry 应释放 exit 后恢复 native");
        assert_eq!(
            exit_calls.lock().expect("exit calls").as_slice(),
            ["prepare-exit", "seal-exit", "release-exit", "release-exit",]
        );
        assert!(gate.enter_mutation().is_ok());
    }

    #[test]
    fn stale_generation_cannot_seal_or_release_the_current_native_lease() {
        let gate = UpdateInstallGate::default();
        let stale = gate
            .claim("install-op-1", Duration::ZERO)
            .expect("stale setup claim");
        gate.reopen_after_verified_rollback(&stale)
            .expect("stale setup rollback");
        let native_calls = Arc::new(Mutex::new(Vec::new()));
        let lease = prepared_native_lease(&gate, Arc::clone(&native_calls));
        let current = lease.operation().clone();
        assert!(current.generation() > stale.generation());
        let exit_calls = Arc::new(Mutex::new(Vec::new()));
        let port = Arc::new(RecordingExitOwners {
            calls: Arc::clone(&exit_calls),
            fail_seal: false,
            fail_release_once: Mutex::new(false),
        });

        let failure = lease
            .seal(&stale, port)
            .expect_err("旧 generation 不得取得 exit ownership");

        assert_eq!(failure.error.stage, InstallExitStage::PreparedLease);
        assert_eq!(failure.error.code, "UPDATE_INSTALL_CLAIM_STALE");
        assert!(exit_calls.lock().expect("exit calls").is_empty());
        assert!(native_calls.lock().expect("native calls").is_empty());
        assert!(gate.enter_mutation().is_err());

        failure
            .recovery
            .expect("current lease 必须保留")
            .rollback_before_spawn(&current)
            .expect("只有 current generation 可恢复");
        assert!(gate.enter_mutation().is_ok());
    }

    #[test]
    fn native_owner_recheck_failure_never_produces_a_sealed_token() {
        let gate = UpdateInstallGate::default();
        let native_calls = Arc::new(Mutex::new(Vec::new()));
        let lease =
            prepared_native_lease_with_failure(&gate, Arc::clone(&native_calls), None, Some(2));
        let operation = lease.operation().clone();
        let exit_calls = Arc::new(Mutex::new(Vec::new()));
        let port = Arc::new(RecordingExitOwners {
            calls: Arc::clone(&exit_calls),
            fail_seal: false,
            fail_release_once: Mutex::new(false),
        });

        let failure = lease
            .seal(&operation, port)
            .expect_err("native owner recheck 失败不得产出 sealed token");

        assert_eq!(failure.error.stage, InstallExitStage::PreparedLease);
        assert_eq!(failure.error.code, "INJECTED_NATIVE_RECHECK_FAILURE");
        assert!(failure.rollback_error.is_none());
        assert!(failure.recovery.is_some());
        assert_eq!(
            exit_calls.lock().expect("exit calls").as_slice(),
            ["prepare-exit"]
        );
        assert!(gate.enter_mutation().is_err());

        failure
            .recovery
            .expect("native recheck failure 必须保留 exit/native exact ownership")
            .rollback_before_spawn(&operation)
            .expect("durable marker 处理后应可显式恢复");
        assert_eq!(
            exit_calls.lock().expect("exit calls").as_slice(),
            ["prepare-exit", "release-exit"]
        );
        assert!(gate.enter_mutation().is_ok());
    }

    #[test]
    fn dropping_uncommitted_sealed_token_marks_recovery_required_and_keeps_gate_closed() {
        let gate = UpdateInstallGate::default();
        let lease = prepared_native_lease(&gate, Arc::new(Mutex::new(Vec::new())));
        let operation = lease.operation().clone();
        let exit_calls = Arc::new(Mutex::new(Vec::new()));
        let port = Arc::new(RecordingExitOwners {
            calls: Arc::clone(&exit_calls),
            fail_seal: false,
            fail_release_once: Mutex::new(false),
        });
        let sealed = lease.seal(&operation, port).expect("seal should succeed");

        drop(sealed);

        assert_eq!(
            exit_calls.lock().expect("exit calls").as_slice(),
            ["prepare-exit", "seal-exit", "recovery-required"]
        );
        assert!(gate.enter_mutation().is_err());
    }
}
