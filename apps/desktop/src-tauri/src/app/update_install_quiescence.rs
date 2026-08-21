use std::{fmt, sync::Arc, time::Duration};

use super::update_install_exit::{
    seal_native_install, InstallExitOwnershipPort, InstallExitSealFailure, SealedInstallExit,
};
use super::update_install_gate::{
    UpdateInstallGate, UpdateInstallGateClaim, UpdateInstallGateError,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeInstallStage {
    Gate,
    Transition,
    FullDesktop,
    Wallpaper,
    DesktopLyrics,
    Recheck,
    RollbackVerification,
}

impl NativeInstallStage {
    fn name(self) -> &'static str {
        match self {
            Self::Gate => "gate",
            Self::Transition => "transition",
            Self::FullDesktop => "full-desktop",
            Self::Wallpaper => "wallpaper",
            Self::DesktopLyrics => "desktop-lyrics",
            Self::Recheck => "recheck",
            Self::RollbackVerification => "rollback-verification",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeOwnerError {
    code: String,
}

pub(crate) struct NativeOwnerPrepareFailure {
    error: NativeOwnerError,
    receipt: Option<NativeOwnerReceipt>,
}

impl NativeOwnerPrepareFailure {
    pub(crate) fn clean(error: NativeOwnerError) -> Self {
        Self {
            error,
            receipt: None,
        }
    }

    pub(crate) fn owned(error: NativeOwnerError, receipt: NativeOwnerReceipt) -> Self {
        Self {
            error,
            receipt: Some(receipt),
        }
    }
}

impl From<NativeOwnerError> for NativeOwnerPrepareFailure {
    fn from(error: NativeOwnerError) -> Self {
        Self::clean(error)
    }
}

impl NativeOwnerError {
    pub(crate) fn new(code: impl Into<String>) -> Self {
        let code = code.into();
        let code = if valid_stable_code(&code) {
            code
        } else {
            "NATIVE_OWNER_FAILED".to_owned()
        };
        Self { code }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeInstallError {
    pub stage: NativeInstallStage,
    pub code: String,
}

impl NativeInstallError {
    fn owner(stage: NativeInstallStage, error: NativeOwnerError) -> Self {
        Self {
            stage,
            code: error.code,
        }
    }

    fn stable(stage: NativeInstallStage, code: &'static str) -> Self {
        Self {
            stage,
            code: code.to_owned(),
        }
    }

    fn gate(error: &UpdateInstallGateError) -> Self {
        Self::stable(NativeInstallStage::Gate, error.stable_code())
    }
}

impl fmt::Display for NativeInstallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}:{}", self.stage.name(), self.code)
    }
}

impl std::error::Error for NativeInstallError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeOwnerReceipt {
    claim: UpdateInstallGateClaim,
    stage: NativeInstallStage,
    token: String,
}

impl NativeOwnerReceipt {
    pub(crate) fn exact(
        claim: &UpdateInstallGateClaim,
        stage: NativeInstallStage,
        token: impl Into<String>,
    ) -> Self {
        Self {
            claim: claim.clone(),
            stage,
            token: token.into(),
        }
    }

    pub fn stage(&self) -> NativeInstallStage {
        self.stage
    }
}

/// Adapter 为 worker join、进程 wait 与 Win32 调用提供硬超时；#54 必须在
/// bounded blocking worker 中调用整个同步协调器，不得在 Tauri event loop 上直接运行。
/// 协调器本身不认识 Tauri、Explorer 或 Bun transport。
pub trait NativeInstallOwnerPort: Send + Sync {
    fn acquire_transition(
        &self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure>;

    fn disable_full_desktop_without_persisting_preference(
        &self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure>;

    fn capture_and_stop_wallpaper(
        &self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure>;

    fn stop_and_join_desktop_lyrics_worker(
        &self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure>;

    fn verify_prepared(
        &self,
        operation: &UpdateInstallGateClaim,
        receipts: &[NativeOwnerReceipt],
    ) -> Result<(), NativeOwnerError>;

    fn rollback_owner(
        &self,
        operation: &UpdateInstallGateClaim,
        receipt: &NativeOwnerReceipt,
    ) -> Result<(), NativeOwnerError>;

    fn verify_rollback(&self, operation: &UpdateInstallGateClaim) -> Result<(), NativeOwnerError>;
}

#[derive(Clone)]
pub struct NativeInstallQuiescence {
    gate: UpdateInstallGate,
    owners: Arc<dyn NativeInstallOwnerPort>,
}

impl NativeInstallQuiescence {
    pub fn new(gate: UpdateInstallGate, owners: Arc<dyn NativeInstallOwnerPort>) -> Self {
        Self { gate, owners }
    }

    pub async fn prepare(
        &self,
        operation_id: &str,
        drain_timeout: Duration,
    ) -> Result<NativeInstallLease, NativePrepareFailure> {
        self.prepare_on_worker(operation_id, None, drain_timeout)
            .await
    }

    /// 生产安装事务从 durable Web prepare record 继承 generation，禁止 native gate
    /// 自行生成第二套 identity。
    pub async fn prepare_exact(
        &self,
        operation_id: &str,
        operation_generation: u64,
        drain_timeout: Duration,
    ) -> Result<NativeInstallLease, NativePrepareFailure> {
        self.prepare_on_worker(operation_id, Some(operation_generation), drain_timeout)
            .await
    }

    /// Coordinator 的 cancellation-safe worker 使用该同步入口，并把结果写入自身持有的
    /// completion cell。这样 command future 被取消时，prepared lease 也不会随 detached
    /// blocking task 的返回值一起丢失。
    pub(crate) fn prepare_exact_blocking(
        &self,
        operation_id: &str,
        operation_generation: u64,
        drain_timeout: Duration,
    ) -> Result<NativeInstallLease, NativePrepareFailure> {
        self.prepare_blocking_with_generation(
            operation_id,
            Some(operation_generation),
            drain_timeout,
        )
    }

    async fn prepare_on_worker(
        &self,
        operation_id: &str,
        operation_generation: Option<u64>,
        drain_timeout: Duration,
    ) -> Result<NativeInstallLease, NativePrepareFailure> {
        let coordinator = self.clone();
        let operation_id = operation_id.to_owned();
        match tauri::async_runtime::spawn_blocking(move || {
            coordinator.prepare_blocking_with_generation(
                &operation_id,
                operation_generation,
                drain_timeout,
            )
        })
        .await
        {
            Ok(result) => result,
            Err(_) => Err(NativePrepareFailure {
                error: NativeInstallError::stable(
                    NativeInstallStage::Gate,
                    "UPDATE_INSTALL_BLOCKING_WORKER_FAILED",
                ),
                rollback_error: None,
                recovery_lease: None,
            }),
        }
    }

    fn prepare_blocking(
        &self,
        operation_id: &str,
        drain_timeout: Duration,
    ) -> Result<NativeInstallLease, NativePrepareFailure> {
        self.prepare_blocking_with_generation(operation_id, None, drain_timeout)
    }

    fn prepare_blocking_with_generation(
        &self,
        operation_id: &str,
        operation_generation: Option<u64>,
        drain_timeout: Duration,
    ) -> Result<NativeInstallLease, NativePrepareFailure> {
        let claim_result = match operation_generation {
            Some(generation) => self
                .gate
                .claim_exact(operation_id, generation, drain_timeout),
            None => self.gate.claim(operation_id, drain_timeout),
        };
        let claim = match claim_result {
            Ok(claim) => claim,
            Err(UpdateInstallGateError::DrainTimedOut(claim)) => {
                let error = NativeInstallError::stable(
                    NativeInstallStage::Gate,
                    "UPDATE_INSTALL_DRAIN_TIMEOUT",
                );
                return Err(Self::rollback_failed_prepare(
                    error,
                    NativeInstallLease::rollback_required(
                        self.gate.clone(),
                        Arc::clone(&self.owners),
                        claim,
                    ),
                ));
            }
            Err(error) => {
                return Err(NativePrepareFailure {
                    error: NativeInstallError::gate(&error),
                    rollback_error: None,
                    recovery_lease: None,
                });
            }
        };

        let mut lease = NativeInstallLease::rollback_required(
            self.gate.clone(),
            Arc::clone(&self.owners),
            claim,
        );

        macro_rules! prepare_owner {
            ($stage:expr, $prepare:expr) => {
                match $prepare {
                    Ok(receipt) => {
                        if let Err(error) = lease.push_exact_receipt($stage, receipt) {
                            return Err(Self::rollback_failed_prepare(error, lease));
                        }
                    }
                    Err(failure) => {
                        if let Some(receipt) = failure.receipt {
                            if let Err(error) = lease.push_exact_receipt($stage, receipt) {
                                return Err(Self::rollback_failed_prepare(error, lease));
                            }
                        }
                        return Err(Self::rollback_failed_prepare(
                            NativeInstallError::owner($stage, failure.error),
                            lease,
                        ));
                    }
                }
            };
        }

        prepare_owner!(
            NativeInstallStage::Transition,
            self.owners.acquire_transition(&lease.claim)
        );
        prepare_owner!(
            NativeInstallStage::FullDesktop,
            self.owners
                .disable_full_desktop_without_persisting_preference(&lease.claim)
        );
        prepare_owner!(
            NativeInstallStage::Wallpaper,
            self.owners.capture_and_stop_wallpaper(&lease.claim)
        );
        prepare_owner!(
            NativeInstallStage::DesktopLyrics,
            self.owners
                .stop_and_join_desktop_lyrics_worker(&lease.claim)
        );

        if let Err(error) = self.owners.verify_prepared(&lease.claim, &lease.receipts) {
            return Err(Self::rollback_failed_prepare(
                NativeInstallError::owner(NativeInstallStage::Recheck, error),
                lease,
            ));
        }
        lease.phase = NativeLeasePhase::Prepared;
        Ok(lease)
    }

    fn rollback_failed_prepare(
        error: NativeInstallError,
        mut lease: NativeInstallLease,
    ) -> NativePrepareFailure {
        let claim = lease.claim.clone();
        match lease.rollback_exact(&claim) {
            Ok(_) => NativePrepareFailure {
                error,
                rollback_error: None,
                recovery_lease: None,
            },
            Err(rollback_error) => NativePrepareFailure {
                error,
                rollback_error: Some(rollback_error),
                recovery_lease: Some(Box::new(lease)),
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeRollbackOutcome {
    Restored,
    AlreadyRestored,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NativeLeasePhase {
    Prepared,
    RollbackRequired,
    Restored,
}

pub struct NativeInstallLease {
    gate: UpdateInstallGate,
    owners: Arc<dyn NativeInstallOwnerPort>,
    claim: UpdateInstallGateClaim,
    receipts: Vec<NativeOwnerReceipt>,
    phase: NativeLeasePhase,
}

impl NativeInstallLease {
    fn rollback_required(
        gate: UpdateInstallGate,
        owners: Arc<dyn NativeInstallOwnerPort>,
        claim: UpdateInstallGateClaim,
    ) -> Self {
        Self {
            gate,
            owners,
            claim,
            receipts: Vec::new(),
            phase: NativeLeasePhase::RollbackRequired,
        }
    }

    fn push_exact_receipt(
        &mut self,
        expected_stage: NativeInstallStage,
        receipt: NativeOwnerReceipt,
    ) -> Result<(), NativeInstallError> {
        if receipt.claim != self.claim
            || receipt.stage != expected_stage
            || !valid_receipt_token(&receipt.token)
        {
            return Err(NativeInstallError::stable(
                expected_stage,
                "NATIVE_OWNER_RECEIPT_INVALID",
            ));
        }
        self.receipts.push(receipt);
        Ok(())
    }

    pub fn operation(&self) -> &UpdateInstallGateClaim {
        &self.claim
    }

    pub fn prepared_stages(&self) -> Vec<NativeInstallStage> {
        self.receipts
            .iter()
            .map(NativeOwnerReceipt::stage)
            .collect()
    }

    pub fn seal(
        self,
        expected_operation: &UpdateInstallGateClaim,
        exit_owners: Arc<dyn InstallExitOwnershipPort>,
    ) -> Result<SealedInstallExit, InstallExitSealFailure> {
        seal_native_install(self, expected_operation, exit_owners)
    }

    pub(crate) fn validate_prepared_exact(
        &self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<(), NativeInstallError> {
        if operation != &self.claim {
            return Err(NativeInstallError::stable(
                NativeInstallStage::Gate,
                "UPDATE_INSTALL_CLAIM_STALE",
            ));
        }
        if self.phase != NativeLeasePhase::Prepared {
            return Err(NativeInstallError::stable(
                NativeInstallStage::Recheck,
                "NATIVE_INSTALL_LEASE_NOT_PREPARED",
            ));
        }
        Ok(())
    }

    pub(crate) fn recheck_prepared_exact(
        &self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<(), NativeInstallError> {
        self.validate_prepared_exact(operation)?;
        self.owners
            .verify_prepared(&self.claim, &self.receipts)
            .map_err(|error| NativeInstallError::owner(NativeInstallStage::Recheck, error))
    }

    pub fn rollback_exact(
        &mut self,
        operation: &UpdateInstallGateClaim,
    ) -> Result<NativeRollbackOutcome, NativeInstallError> {
        if operation != &self.claim {
            return Err(NativeInstallError::stable(
                NativeInstallStage::Gate,
                "UPDATE_INSTALL_CLAIM_STALE",
            ));
        }
        if self.phase == NativeLeasePhase::Restored {
            return Ok(NativeRollbackOutcome::AlreadyRestored);
        }
        self.phase = NativeLeasePhase::RollbackRequired;

        while let Some(receipt) = self.receipts.last() {
            if let Err(error) = self.owners.rollback_owner(&self.claim, receipt) {
                return Err(NativeInstallError::owner(receipt.stage, error));
            }
            self.receipts.pop();
        }

        self.owners.verify_rollback(&self.claim).map_err(|error| {
            NativeInstallError::owner(NativeInstallStage::RollbackVerification, error)
        })?;
        self.gate
            .reopen_after_verified_rollback(&self.claim)
            .map_err(|error| NativeInstallError::gate(&error))?;
        self.phase = NativeLeasePhase::Restored;
        Ok(NativeRollbackOutcome::Restored)
    }
}

pub struct NativePrepareFailure {
    pub error: NativeInstallError,
    pub rollback_error: Option<NativeInstallError>,
    pub recovery_lease: Option<Box<NativeInstallLease>>,
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
    use std::sync::Mutex;

    struct RecordingOwners {
        calls: Mutex<Vec<String>>,
        prepare_threads: Mutex<Vec<std::thread::ThreadId>>,
        fail_prepare: Option<NativeInstallStage>,
        partial_fail_prepare: Option<NativeInstallStage>,
        invalid_receipt: Option<NativeInstallStage>,
        fail_rollback_once: Mutex<Option<NativeInstallStage>>,
    }

    impl RecordingOwners {
        fn new(
            fail_prepare: Option<NativeInstallStage>,
            invalid_receipt: Option<NativeInstallStage>,
            fail_rollback_once: Option<NativeInstallStage>,
        ) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                prepare_threads: Mutex::new(Vec::new()),
                fail_prepare,
                partial_fail_prepare: None,
                invalid_receipt,
                fail_rollback_once: Mutex::new(fail_rollback_once),
            }
        }

        fn prepare(
            &self,
            operation: &UpdateInstallGateClaim,
            stage: NativeInstallStage,
        ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
            self.prepare_threads
                .lock()
                .expect("prepare threads")
                .push(std::thread::current().id());
            self.calls
                .lock()
                .expect("calls")
                .push(format!("prepare-{}", stage.name()));
            if self.fail_prepare == Some(stage) {
                return Err(NativeOwnerPrepareFailure::clean(NativeOwnerError::new(
                    "INJECTED_PREPARE_FAILURE",
                )));
            }
            if self.partial_fail_prepare == Some(stage) {
                return Err(NativeOwnerPrepareFailure::owned(
                    NativeOwnerError::new("INJECTED_PARTIAL_PREPARE_FAILURE"),
                    NativeOwnerReceipt::exact(
                        operation,
                        stage,
                        format!("{}-partial-token", stage.name()),
                    ),
                ));
            }
            if self.invalid_receipt == Some(stage) {
                let forged_claim = UpdateInstallGate::default()
                    .claim("forged-other-operation", Duration::ZERO)
                    .expect("forged claim setup");
                return Ok(NativeOwnerReceipt {
                    claim: forged_claim,
                    stage,
                    token: "invalid-generation".to_owned(),
                });
            }
            Ok(NativeOwnerReceipt::exact(
                operation,
                stage,
                format!("{}-token", stage.name()),
            ))
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("calls").clone()
        }

        fn prepare_threads(&self) -> Vec<std::thread::ThreadId> {
            self.prepare_threads
                .lock()
                .expect("prepare threads")
                .clone()
        }
    }

    impl NativeInstallOwnerPort for RecordingOwners {
        fn acquire_transition(
            &self,
            operation: &UpdateInstallGateClaim,
        ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
            self.prepare(operation, NativeInstallStage::Transition)
        }

        fn disable_full_desktop_without_persisting_preference(
            &self,
            operation: &UpdateInstallGateClaim,
        ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
            self.prepare(operation, NativeInstallStage::FullDesktop)
        }

        fn capture_and_stop_wallpaper(
            &self,
            operation: &UpdateInstallGateClaim,
        ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
            self.prepare(operation, NativeInstallStage::Wallpaper)
        }

        fn stop_and_join_desktop_lyrics_worker(
            &self,
            operation: &UpdateInstallGateClaim,
        ) -> Result<NativeOwnerReceipt, NativeOwnerPrepareFailure> {
            self.prepare(operation, NativeInstallStage::DesktopLyrics)
        }

        fn verify_prepared(
            &self,
            _operation: &UpdateInstallGateClaim,
            _receipts: &[NativeOwnerReceipt],
        ) -> Result<(), NativeOwnerError> {
            self.calls
                .lock()
                .expect("calls")
                .push("verify-prepared".to_owned());
            if self.fail_prepare == Some(NativeInstallStage::Recheck) {
                return Err(NativeOwnerError::new("INJECTED_PREPARE_FAILURE"));
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
                .expect("calls")
                .push(format!("rollback-{}", receipt.stage().name()));
            let mut fail_once = self.fail_rollback_once.lock().expect("fail rollback once");
            if fail_once.as_ref() == Some(&receipt.stage()) {
                *fail_once = None;
                return Err(NativeOwnerError::new("INJECTED_ROLLBACK_FAILURE"));
            }
            Ok(())
        }

        fn verify_rollback(
            &self,
            _operation: &UpdateInstallGateClaim,
        ) -> Result<(), NativeOwnerError> {
            self.calls
                .lock()
                .expect("calls")
                .push("verify-rollback".to_owned());
            Ok(())
        }
    }

    #[test]
    fn public_prepare_runs_native_owners_on_a_blocking_worker() {
        let caller = std::thread::current().id();
        let gate = UpdateInstallGate::default();
        let owners = Arc::new(RecordingOwners::new(None, None, None));
        let coordinator = NativeInstallQuiescence::new(gate, owners.clone());

        let mut lease = match tauri::async_runtime::block_on(
            coordinator.prepare("async-native-prepare", Duration::from_millis(50)),
        ) {
            Ok(lease) => lease,
            Err(_) => panic!("blocking worker prepare 应成功"),
        };
        let threads = owners.prepare_threads();
        assert!(!threads.is_empty());
        assert!(threads.iter().all(|thread| *thread != caller));

        let operation = lease.operation().clone();
        lease
            .rollback_exact(&operation)
            .expect("async prepare 的 lease 应可精确回滚");
    }

    #[test]
    fn exact_prepare_preserves_the_web_operation_generation() {
        let gate = UpdateInstallGate::default();
        let owners = Arc::new(RecordingOwners::new(None, None, None));
        let coordinator = NativeInstallQuiescence::new(gate, owners);

        let mut lease = match tauri::async_runtime::block_on(coordinator.prepare_exact(
            &"a".repeat(32),
            23,
            Duration::from_millis(50),
        )) {
            Ok(lease) => lease,
            Err(_) => panic!("exact Web identity 应驱动 native prepare"),
        };

        assert_eq!(lease.operation().operation_id(), "a".repeat(32));
        assert_eq!(lease.operation().generation(), 23);
        let operation = lease.operation().clone();
        lease.rollback_exact(&operation).unwrap();
    }

    #[test]
    fn native_owner_prepare_and_rollback_use_fixed_reverse_order() {
        let gate = UpdateInstallGate::default();
        let owners = Arc::new(RecordingOwners::new(None, None, None));
        let coordinator = NativeInstallQuiescence::new(gate.clone(), owners.clone());

        let mut lease = match coordinator.prepare_blocking("install-op", Duration::from_millis(50))
        {
            Ok(lease) => lease,
            Err(_) => panic!("native prepare 应成功"),
        };
        assert_eq!(
            lease.prepared_stages(),
            vec![
                NativeInstallStage::Transition,
                NativeInstallStage::FullDesktop,
                NativeInstallStage::Wallpaper,
                NativeInstallStage::DesktopLyrics,
            ]
        );
        assert!(matches!(
            gate.enter_mutation(),
            Err(UpdateInstallGateError::MutationFrozen(_))
        ));

        let operation = lease.operation().clone();
        assert_eq!(
            lease.rollback_exact(&operation),
            Ok(NativeRollbackOutcome::Restored)
        );
        assert!(gate.enter_mutation().is_ok());
        assert_eq!(
            owners.calls(),
            vec![
                "prepare-transition",
                "prepare-full-desktop",
                "prepare-wallpaper",
                "prepare-desktop-lyrics",
                "verify-prepared",
                "rollback-desktop-lyrics",
                "rollback-wallpaper",
                "rollback-full-desktop",
                "rollback-transition",
                "verify-rollback",
            ]
        );
    }

    #[test]
    fn every_prepare_failure_rolls_back_only_completed_owners_in_reverse() {
        let owner_stages = [
            NativeInstallStage::Transition,
            NativeInstallStage::FullDesktop,
            NativeInstallStage::Wallpaper,
            NativeInstallStage::DesktopLyrics,
        ];
        let failure_stages = [
            NativeInstallStage::Transition,
            NativeInstallStage::FullDesktop,
            NativeInstallStage::Wallpaper,
            NativeInstallStage::DesktopLyrics,
            NativeInstallStage::Recheck,
        ];

        for failure_stage in failure_stages {
            let gate = UpdateInstallGate::default();
            let owners = Arc::new(RecordingOwners::new(Some(failure_stage), None, None));
            let coordinator = NativeInstallQuiescence::new(gate.clone(), owners.clone());

            let failure = match coordinator
                .prepare_blocking("failure-injection", Duration::from_millis(50))
            {
                Ok(_) => panic!("{failure_stage:?} 应注入失败"),
                Err(failure) => failure,
            };
            assert_eq!(failure.error.stage, failure_stage);
            assert_eq!(failure.error.code, "INJECTED_PREPARE_FAILURE");
            assert!(failure.rollback_error.is_none());
            assert!(failure.recovery_lease.is_none());

            let completed = if failure_stage == NativeInstallStage::Recheck {
                owner_stages.len()
            } else {
                owner_stages
                    .iter()
                    .position(|stage| *stage == failure_stage)
                    .expect("failure stage 应存在")
            };
            let mut expected = owner_stages[..completed]
                .iter()
                .map(|stage| format!("prepare-{}", stage.name()))
                .collect::<Vec<_>>();
            if failure_stage == NativeInstallStage::Recheck {
                expected.push("verify-prepared".to_owned());
            } else {
                expected.push(format!("prepare-{}", failure_stage.name()));
            }
            expected.extend(
                owner_stages[..completed]
                    .iter()
                    .rev()
                    .map(|stage| format!("rollback-{}", stage.name())),
            );
            expected.push("verify-rollback".to_owned());
            assert_eq!(owners.calls(), expected, "{failure_stage:?} rollback 顺序");
            assert!(gate.enter_mutation().is_ok(), "完整回滚后必须重开 gate");
        }
    }

    #[test]
    fn rollback_failure_keeps_exact_lease_frozen_and_can_retry() {
        let gate = UpdateInstallGate::default();
        let owners = Arc::new(RecordingOwners::new(
            None,
            None,
            Some(NativeInstallStage::Wallpaper),
        ));
        let coordinator = NativeInstallQuiescence::new(gate.clone(), owners.clone());
        let mut lease =
            match coordinator.prepare_blocking("rollback-retry", Duration::from_millis(50)) {
                Ok(lease) => lease,
                Err(_) => panic!("prepare 应成功"),
            };
        let operation = lease.operation().clone();

        let first_error = lease
            .rollback_exact(&operation)
            .expect_err("第一次 wallpaper rollback 应失败");
        assert_eq!(first_error.stage, NativeInstallStage::Wallpaper);
        assert_eq!(first_error.code, "INJECTED_ROLLBACK_FAILURE");
        assert!(matches!(
            gate.enter_mutation(),
            Err(UpdateInstallGateError::MutationFrozen(_))
        ));

        assert_eq!(
            lease.rollback_exact(&operation),
            Ok(NativeRollbackOutcome::Restored)
        );
        assert_eq!(
            lease.rollback_exact(&operation),
            Ok(NativeRollbackOutcome::AlreadyRestored)
        );
        assert!(gate.enter_mutation().is_ok());

        let calls = owners.calls();
        let first_wallpaper = calls
            .iter()
            .position(|call| call == "rollback-wallpaper")
            .expect("第一次 wallpaper rollback");
        let second_wallpaper = calls
            .iter()
            .rposition(|call| call == "rollback-wallpaper")
            .expect("第二次 wallpaper rollback");
        assert!(second_wallpaper > first_wallpaper);
    }

    #[test]
    fn stale_claim_cannot_rollback_or_reopen_current_native_lease() {
        let gate = UpdateInstallGate::default();
        let stale = gate
            .claim("stale", Duration::from_millis(50))
            .expect("stale claim setup");
        gate.reopen_after_verified_rollback(&stale)
            .expect("stale generation setup rollback");
        let owners = Arc::new(RecordingOwners::new(None, None, None));
        let coordinator = NativeInstallQuiescence::new(gate.clone(), owners);
        let mut lease = match coordinator.prepare_blocking("current", Duration::from_millis(50)) {
            Ok(lease) => lease,
            Err(_) => panic!("current prepare 应成功"),
        };

        let error = lease
            .rollback_exact(&stale)
            .expect_err("stale claim 必须被拒绝");
        assert_eq!(error.stage, NativeInstallStage::Gate);
        assert_eq!(error.code, "UPDATE_INSTALL_CLAIM_STALE");
        assert!(matches!(
            gate.enter_mutation(),
            Err(UpdateInstallGateError::MutationFrozen(_))
        ));

        let current = lease.operation().clone();
        assert_eq!(
            lease.rollback_exact(&current),
            Ok(NativeRollbackOutcome::Restored)
        );
    }

    #[test]
    fn forged_owner_receipt_fails_closed_and_rolls_back_prior_owners() {
        let gate = UpdateInstallGate::default();
        let owners = Arc::new(RecordingOwners::new(
            None,
            Some(NativeInstallStage::Wallpaper),
            None,
        ));
        let coordinator = NativeInstallQuiescence::new(gate.clone(), owners.clone());

        let failure =
            match coordinator.prepare_blocking("forged-receipt", Duration::from_millis(50)) {
                Ok(_) => panic!("伪造 receipt 必须失败"),
                Err(failure) => failure,
            };
        assert_eq!(failure.error.stage, NativeInstallStage::Wallpaper);
        assert_eq!(failure.error.code, "NATIVE_OWNER_RECEIPT_INVALID");
        assert!(failure.rollback_error.is_none());
        assert!(failure.recovery_lease.is_none());
        assert_eq!(
            owners.calls(),
            vec![
                "prepare-transition",
                "prepare-full-desktop",
                "prepare-wallpaper",
                "rollback-full-desktop",
                "rollback-transition",
                "verify-rollback",
            ]
        );
        assert!(gate.enter_mutation().is_ok());
    }

    #[test]
    fn drain_timeout_returns_recovery_lease_until_old_mutation_drops() {
        let gate = UpdateInstallGate::default();
        let permit = gate.enter_mutation().expect("初始 mutation 应进入");
        let owners = Arc::new(RecordingOwners::new(None, None, None));
        let coordinator = NativeInstallQuiescence::new(gate.clone(), owners);

        let mut failure = match coordinator.prepare_blocking("drain-timeout", Duration::ZERO) {
            Ok(_) => panic!("in-flight mutation 应触发 drain timeout"),
            Err(failure) => failure,
        };
        assert_eq!(failure.error.stage, NativeInstallStage::Gate);
        assert_eq!(failure.error.code, "UPDATE_INSTALL_DRAIN_TIMEOUT");
        assert_eq!(
            failure
                .rollback_error
                .as_ref()
                .map(|error| error.code.as_str()),
            Some("UPDATE_INSTALL_DRAIN_INCOMPLETE")
        );
        let mut lease = failure
            .recovery_lease
            .take()
            .expect("timeout holder 必须由 recovery lease 保管");
        assert!(matches!(
            gate.enter_mutation(),
            Err(UpdateInstallGateError::MutationFrozen(_))
        ));

        drop(permit);
        let operation = lease.operation().clone();
        assert_eq!(
            lease.rollback_exact(&operation),
            Ok(NativeRollbackOutcome::Restored)
        );
        assert!(gate.enter_mutation().is_ok());
    }

    #[test]
    fn dropping_failed_recovery_lease_never_reopens_gate() {
        let gate = UpdateInstallGate::default();
        let owners = Arc::new(RecordingOwners::new(
            Some(NativeInstallStage::Recheck),
            None,
            Some(NativeInstallStage::Wallpaper),
        ));
        let coordinator = NativeInstallQuiescence::new(gate.clone(), owners);
        let mut failure =
            match coordinator.prepare_blocking("drop-recovery", Duration::from_millis(50)) {
                Ok(_) => panic!("recheck failure 应触发 rollback"),
                Err(failure) => failure,
            };
        assert_eq!(failure.error.stage, NativeInstallStage::Recheck);
        assert_eq!(
            failure.rollback_error.as_ref().map(|error| error.stage),
            Some(NativeInstallStage::Wallpaper)
        );
        drop(failure.recovery_lease.take());
        assert!(matches!(
            gate.enter_mutation(),
            Err(UpdateInstallGateError::MutationFrozen(_))
        ));
    }

    #[test]
    fn partial_stage_receipt_is_rolled_back_before_prior_owners() {
        let gate = UpdateInstallGate::default();
        let mut configured = RecordingOwners::new(None, None, None);
        configured.partial_fail_prepare = Some(NativeInstallStage::Wallpaper);
        let owners = Arc::new(configured);
        let coordinator = NativeInstallQuiescence::new(gate.clone(), owners.clone());

        let failure =
            match coordinator.prepare_blocking("partial-wallpaper", Duration::from_millis(50)) {
                Ok(_) => panic!("partial Wallpaper prepare 必须失败"),
                Err(failure) => failure,
            };
        assert_eq!(failure.error.stage, NativeInstallStage::Wallpaper);
        assert_eq!(failure.error.code, "INJECTED_PARTIAL_PREPARE_FAILURE");
        assert!(failure.rollback_error.is_none());
        assert!(failure.recovery_lease.is_none());
        assert_eq!(
            owners.calls(),
            vec![
                "prepare-transition",
                "prepare-full-desktop",
                "prepare-wallpaper",
                "rollback-wallpaper",
                "rollback-full-desktop",
                "rollback-transition",
                "verify-rollback",
            ]
        );
        assert!(gate.enter_mutation().is_ok());
    }
}
