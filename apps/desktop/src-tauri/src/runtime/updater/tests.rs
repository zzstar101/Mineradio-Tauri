use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, Weak,
    },
};

use super::auto_check::{
    AutomaticCheckOutcome, StartupUpdateScheduler, UpdateTime, SUCCESS_INTERVAL_MILLIS,
};
use super::download::{
    InstallerDownloadError, InstallerDownloadEvent, InstallerDownloadEvents, InstallerDownloader,
    VerifiedInstallerArtifact, VerifiedInstallerPlan,
};
use super::policy::{
    MemoryUpdatePolicyStore, NativeUpdatePolicyStore, UpdatePolicySnapshot, UpdatePolicyStore,
    UpdatePolicyStoreError,
};
use super::*;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct ImmediateUpdateTime {
    now: Arc<std::sync::atomic::AtomicU64>,
    delay_millis: u64,
    events: Arc<Mutex<Vec<&'static str>>>,
}

impl ImmediateUpdateTime {
    fn new(now: u64, delay_millis: u64, events: Arc<Mutex<Vec<&'static str>>>) -> Self {
        Self {
            now: Arc::new(std::sync::atomic::AtomicU64::new(now)),
            delay_millis,
            events,
        }
    }

    fn set_now(&self, now: u64) {
        self.now.store(now, Ordering::Release);
    }
}

impl UpdateTime for ImmediateUpdateTime {
    fn now_millis(&self) -> Result<u64, &'static str> {
        Ok(self.now.load(Ordering::Acquire))
    }

    fn startup_delay_millis(&self) -> Result<u64, &'static str> {
        Ok(self.delay_millis)
    }

    fn sleep<'a>(
        &'a self,
        _delay_millis: u64,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move {
            self.events
                .lock()
                .expect("update time event log poisoned")
                .push("sleep");
            !cancellation.is_cancelled()
        })
    }
}

#[derive(Clone)]
struct PausedUpdateTime {
    now: u64,
    delay_millis: u64,
    sleep_entered: Arc<tokio::sync::Notify>,
    release_sleep: Arc<tokio::sync::Notify>,
}

impl UpdateTime for PausedUpdateTime {
    fn now_millis(&self) -> Result<u64, &'static str> {
        Ok(self.now)
    }

    fn startup_delay_millis(&self) -> Result<u64, &'static str> {
        Ok(self.delay_millis)
    }

    fn sleep<'a>(
        &'a self,
        _delay_millis: u64,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move {
            self.sleep_entered.notify_one();
            tokio::select! {
                _ = self.release_sleep.notified() => true,
                _ = cancellation.cancelled() => false,
            }
        })
    }
}

struct CancelOnWakeUpdateTime {
    now: u64,
}

impl UpdateTime for CancelOnWakeUpdateTime {
    fn now_millis(&self) -> Result<u64, &'static str> {
        Ok(self.now)
    }

    fn startup_delay_millis(&self) -> Result<u64, &'static str> {
        Ok(15_000)
    }

    fn sleep<'a>(
        &'a self,
        _delay_millis: u64,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move {
            cancellation.cancel();
            true
        })
    }
}

const RAW_PROVENANCE: &[u8] = include_bytes!("fixtures/provenance-v2.json");
const CONTRACT_JSON: &str = include_str!("fixtures/provenance-v2-contract.json");

fn verified_fixture_evidence() -> provenance::VerifiedReleaseEvidence {
    let contract: serde_json::Value =
        serde_json::from_str(CONTRACT_JSON).expect("共享 provenance contract 应有效");
    let public_key = contract["encoded_public_key"]
        .as_str()
        .expect("contract 应包含测试公钥");
    let provenance_signature = contract["provenance_signature"]
        .as_str()
        .expect("contract 应包含 provenance 签名");
    let installer_signature = contract["installer_signature"]
        .as_str()
        .expect("contract 应包含安装包签名");
    let verifier =
        provenance::ProvenanceVerifier::from_tauri_pubkey(public_key).expect("fixture 公钥应有效");
    verifier
        .verify(provenance::ProvenanceVerificationInput {
            raw_provenance: RAW_PROVENANCE,
            provenance_signature,
            installer_signature,
            expected_repository: "zzstar101/Mineradio-Tauri",
            expected_tag: "v1.2.3",
            expected_version: "1.2.3",
            expected_commit_sha: "0123456789abcdef0123456789abcdef01234567",
            expected_target: "windows-x86_64-nsis",
        })
        .expect("fixture provenance 应有效")
}

fn fixture_public_key() -> String {
    serde_json::from_str::<serde_json::Value>(CONTRACT_JSON)
        .expect("共享 provenance contract 应有效")["encoded_public_key"]
        .as_str()
        .expect("contract 应包含公钥")
        .to_owned()
}

fn verified_fixture_release(notes: &[&str]) -> NormalizedRelease {
    NormalizedRelease::from_verified(verified_fixture_evidence(), notes.iter().copied(), None)
}

fn fixture_cache_store(directory: &RuntimeTestDirectory) -> Arc<cache::VerifiedCacheStore> {
    Arc::new(
        cache::VerifiedCacheStore::new(&directory.0, fixture_public_key())
            .expect("fixture cache store 应能初始化"),
    )
}

async fn write_fixture_verified_cache(directory: &RuntimeTestDirectory) {
    let cache = directory.join("cache-v1");
    std::fs::create_dir_all(&cache).expect("verified cache 目录应能创建");
    std::fs::write(cache.join("installer.exe"), b"installer").expect("fixture 安装包应能写入");
    fixture_cache_store(directory)
        .commit_verified(
            &verified_fixture_evidence(),
            9,
            "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
            10,
            11,
        )
        .await
        .expect("fixture verified cache 应能提交");
}

fn runtime_with_recovery_policy_and_downloader(
    source: Arc<dyn UpdateSource>,
    recovery: Arc<dyn UpdateStartupRecovery>,
    policy_store: Arc<dyn UpdatePolicyStore>,
    downloader: Arc<dyn InstallerDownloader>,
) -> UpdateRuntime {
    let mut runtime = UpdateRuntime::with_recovery_and_policy(
        "0.1.0",
        source,
        Arc::new(NoopSnapshotSink),
        recovery,
        policy_store,
    )
    .expect("策略应能载入");
    runtime.downloader = Some(downloader);
    runtime
}

struct OrderedStartupRecovery {
    events: Arc<Mutex<Vec<&'static str>>>,
}

struct ScriptedStartupRecovery {
    outcomes: Mutex<VecDeque<CacheRecoveryOutcome>>,
    calls: AtomicUsize,
}

impl ScriptedStartupRecovery {
    fn new(outcomes: impl IntoIterator<Item = CacheRecoveryOutcome>) -> Self {
        Self {
            outcomes: Mutex::new(outcomes.into_iter().collect()),
            calls: AtomicUsize::new(0),
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::Acquire)
    }
}

impl UpdateStartupRecovery for ScriptedStartupRecovery {
    fn recover<'a>(
        &'a self,
        _current_version: &'a str,
    ) -> Pin<Box<dyn Future<Output = CacheRecoveryOutcome> + Send + 'a>> {
        self.calls.fetch_add(1, Ordering::AcqRel);
        let outcome = self
            .outcomes
            .lock()
            .expect("scripted startup recovery poisoned")
            .pop_front()
            .expect("scripted startup recovery outcome exhausted");
        Box::pin(async move { outcome })
    }
}

struct RecoveryWithStableFault {
    inner: Arc<cache::VerifiedCacheStore>,
}

impl UpdateStartupRecovery for RecoveryWithStableFault {
    fn recover<'a>(
        &'a self,
        current_version: &'a str,
    ) -> Pin<Box<dyn Future<Output = CacheRecoveryOutcome> + Send + 'a>> {
        Box::pin(async move {
            match self.inner.recover(current_version).await {
                CacheRecoveryOutcome::Recovered(mut recovered) => {
                    recovered.recovery_fault = Some(CacheRecoveryFault {
                        code: "UPDATE_INSTALL_NOT_APPLIED",
                        message: "安装器未应用目标版本，已恢复播放状态与已验证更新",
                    });
                    CacheRecoveryOutcome::Recovered(recovered)
                }
                outcome => outcome,
            }
        })
    }
}

impl UpdateStartupRecovery for OrderedStartupRecovery {
    fn recover<'a>(
        &'a self,
        _current_version: &'a str,
    ) -> Pin<Box<dyn Future<Output = CacheRecoveryOutcome> + Send + 'a>> {
        Box::pin(async move {
            self.events
                .lock()
                .expect("startup event log poisoned")
                .push("recover");
            CacheRecoveryOutcome::Empty {
                fault: None,
                quarantine: None,
            }
        })
    }
}

struct OrderedUpdateSource {
    events: Arc<Mutex<Vec<&'static str>>>,
}

struct CountingPendingUpdateSource {
    entered: Arc<tokio::sync::Notify>,
    checks: AtomicUsize,
}

impl UpdateSource for CountingPendingUpdateSource {
    fn check(
        &self,
        _request: CheckRequest,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<NormalizedRelease>, UpdateSourceError>> + Send + '_>,
    > {
        self.checks.fetch_add(1, Ordering::AcqRel);
        Box::pin(async move {
            self.entered.notify_one();
            std::future::pending().await
        })
    }
}

struct RejectEveryPolicySaveStore {
    snapshot: UpdatePolicySnapshot,
}

impl UpdatePolicyStore for RejectEveryPolicySaveStore {
    fn load(&self) -> Result<UpdatePolicySnapshot, UpdatePolicyStoreError> {
        Ok(self.snapshot.clone())
    }

    fn save(&self, _snapshot: &UpdatePolicySnapshot) -> Result<(), UpdatePolicyStoreError> {
        Err(UpdatePolicyStoreError::runtime(
            "UPDATE_POLICY_TEST_REJECTED",
            "测试策略存储拒绝写入",
        ))
    }
}

impl UpdateSource for OrderedUpdateSource {
    fn check(
        &self,
        _request: CheckRequest,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<NormalizedRelease>, UpdateSourceError>> + Send + '_>,
    > {
        Box::pin(async move {
            self.events
                .lock()
                .expect("startup event log poisoned")
                .push("source");
            Ok(None)
        })
    }
}

#[test]
fn startup_scheduler_waits_until_recovery_finishes_before_the_first_check() {
    tauri::async_runtime::block_on(async {
        let events = Arc::new(Mutex::new(Vec::new()));
        let time = Arc::new(ImmediateUpdateTime::new(1_000_000, 15_000, events.clone()));
        let source = Arc::new(OrderedUpdateSource {
            events: events.clone(),
        });
        let recovery = Arc::new(OrderedStartupRecovery {
            events: events.clone(),
        });
        let mut runtime = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            source,
            Arc::new(NoopSnapshotSink),
            recovery,
            Arc::new(MemoryUpdatePolicyStore::default()),
        )
        .expect("默认策略应能载入");
        runtime.time = time.clone();
        let scheduler = StartupUpdateScheduler::new();

        let outcome = scheduler.run_once(&runtime, CancellationToken::new()).await;

        assert_eq!(outcome, AutomaticCheckOutcome::Completed);
        assert_eq!(
            *events.lock().expect("startup event log poisoned"),
            vec!["recover", "sleep", "source"]
        );
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Current);
    });
}

#[test]
fn manual_check_bypasses_the_automatic_interval_and_persists_the_injected_clock() {
    tauri::async_runtime::block_on(async {
        let events = Arc::new(Mutex::new(Vec::new()));
        let time = Arc::new(ImmediateUpdateTime::new(7_000, 15_000, events.clone()));
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)]));
        let recovery = Arc::new(OrderedStartupRecovery { events });
        let policy_store = Arc::new(MemoryUpdatePolicyStore::new(UpdatePolicySnapshot {
            last_successful_check_at: Some(6_999),
            ..UpdatePolicySnapshot::default()
        }));
        let mut runtime = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            source.clone(),
            Arc::new(NoopSnapshotSink),
            recovery,
            policy_store.clone(),
        )
        .expect("策略应能载入");
        runtime.time = time;
        assert!(runtime.run_pending_cache_recovery().await);

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);

        assert_eq!(source.check_count(), 1);
        assert_eq!(runtime.snapshot().checked_at, Some(7_000));
        assert_eq!(
            policy_store.load().unwrap().last_successful_check_at,
            Some(7_000)
        );
    });
}

#[test]
fn automatic_check_is_silent_before_the_24_hour_boundary_and_runs_at_the_boundary() {
    tauri::async_runtime::block_on(async {
        let checked_at = 1_000_000;
        for (now, expected_outcome, expected_checks) in [
            (
                checked_at + SUCCESS_INTERVAL_MILLIS - 1,
                AutomaticCheckOutcome::Throttled,
                0,
            ),
            (
                checked_at + SUCCESS_INTERVAL_MILLIS,
                AutomaticCheckOutcome::Completed,
                1,
            ),
        ] {
            let events = Arc::new(Mutex::new(Vec::new()));
            let time = Arc::new(ImmediateUpdateTime::new(now, 15_000, events.clone()));
            let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)]));
            let recovery = Arc::new(OrderedStartupRecovery { events });
            let policy_store = Arc::new(MemoryUpdatePolicyStore::new(UpdatePolicySnapshot {
                last_successful_check_at: Some(checked_at),
                ..UpdatePolicySnapshot::default()
            }));
            let mut runtime = UpdateRuntime::with_recovery_and_policy(
                "0.1.0",
                source.clone(),
                Arc::new(NoopSnapshotSink),
                recovery,
                policy_store,
            )
            .expect("策略应能载入");
            runtime.time = time;

            let outcome = StartupUpdateScheduler::new()
                .run_once(&runtime, CancellationToken::new())
                .await;

            assert_eq!(outcome, expected_outcome);
            assert_eq!(source.check_count(), expected_checks);
            assert!(runtime.snapshot().operation.is_none());
            if expected_checks == 0 {
                assert_eq!(
                    runtime.snapshot().revision,
                    1,
                    "限频不得制造 checking revision"
                );
                assert_eq!(runtime.snapshot().checked_at, Some(checked_at));
            } else {
                assert_eq!(runtime.snapshot().checked_at, Some(now));
            }
        }
    });
}

#[test]
fn future_success_timestamps_never_starve_automatic_checks() {
    tauri::async_runtime::block_on(async {
        let now = 1_000_000;
        for checked_at in [now + 1, u64::MAX] {
            let events = Arc::new(Mutex::new(Vec::new()));
            let time = Arc::new(ImmediateUpdateTime::new(now, 15_000, events.clone()));
            let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)]));
            let policy_store = Arc::new(MemoryUpdatePolicyStore::new(UpdatePolicySnapshot {
                last_successful_check_at: Some(checked_at),
                ..UpdatePolicySnapshot::default()
            }));
            let mut runtime = UpdateRuntime::with_recovery_and_policy(
                "0.1.0",
                source.clone(),
                Arc::new(NoopSnapshotSink),
                Arc::new(OrderedStartupRecovery { events }),
                policy_store.clone(),
            )
            .expect("未来检查时间策略应能载入");
            runtime.time = time;

            assert_eq!(
                StartupUpdateScheduler::new()
                    .run_once(&runtime, CancellationToken::new())
                    .await,
                AutomaticCheckOutcome::Completed,
                "checked_at={checked_at}"
            );
            assert_eq!(source.check_count(), 1, "checked_at={checked_at}");
            assert_eq!(runtime.snapshot().checked_at, Some(now));
            assert_eq!(
                policy_store.load().unwrap().last_successful_check_at,
                Some(now)
            );
        }
    });
}

#[test]
fn startup_scheduler_accepts_only_the_closed_15_to_30_second_jitter_range() {
    tauri::async_runtime::block_on(async {
        for (delay_millis, expected_outcome, expected_checks) in [
            (14_999, AutomaticCheckOutcome::TimingUnavailable, 0),
            (15_000, AutomaticCheckOutcome::Completed, 1),
            (30_000, AutomaticCheckOutcome::Completed, 1),
            (30_001, AutomaticCheckOutcome::TimingUnavailable, 0),
        ] {
            let events = Arc::new(Mutex::new(Vec::new()));
            let time = Arc::new(ImmediateUpdateTime::new(
                1_000_000,
                delay_millis,
                events.clone(),
            ));
            let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)]));
            let mut runtime = UpdateRuntime::with_recovery_and_policy(
                "0.1.0",
                source.clone(),
                Arc::new(NoopSnapshotSink),
                Arc::new(OrderedStartupRecovery { events }),
                Arc::new(MemoryUpdatePolicyStore::default()),
            )
            .expect("默认策略应能载入");
            runtime.time = time;

            assert_eq!(
                StartupUpdateScheduler::new()
                    .run_once(&runtime, CancellationToken::new())
                    .await,
                expected_outcome,
                "delay={delay_millis}"
            );
            assert_eq!(
                source.check_count(),
                expected_checks,
                "delay={delay_millis}"
            );
        }
    });
}

#[test]
fn cancellation_at_delay_completion_wins_before_an_operation_is_created() {
    tauri::async_runtime::block_on(async {
        let events = Arc::new(Mutex::new(Vec::new()));
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)]));
        let mut runtime = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            source.clone(),
            Arc::new(NoopSnapshotSink),
            Arc::new(OrderedStartupRecovery { events }),
            Arc::new(MemoryUpdatePolicyStore::default()),
        )
        .expect("默认策略应能载入");
        runtime.time = Arc::new(CancelOnWakeUpdateTime { now: 1_000_000 });
        let cancellation = CancellationToken::new();

        let outcome = StartupUpdateScheduler::new()
            .run_once(&runtime, cancellation.clone())
            .await;

        assert_eq!(outcome, AutomaticCheckOutcome::Cancelled);
        assert!(cancellation.is_cancelled());
        assert_eq!(source.check_count(), 0);
        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Idle);
        assert!(snapshot.operation.is_none());
        assert_eq!(snapshot.revision, 1, "取消不得制造 checking revision");
    });
}

#[test]
fn manual_success_during_startup_delay_prevents_a_second_automatic_check() {
    tauri::async_runtime::block_on(async {
        let sleep_entered = Arc::new(tokio::sync::Notify::new());
        let release_sleep = Arc::new(tokio::sync::Notify::new());
        let time = Arc::new(PausedUpdateTime {
            now: 50_000,
            delay_millis: 15_000,
            sleep_entered: sleep_entered.clone(),
            release_sleep: release_sleep.clone(),
        });
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(None), Ok(None)]));
        let recovery_events = Arc::new(Mutex::new(Vec::new()));
        let mut runtime = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            source.clone(),
            Arc::new(NoopSnapshotSink),
            Arc::new(OrderedStartupRecovery {
                events: recovery_events,
            }),
            Arc::new(MemoryUpdatePolicyStore::default()),
        )
        .expect("策略应能载入");
        runtime.time = time;
        let runtime = Arc::new(runtime);
        let task_runtime = runtime.clone();
        let scheduler = tauri::async_runtime::spawn(async move {
            StartupUpdateScheduler::new()
                .run_once(&task_runtime, CancellationToken::new())
                .await
        });
        sleep_entered.notified().await;

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);
        release_sleep.notify_one();

        assert_eq!(scheduler.await.unwrap(), AutomaticCheckOutcome::Throttled);
        assert_eq!(source.check_count(), 1);
        assert_eq!(runtime.snapshot().checked_at, Some(50_000));
    });
}

#[test]
fn automatic_and_manual_checks_share_one_operation_single_flight() {
    tauri::async_runtime::block_on(async {
        let entered = Arc::new(tokio::sync::Notify::new());
        let source = Arc::new(CountingPendingUpdateSource {
            entered: entered.clone(),
            checks: AtomicUsize::new(0),
        });
        let time = Arc::new(ImmediateUpdateTime::new(
            60_000,
            15_000,
            Arc::new(Mutex::new(Vec::new())),
        ));
        let mut runtime = UpdateRuntime::with_noop_sink("0.1.0", source.clone());
        runtime.time = time;
        let runtime = Arc::new(runtime);
        let task_runtime = runtime.clone();
        let task =
            tauri::async_runtime::spawn(async move { task_runtime.run_automatic_check().await });
        entered.notified().await;

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::InvalidOrder
        );
        assert_eq!(source.checks.load(Ordering::Acquire), 1);

        task.abort();
        let _ = task.await;
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Idle);
        assert!(runtime.snapshot().operation.is_none());
    });
}

#[test]
fn cancelling_during_the_source_check_restores_the_stable_phase() {
    tauri::async_runtime::block_on(async {
        let entered = Arc::new(tokio::sync::Notify::new());
        let source = Arc::new(CountingPendingUpdateSource {
            entered: entered.clone(),
            checks: AtomicUsize::new(0),
        });
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut runtime = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            source.clone(),
            Arc::new(NoopSnapshotSink),
            Arc::new(OrderedStartupRecovery {
                events: events.clone(),
            }),
            Arc::new(MemoryUpdatePolicyStore::default()),
        )
        .expect("默认策略应能载入");
        runtime.time = Arc::new(ImmediateUpdateTime::new(70_000, 15_000, events));
        let runtime = Arc::new(runtime);
        let cancellation = CancellationToken::new();
        let task_runtime = runtime.clone();
        let task_cancellation = cancellation.clone();
        let task = tauri::async_runtime::spawn(async move {
            StartupUpdateScheduler::new()
                .run_once(&task_runtime, task_cancellation)
                .await
        });
        entered.notified().await;
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Checking);

        cancellation.cancel();
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .expect("取消必须终止进行中的 source check")
            .expect("调度任务不应 panic");

        assert_eq!(outcome, AutomaticCheckOutcome::Cancelled);
        assert_eq!(source.checks.load(Ordering::Acquire), 1);
        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Idle);
        assert!(snapshot.operation.is_none());
        assert_eq!(snapshot.checked_at, None);
        assert_eq!(
            snapshot.fault.as_ref().map(|fault| fault.code.as_str()),
            Some("UPDATE_CHECK_INTERRUPTED")
        );
    });
}

#[test]
fn manual_check_can_show_an_exact_skipped_version_without_clearing_the_skip() {
    tauri::async_runtime::block_on(async {
        let events = Arc::new(Mutex::new(Vec::new()));
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
            verified_fixture_release(&[]),
        ))]));
        let policy_store = Arc::new(MemoryUpdatePolicyStore::new(UpdatePolicySnapshot {
            skipped_version: Some("1.2.3".into()),
            ..UpdatePolicySnapshot::default()
        }));
        let mut runtime = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            source,
            Arc::new(NoopSnapshotSink),
            Arc::new(OrderedStartupRecovery {
                events: events.clone(),
            }),
            policy_store.clone(),
        )
        .expect("skip 策略应能载入");
        runtime.time = Arc::new(ImmediateUpdateTime::new(10_000, 15_000, events));
        assert!(runtime.run_pending_cache_recovery().await);

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Available);
        assert_eq!(
            snapshot
                .candidate
                .as_ref()
                .map(|candidate| candidate.version.as_str()),
            Some("1.2.3")
        );
        assert_eq!(snapshot.skipped_version.as_deref(), Some("1.2.3"));
        assert_eq!(
            policy_store.load().unwrap().skipped_version.as_deref(),
            Some("1.2.3")
        );
    });
}

#[test]
fn automatic_check_keeps_an_exact_skipped_version_silent_without_losing_policy() {
    tauri::async_runtime::block_on(async {
        let events = Arc::new(Mutex::new(Vec::new()));
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
            verified_fixture_release(&[]),
        ))]));
        let policy_store = Arc::new(MemoryUpdatePolicyStore::new(UpdatePolicySnapshot {
            skipped_version: Some("1.2.3".into()),
            ..UpdatePolicySnapshot::default()
        }));
        let mut runtime = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            source,
            Arc::new(NoopSnapshotSink),
            Arc::new(OrderedStartupRecovery {
                events: events.clone(),
            }),
            policy_store.clone(),
        )
        .expect("skip 策略应能载入");
        runtime.time = Arc::new(ImmediateUpdateTime::new(11_000, 15_000, events));

        assert_eq!(
            StartupUpdateScheduler::new()
                .run_once(&runtime, CancellationToken::new())
                .await,
            AutomaticCheckOutcome::Completed
        );

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Current);
        assert!(snapshot.candidate.is_none());
        assert_eq!(snapshot.skipped_version.as_deref(), Some("1.2.3"));
        assert_eq!(snapshot.checked_at, Some(11_000));
        assert_eq!(
            policy_store.load().unwrap().skipped_version.as_deref(),
            Some("1.2.3")
        );
    });
}

#[test]
fn automatic_exact_skip_does_not_hide_a_same_version_identity_conflict() {
    tauri::async_runtime::block_on(async {
        let candidate_a =
            NormalizedRelease::new("candidate-a", "1.2.3", std::iter::empty::<&str>(), None);
        let candidate_b =
            NormalizedRelease::new("candidate-b", "1.2.3", std::iter::empty::<&str>(), None);
        let source = Arc::new(MemoryUpdateSource::with_outcomes([
            Ok(Some(candidate_a.clone())),
            Ok(Some(candidate_a)),
            Ok(Some(candidate_b)),
        ]));
        let time = Arc::new(ImmediateUpdateTime::new(
            20_000,
            15_000,
            Arc::new(Mutex::new(Vec::new())),
        ));
        let mut runtime = UpdateRuntime::with_noop_sink("0.1.0", source);
        runtime.time = time.clone();

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::SkipVersion {
                    candidate_id: "candidate-a".into(),
                },
            }),
            UpdateReceipt::Accepted
        );
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);
        time.set_now(20_000 + SUCCESS_INTERVAL_MILLIS);

        assert_eq!(
            runtime.run_automatic_check().await,
            AutomaticCheckOutcome::Completed
        );

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Available);
        assert_eq!(snapshot.candidate.unwrap().id, "candidate-a");
        assert_eq!(
            snapshot.fault.as_ref().map(|fault| fault.code.as_str()),
            Some("UPDATE_CANDIDATE_IDENTITY_CONFLICT")
        );
        assert_eq!(snapshot.skipped_version.as_deref(), Some("1.2.3"));
    });
}

#[test]
fn automatic_exact_skip_preserves_an_existing_ready_artifact() {
    tauri::async_runtime::block_on(async {
        let directory = RuntimeTestDirectory::new();
        let artifact_path = directory.join("verified-installer.exe");
        std::fs::write(&artifact_path, b"installer").unwrap();
        let source = Arc::new(MemoryUpdateSource::with_outcomes([
            Ok(Some(verified_fixture_release(&[]))),
            Ok(Some(verified_fixture_release(&[]))),
            Ok(Some(verified_fixture_release(&[]))),
        ]));
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![InstallerDownloadEvent::Verifying {
                received_bytes: 9,
                total_bytes: Some(9),
            }],
            outcome: ScriptedDownloadOutcome::SuccessAt {
                path: artifact_path.clone(),
                before_return: None,
            },
            events_emitted: None,
        });
        let time = Arc::new(ImmediateUpdateTime::new(
            30_000,
            15_000,
            Arc::new(Mutex::new(Vec::new())),
        ));
        let mut runtime =
            UpdateRuntime::with_downloader("0.1.0", source, Arc::new(NoopSnapshotSink), downloader);
        runtime.time = time.clone();

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::SkipVersion {
                    candidate_id: candidate_id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::Download {
                    candidate_id: candidate_id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_download().await);
        assert_eq!(runtime.snapshot().phase, UpdatePhase::ReadyToInstall);
        time.set_now(30_000 + SUCCESS_INTERVAL_MILLIS);

        assert_eq!(
            runtime.run_automatic_check().await,
            AutomaticCheckOutcome::Completed
        );

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::ReadyToInstall);
        assert_eq!(snapshot.candidate.unwrap().id, candidate_id);
        assert_eq!(snapshot.skipped_version.as_deref(), Some("1.2.3"));
        assert!(artifact_path.is_file());
        assert!(runtime
            .state
            .lock()
            .expect("update runtime state poisoned")
            .verified_artifact
            .is_some());
    });
}

fn superseded_policy_snapshot() -> UpdatePolicySnapshot {
    UpdatePolicySnapshot {
        last_successful_check_at: None,
        remind: Some(UpdatePolicyReminder {
            candidate_id: "a".repeat(64),
            version: "1.2.3".into(),
            until: 99_000,
        }),
        skipped_version: Some("1.2.3".into()),
        quarantine: Some(UpdatePolicyQuarantine {
            candidate_id: "b".repeat(64),
            version: "1.2.3".into(),
            reason: "UPDATE_SIGNATURE_REJECTED".into(),
            rejected_at: 1,
        }),
        ..UpdatePolicySnapshot::default()
    }
}

#[test]
fn strictly_higher_candidate_clears_superseded_policy_before_publication() {
    tauri::async_runtime::block_on(async {
        let events = Arc::new(Mutex::new(Vec::new()));
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
            NormalizedRelease::new("candidate-1.2.4", "1.2.4", std::iter::empty::<&str>(), None),
        ))]));
        let policy_store = Arc::new(MemoryUpdatePolicyStore::new(superseded_policy_snapshot()));
        let mut runtime = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            source,
            Arc::new(NoopSnapshotSink),
            Arc::new(OrderedStartupRecovery {
                events: events.clone(),
            }),
            policy_store.clone(),
        )
        .expect("旧策略应能载入");
        runtime.time = Arc::new(ImmediateUpdateTime::new(100_000, 15_000, events));
        assert!(runtime.run_pending_cache_recovery().await);

        assert_eq!(
            runtime.run_automatic_check().await,
            AutomaticCheckOutcome::Completed
        );

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Available);
        assert_eq!(snapshot.candidate.unwrap().version, "1.2.4");
        assert_eq!(snapshot.remind_after, None);
        assert_eq!(snapshot.skipped_version, None);
        let persisted = policy_store.load().unwrap();
        assert!(persisted.remind.is_none());
        assert!(persisted.skipped_version.is_none());
        assert!(persisted.quarantine.is_none());
    });
}

#[test]
fn higher_candidate_is_not_published_when_clearing_policy_cannot_commit() {
    tauri::async_runtime::block_on(async {
        let events = Arc::new(Mutex::new(Vec::new()));
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
            NormalizedRelease::new("candidate-1.2.4", "1.2.4", std::iter::empty::<&str>(), None),
        ))]));
        let mut runtime = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            source,
            Arc::new(NoopSnapshotSink),
            Arc::new(OrderedStartupRecovery {
                events: events.clone(),
            }),
            Arc::new(RejectEveryPolicySaveStore {
                snapshot: superseded_policy_snapshot(),
            }),
        )
        .expect("旧策略应能载入");
        runtime.time = Arc::new(ImmediateUpdateTime::new(100_000, 15_000, events));
        assert!(runtime.run_pending_cache_recovery().await);

        assert_eq!(
            runtime.run_automatic_check().await,
            AutomaticCheckOutcome::Completed
        );

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Idle);
        assert!(snapshot.candidate.is_none());
        assert_eq!(snapshot.remind_after, Some(99_000));
        assert_eq!(snapshot.skipped_version.as_deref(), Some("1.2.3"));
        assert_eq!(
            snapshot.fault.as_ref().map(|fault| fault.code.as_str()),
            Some("UPDATE_POLICY_TEST_REJECTED")
        );
    });
}

#[test]
fn remind_later_from_available_persists_exact_candidate_and_survives_runtime_rebuild() {
    tauri::async_runtime::block_on(async {
        let directory = RuntimeTestDirectory::new();
        let recovery = fixture_cache_store(&directory);
        let policy_store = Arc::new(MemoryUpdatePolicyStore::default());
        let runtime = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
                verified_fixture_release(&[]),
            ))])),
            Arc::new(NoopSnapshotSink),
            recovery.clone(),
            policy_store.clone(),
        )
        .expect("默认策略应能载入");
        assert!(runtime.run_pending_cache_recovery().await);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);
        let before = runtime.snapshot();
        let candidate = before.candidate.expect("检查后应有候选");

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: before.revision,
                intent: UpdateIntent::RemindLater {
                    candidate_id: candidate.id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );

        let after = runtime.snapshot();
        assert_eq!(after.phase, UpdatePhase::Available);
        assert_eq!(after.candidate.as_ref(), Some(&candidate));
        let persisted = policy_store.load().expect("提醒策略应已持久化");
        let reminder = persisted.remind.expect("应保存 reminder");
        assert_eq!(
            (reminder.candidate_id.as_str(), reminder.version.as_str()),
            (candidate.id.as_str(), candidate.version.as_str())
        );
        assert_eq!(after.remind_after, Some(reminder.until));

        let rebuilt = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)])),
            Arc::new(NoopSnapshotSink),
            recovery,
            policy_store,
        )
        .expect("已保存策略应能重新载入");
        assert_eq!(rebuilt.snapshot().remind_after, Some(reminder.until));
    });
}

#[test]
fn remind_later_from_ready_preserves_verified_pair_and_recovers_both_after_rebuild() {
    tauri::async_runtime::block_on(async {
        let directory = RuntimeTestDirectory::new();
        write_fixture_verified_cache(&directory).await;
        let recovery = fixture_cache_store(&directory);
        let policy_store = Arc::new(MemoryUpdatePolicyStore::default());
        let runtime = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)])),
            Arc::new(NoopSnapshotSink),
            recovery.clone(),
            policy_store.clone(),
        )
        .expect("默认策略应能载入");
        assert!(runtime.run_pending_cache_recovery().await);
        let before = runtime.snapshot();
        assert_eq!(before.phase, UpdatePhase::ReadyToInstall);
        let candidate = before.candidate.expect("缓存恢复后应有候选");

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: before.revision,
                intent: UpdateIntent::RemindLater {
                    candidate_id: candidate.id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );

        let after = runtime.snapshot();
        assert_eq!(after.phase, UpdatePhase::ReadyToInstall);
        assert_eq!(after.candidate.as_ref(), Some(&candidate));
        assert!(directory.join("cache-v1/candidate.json").is_file());
        assert!(directory.join("cache-v1/installer.exe").is_file());
        let persisted = policy_store.load().expect("提醒策略应已持久化");
        let reminder = persisted.remind.expect("应保存 reminder");
        assert_eq!(
            (reminder.candidate_id.as_str(), reminder.version.as_str()),
            (candidate.id.as_str(), candidate.version.as_str())
        );

        let rebuilt = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)])),
            Arc::new(NoopSnapshotSink),
            recovery,
            policy_store,
        )
        .expect("已保存策略应能重新载入");
        assert_eq!(rebuilt.snapshot().remind_after, Some(reminder.until));
        assert!(rebuilt.run_pending_cache_recovery().await);
        let recovered = rebuilt.snapshot();
        assert_eq!(recovered.phase, UpdatePhase::ReadyToInstall);
        assert_eq!(recovered.candidate.as_ref(), Some(&candidate));
        assert_eq!(recovered.remind_after, Some(reminder.until));
    });
}

#[test]
fn skip_version_from_ready_persists_version_deletes_verified_pair_and_survives_rebuild() {
    tauri::async_runtime::block_on(async {
        let directory = RuntimeTestDirectory::new();
        write_fixture_verified_cache(&directory).await;
        let recovery = fixture_cache_store(&directory);
        let policy_store = Arc::new(MemoryUpdatePolicyStore::default());
        let runtime = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)])),
            Arc::new(NoopSnapshotSink),
            recovery.clone(),
            policy_store.clone(),
        )
        .expect("默认策略应能载入");
        assert!(runtime.run_pending_cache_recovery().await);
        let ready = runtime.snapshot();
        let candidate = ready.candidate.expect("缓存恢复后应有候选");

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: ready.revision,
                intent: UpdateIntent::SkipVersion {
                    candidate_id: candidate.id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );

        let skipped = runtime.snapshot();
        assert_eq!(skipped.phase, UpdatePhase::Current);
        assert!(skipped.candidate.is_none());
        assert_eq!(skipped.skipped_version.as_deref(), Some("1.2.3"));
        assert!(!directory.join("cache-v1/candidate.json").exists());
        assert!(!directory.join("cache-v1/installer.exe").exists());
        let persisted = policy_store.load().expect("跳过策略应已持久化");
        assert_eq!(persisted.skipped_version.as_deref(), Some("1.2.3"));

        let rebuilt = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)])),
            Arc::new(NoopSnapshotSink),
            recovery,
            policy_store,
        )
        .expect("跳过策略应能重新载入");
        assert_eq!(rebuilt.snapshot().skipped_version.as_deref(), Some("1.2.3"));
        assert!(rebuilt.run_pending_cache_recovery().await);
        let recovered = rebuilt.snapshot();
        assert!(recovered.candidate.is_none());
        assert_eq!(recovered.skipped_version.as_deref(), Some("1.2.3"));
    });
}

#[test]
fn authenticity_quarantine_survives_rebuild_blocks_exact_candidate_and_clears_for_higher() {
    tauri::async_runtime::block_on(async {
        let directory = RuntimeTestDirectory::new();
        let recovery = fixture_cache_store(&directory);
        let policy_store = Arc::new(MemoryUpdatePolicyStore::default());
        let failing_downloader = Arc::new(ScriptedDownloader {
            events: vec![InstallerDownloadEvent::Verifying {
                received_bytes: 9,
                total_bytes: Some(9),
            }],
            outcome: ScriptedDownloadOutcome::AuthenticityFailure,
            events_emitted: None,
        });
        let runtime = runtime_with_recovery_policy_and_downloader(
            Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
                verified_fixture_release(&[]),
            ))])),
            recovery.clone(),
            policy_store.clone(),
            failing_downloader,
        );
        assert!(runtime.run_pending_cache_recovery().await);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);
        let candidate = runtime.snapshot().candidate.expect("检查后应有候选");
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::Download {
                    candidate_id: candidate.id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_download().await);

        let persisted = policy_store.load().expect("隔离策略应已持久化");
        let quarantine = persisted.quarantine.expect("应保存 exact quarantine");
        assert_eq!(
            (
                quarantine.candidate_id.as_str(),
                quarantine.version.as_str(),
                quarantine.reason.as_str(),
            ),
            (
                candidate.id.as_str(),
                candidate.version.as_str(),
                "UPDATE_INSTALLER_SIGNATURE_REJECTED",
            )
        );
        assert!(quarantine.rejected_at > 0);

        let rebuilt = runtime_with_recovery_policy_and_downloader(
            Arc::new(MemoryUpdateSource::with_outcomes([
                Ok(Some(verified_fixture_release(&[]))),
                Ok(Some(NormalizedRelease::new(
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "1.2.4",
                    ["更高版本"],
                    None,
                ))),
            ])),
            recovery,
            policy_store.clone(),
            Arc::new(ScriptedDownloader {
                events: Vec::new(),
                outcome: ScriptedDownloadOutcome::AuthenticityFailure,
                events_emitted: None,
            }),
        );
        assert!(rebuilt.run_pending_cache_recovery().await);
        assert_eq!(
            rebuilt.dispatch(UpdateDispatchRequest {
                expected_revision: rebuilt.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(rebuilt.run_pending_check().await);
        assert_eq!(
            rebuilt.dispatch(UpdateDispatchRequest {
                expected_revision: rebuilt.snapshot().revision,
                intent: UpdateIntent::Download {
                    candidate_id: candidate.id,
                },
            }),
            UpdateReceipt::PolicyBlocked
        );

        assert_eq!(
            rebuilt.dispatch(UpdateDispatchRequest {
                expected_revision: rebuilt.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(rebuilt.run_pending_check().await);
        assert_eq!(
            rebuilt.snapshot().candidate.map(|value| value.version),
            Some("1.2.4".into())
        );
        assert!(policy_store
            .load()
            .expect("更高候选检查后策略应可读")
            .quarantine
            .is_none());
    });
}

#[test]
fn journaled_download_rejection_survives_policy_failure_and_replays_on_restart() {
    tauri::async_runtime::block_on(async {
        let directory = RuntimeTestDirectory::new();
        let recovery = fixture_cache_store(&directory);
        let rejecting_policy = Arc::new(RejectQuarantinePolicyStore::default());
        let runtime = runtime_with_recovery_policy_and_downloader(
            Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
                verified_fixture_release(&[]),
            ))])),
            recovery.clone(),
            rejecting_policy,
            Arc::new(JournaledAuthenticityDownloader {
                updater_directory: directory.0.clone(),
            }),
        );
        assert!(runtime.run_pending_cache_recovery().await);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);
        let candidate = runtime.snapshot().candidate.expect("检查后应有候选");
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::Download {
                    candidate_id: candidate.id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_download().await);
        assert!(directory.join("quarantine-pending-v1.json").is_file());
        assert_eq!(
            runtime.snapshot().fault.map(|fault| fault.code),
            Some("UPDATE_POLICY_TEST_REJECTED".into())
        );
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::PolicyBlocked
        );

        let durable_policy = Arc::new(MemoryUpdatePolicyStore::default());
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
            verified_fixture_release(&[]),
        ))]));
        let rebuilt = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            source.clone(),
            Arc::new(NoopSnapshotSink),
            recovery,
            durable_policy.clone(),
        )
        .expect("重启策略应可载入");
        assert!(rebuilt.run_pending_cache_recovery().await);
        assert_eq!(source.check_count(), 0, "journal replay 不得触发联网检查");
        assert!(!directory.join("quarantine-pending-v1.json").exists());
        let quarantine = durable_policy
            .load()
            .expect("replay 后策略应可读")
            .quarantine
            .expect("replay 必须恢复 exact quarantine");
        assert_eq!(quarantine.candidate_id, candidate.id);
        assert_eq!(quarantine.version, candidate.version);
        assert_eq!(quarantine.reason, "UPDATE_INSTALLER_SIGNATURE_REJECTED");
        assert!(rebuilt.snapshot().candidate.is_none());
    });
}

#[test]
fn quarantine_rejects_same_version_republished_identity_without_an_in_memory_candidate() {
    tauri::async_runtime::block_on(async {
        let directory = RuntimeTestDirectory::new();
        let trusted = verified_fixture_evidence();
        let policy = UpdatePolicySnapshot {
            quarantine: Some(UpdatePolicyQuarantine {
                candidate_id: trusted.candidate_id().as_str().into(),
                version: "1.2.3".into(),
                reason: "UPDATE_INSTALLER_SIGNATURE_REJECTED".into(),
                rejected_at: 1,
            }),
            ..UpdatePolicySnapshot::default()
        };
        let policy_store = Arc::new(MemoryUpdatePolicyStore::new(policy));
        let runtime = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            Arc::new(MemoryUpdateSource::with_outcomes([
                Ok(Some(NormalizedRelease::new(
                    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "1.2.3",
                    ["同版换资产"],
                    None,
                ))),
                Ok(Some(NormalizedRelease::new(
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "1.2.4",
                    ["严格更高版本"],
                    None,
                ))),
            ])),
            Arc::new(NoopSnapshotSink),
            fixture_cache_store(&directory),
            policy_store.clone(),
        )
        .expect("quarantine 策略应可载入");
        assert!(runtime.run_pending_cache_recovery().await);

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);
        let rejected = runtime.snapshot();
        assert!(rejected.candidate.is_none());
        assert_eq!(
            rejected.fault.as_ref().map(|fault| fault.code.as_str()),
            Some("UPDATE_CANDIDATE_IDENTITY_CONFLICT")
        );
        assert!(policy_store.load().unwrap().quarantine.is_some());

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: rejected.revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);
        assert_eq!(
            runtime
                .snapshot()
                .candidate
                .map(|candidate| candidate.version),
            Some("1.2.4".into())
        );
        assert!(policy_store.load().unwrap().quarantine.is_none());
    });
}

#[test]
fn successful_check_persists_checked_at_and_restores_it_on_runtime_rebuild() {
    tauri::async_runtime::block_on(async {
        let directory = RuntimeTestDirectory::new();
        let recovery = fixture_cache_store(&directory);
        let policy_store = Arc::new(MemoryUpdatePolicyStore::default());
        let runtime = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)])),
            Arc::new(NoopSnapshotSink),
            recovery.clone(),
            policy_store.clone(),
        )
        .expect("默认策略应能载入");
        assert!(runtime.run_pending_cache_recovery().await);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);

        let persisted_checked_at = policy_store
            .load()
            .expect("成功检查后的策略应可读")
            .last_successful_check_at
            .expect("成功检查必须写入 checked_at");
        assert!(persisted_checked_at > 0);
        assert_eq!(runtime.snapshot().checked_at, Some(persisted_checked_at));

        let rebuilt = UpdateRuntime::with_recovery_and_policy(
            "0.1.0",
            Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)])),
            Arc::new(NoopSnapshotSink),
            recovery,
            policy_store,
        )
        .expect("成功检查时间应能重新载入");
        assert_eq!(rebuilt.snapshot().checked_at, Some(persisted_checked_at));
    });
}

#[test]
fn runtime_constructor_fails_closed_for_corrupt_memory_or_native_policy() {
    let directory = RuntimeTestDirectory::new();
    let recovery = fixture_cache_store(&directory);
    let invalid_memory = Arc::new(MemoryUpdatePolicyStore::new(UpdatePolicySnapshot {
        schema_version: 99,
        ..UpdatePolicySnapshot::default()
    }));
    let memory_error = UpdateRuntime::with_recovery_and_policy(
        "0.1.0",
        Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)])),
        Arc::new(NoopSnapshotSink),
        recovery.clone(),
        invalid_memory,
    )
    .err()
    .expect("非法内存策略必须阻止 Runtime 构造");
    assert_eq!(memory_error.code(), "UPDATE_POLICY_SCHEMA_REJECTED");

    let native = Arc::new(NativeUpdatePolicyStore::for_app_data(&directory.0));
    std::fs::write(native.path(), b"{not-json").expect("测试应能写入损坏的 native policy");
    let native_error = UpdateRuntime::with_recovery_and_policy(
        "0.1.0",
        Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)])),
        Arc::new(NoopSnapshotSink),
        recovery,
        native,
    )
    .err()
    .expect("损坏 native 策略必须阻止 Runtime 构造");
    assert_eq!(native_error.code(), "UPDATE_POLICY_INVALID_JSON");
}

#[test]
fn startup_recovery_restores_ready_to_install_without_calling_the_source() {
    tauri::async_runtime::block_on(async {
        let directory = RuntimeTestDirectory::new();
        let cache = directory.join("cache-v1");
        std::fs::create_dir(&cache).unwrap();
        std::fs::write(cache.join("installer.exe"), b"installer").unwrap();
        let recovery =
            Arc::new(cache::VerifiedCacheStore::new(&directory.0, fixture_public_key()).unwrap());
        recovery
            .commit_verified(
                &verified_fixture_evidence(),
                9,
                "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
                10,
                11,
            )
            .await
            .unwrap();
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)]));
        let sink = Arc::new(MemorySnapshotSink::default());
        let runtime = UpdateRuntime::with_recovery("0.1.0", source.clone(), sink, recovery);

        assert_eq!(runtime.snapshot().phase, UpdatePhase::RecoveringCache);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::PolicyBlocked
        );
        assert!(runtime.run_pending_cache_recovery().await);

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::ReadyToInstall);
        assert_eq!(
            snapshot.candidate.unwrap().id,
            "1f524da9660c738e349f342d1e3f0bc9da3b28b9c4842636475ccdde59b9ee0e"
        );
        assert_eq!(source.check_count(), 0);
    });
}

#[test]
fn startup_recovery_projects_a_stable_install_fault_without_losing_ready_candidate() {
    tauri::async_runtime::block_on(async {
        let directory = RuntimeTestDirectory::new();
        write_fixture_verified_cache(&directory).await;
        let recovery = Arc::new(RecoveryWithStableFault {
            inner: fixture_cache_store(&directory),
        });
        let runtime = UpdateRuntime::with_recovery(
            "0.1.0",
            Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)])),
            Arc::new(NoopSnapshotSink),
            recovery,
        );

        assert!(runtime.run_pending_cache_recovery().await);

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::ReadyToInstall);
        assert!(snapshot.candidate.is_some());
        assert_eq!(
            snapshot.fault.as_ref().map(|fault| fault.code.as_str()),
            Some("UPDATE_INSTALL_NOT_APPLIED")
        );
        assert_eq!(
            snapshot.fault.as_ref().map(|fault| fault.stage),
            Some(UpdateFaultStage::Cache)
        );
    });
}

#[test]
fn web_reconciliation_fault_can_rearm_exact_cache_recovery_after_listener_reconnect() {
    tauri::async_runtime::block_on(async {
        let recovery = Arc::new(ScriptedStartupRecovery::new([
            CacheRecoveryOutcome::Blocked(CacheRecoveryFault {
                code: "UPDATE_WEB_QUIESCENCE_RECONCILIATION_REQUIRED",
                message: "Web 播放静默证据尚未协调，已保留更新缓存",
            }),
            CacheRecoveryOutcome::Empty {
                fault: None,
                quarantine: None,
            },
        ]));
        let sink = Arc::new(MemorySnapshotSink::default());
        let runtime = UpdateRuntime::with_recovery(
            "0.1.0",
            Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)])),
            sink,
            recovery.clone(),
        );

        assert!(runtime.run_pending_cache_recovery().await);
        let blocked = runtime.snapshot();
        assert_eq!(blocked.phase, UpdatePhase::Idle);
        assert_eq!(
            blocked.fault.as_ref().map(|fault| fault.code.as_str()),
            Some("UPDATE_WEB_QUIESCENCE_RECONCILIATION_REQUIRED")
        );

        assert!(runtime.rearm_web_reconciliation_recovery());
        let rearmed = runtime.snapshot();
        assert_eq!(rearmed.revision, blocked.revision + 1);
        assert_eq!(rearmed.phase, UpdatePhase::RecoveringCache);
        assert_eq!(
            rearmed.operation.as_ref().map(|operation| operation.kind),
            Some(UpdateOperationKind::CacheRevalidation)
        );
        assert!(rearmed.fault.is_none());
        assert!(!runtime.rearm_web_reconciliation_recovery());

        assert!(runtime.run_pending_cache_recovery().await);
        let recovered = runtime.snapshot();
        assert_eq!(recovered.phase, UpdatePhase::Idle);
        assert!(recovered.fault.is_none());
        assert_eq!(recovery.calls(), 2);
    });
}

#[test]
fn authenticity_policy_and_other_reconciliation_blocks_cannot_rearm_on_web_reconnect() {
    tauri::async_runtime::block_on(async {
        for (code, message) in [
            (
                "UPDATE_CACHE_AUTHENTICITY_REJECTED",
                "已验证更新缓存无法重新通过来源与签名验证",
            ),
            ("UPDATE_POLICY_WRITE_FAILED", "无法持久化本机更新策略"),
            (
                "UPDATE_INSTALL_RECONCILIATION_REQUIRED",
                "安装尝试证据尚未协调，已保留更新缓存",
            ),
            (
                "UPDATE_WEB_QUIESCENCE_STALE_IDENTITY",
                "Web 播放静默 identity 不匹配",
            ),
        ] {
            let recovery = Arc::new(ScriptedStartupRecovery::new([
                CacheRecoveryOutcome::Blocked(CacheRecoveryFault { code, message }),
            ]));
            let runtime = UpdateRuntime::with_recovery(
                "0.1.0",
                Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)])),
                Arc::new(NoopSnapshotSink),
                recovery.clone(),
            );

            assert!(runtime.run_pending_cache_recovery().await);
            let blocked = runtime.snapshot();
            assert!(!runtime.rearm_web_reconciliation_recovery());
            assert_eq!(runtime.snapshot(), blocked);
            assert_eq!(recovery.calls(), 1);
        }
    });
}

#[test]
fn accepted_check_commits_checking_then_available() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
            NormalizedRelease::new(
                "candidate-0.2.0",
                "0.2.0",
                ["修复播放链路"],
                Some("2026-07-31T00:00:00Z"),
            ),
        ))]));
        let published = Arc::new(MemorySnapshotSink::default());
        let runtime = UpdateRuntime::new("0.1.0", source.clone(), published.clone());

        let receipt = runtime.dispatch(UpdateDispatchRequest {
            expected_revision: 0,
            intent: UpdateIntent::CheckNow,
        });

        assert_eq!(receipt, UpdateReceipt::Accepted);
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Checking);
        assert_eq!(runtime.snapshot().revision, 1);
        assert_eq!(source.check_count(), 0);

        assert!(runtime.run_pending_check().await);

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Available);
        assert_eq!(snapshot.revision, 2);
        assert_eq!(
            snapshot.candidate.as_ref().map(|value| value.id.as_str()),
            Some("candidate-0.2.0")
        );
        assert_eq!(source.check_count(), 1);
        assert_eq!(published.revisions(), vec![1, 2]);
    });
}

#[test]
fn candidate_intent_rejects_an_identity_not_owned_by_the_snapshot() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
            NormalizedRelease::new("candidate-0.2.0", "0.2.0", std::iter::empty::<&str>(), None),
        ))]));
        let runtime = UpdateRuntime::with_noop_sink("0.1.0", source);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 0,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download {
                    candidate_id: "stale-candidate".into(),
                },
            }),
            UpdateReceipt::StaleCandidate
        );
        assert_eq!(runtime.snapshot().revision, 2);
    });
}

#[test]
fn intent_contract_uses_the_web_port_field_names() {
    let json = serde_json::to_value(UpdateIntent::Download {
        candidate_id: "candidate-0.2.0".into(),
    })
    .expect("serialize update intent");

    assert_eq!(
        json,
        serde_json::json!({
            "kind": "download",
            "candidateId": "candidate-0.2.0",
        })
    );
}

#[test]
fn disabled_runtime_rejects_every_intent_without_publishing() {
    let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)]));
    let published = Arc::new(MemorySnapshotSink::default());
    let runtime = UpdateRuntime::disabled("0.1.0", source.clone(), published.clone());

    assert_eq!(
        runtime.dispatch(UpdateDispatchRequest {
            expected_revision: 0,
            intent: UpdateIntent::CheckNow,
        }),
        UpdateReceipt::RuntimeUnavailable
    );
    assert_eq!(runtime.snapshot().phase, UpdatePhase::Disabled);
    assert_eq!(runtime.snapshot().revision, 0);
    assert_eq!(source.check_count(), 0);
    assert!(published.revisions().is_empty());
}

#[test]
fn check_is_single_flight_and_does_not_start_a_second_source_call() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)]));
        let runtime = UpdateRuntime::with_noop_sink("0.1.0", source.clone());

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 0,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 1,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::InvalidOrder
        );
        assert_eq!(source.check_count(), 0);

        assert!(runtime.run_pending_check().await);
        assert_eq!(source.check_count(), 1);
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Current);
    });
}

#[test]
fn operation_intent_rejects_an_identity_not_owned_by_the_snapshot() {
    let runtime = UpdateRuntime::with_noop_sink(
        "0.1.0",
        Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)])),
    );

    assert_eq!(
        runtime.dispatch(UpdateDispatchRequest {
            expected_revision: 0,
            intent: UpdateIntent::CancelDownload {
                operation_id: "stale-operation".into(),
            },
        }),
        UpdateReceipt::StaleOperation
    );
    assert_eq!(runtime.snapshot().revision, 0);
}

#[test]
fn trusted_candidate_is_retained_for_fixed_release_page_projection() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
            verified_fixture_release(&[]),
        ))]));
        let runtime = UpdateRuntime::with_noop_sink("0.1.0", source);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 0,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);

        assert_eq!(
            runtime.release_page_url(Some(
                "1f524da9660c738e349f342d1e3f0bc9da3b28b9c4842636475ccdde59b9ee0e",
            )),
            Some("https://github.com/zzstar101/Mineradio-Tauri/releases/tag/v1.2.3".into())
        );
        assert_eq!(runtime.release_page_url(Some("stale-candidate")), None);
        assert_eq!(
            runtime.release_page_url(None),
            Some("https://github.com/zzstar101/Mineradio-Tauri/releases".into())
        );
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::OpenRelease {
                    candidate_id:
                        "1f524da9660c738e349f342d1e3f0bc9da3b28b9c4842636475ccdde59b9ee0e".into(),
                },
            }),
            UpdateReceipt::Accepted
        );
    });
}

#[test]
fn source_failure_projects_a_typed_fault_without_losing_runtime_authority() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Err(
            UpdateSourceError {
                code: "UPDATE_MANIFEST_REJECTED".into(),
                retryable: false,
                message: "manifest target mismatch".into(),
            },
        )]));
        let runtime = UpdateRuntime::with_noop_sink("0.1.0", source);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 0,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Idle);
        assert_eq!(snapshot.revision, 2);
        assert_eq!(
            snapshot.fault,
            Some(UpdateFaultView {
                stage: UpdateFaultStage::Check,
                code: "UPDATE_MANIFEST_REJECTED".into(),
                retryable: false,
                message: "manifest target mismatch".into(),
            })
        );
    });
}

#[test]
fn recheck_none_or_same_candidate_preserves_available_authority() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([
            Ok(Some(NormalizedRelease::new(
                "candidate-0.2.0",
                "0.2.0",
                ["初次说明"],
                None,
            ))),
            Ok(None),
            Ok(Some(NormalizedRelease::new(
                "candidate-0.2.0",
                "0.2.0",
                ["刷新说明"],
                None,
            ))),
        ]));
        let runtime = UpdateRuntime::with_noop_sink("0.1.0", source);

        for expected_revision in [0, 2, 4] {
            assert_eq!(
                runtime.dispatch(UpdateDispatchRequest {
                    expected_revision,
                    intent: UpdateIntent::CheckNow,
                }),
                UpdateReceipt::Accepted
            );
            assert!(runtime.run_pending_check().await);
            assert_eq!(runtime.snapshot().phase, UpdatePhase::Available);
            assert_eq!(
                runtime
                    .snapshot()
                    .candidate
                    .as_ref()
                    .map(|value| value.id.as_str()),
                Some("candidate-0.2.0")
            );
        }
        assert_eq!(
            runtime.snapshot().candidate.unwrap().notes,
            vec!["刷新说明"]
        );
    });
}

#[test]
fn higher_candidate_replaces_but_rollback_or_same_version_conflict_fail_closed() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([
            Ok(Some(NormalizedRelease::new(
                "candidate-0.2.0",
                "0.2.0",
                std::iter::empty::<&str>(),
                None,
            ))),
            Ok(Some(NormalizedRelease::new(
                "candidate-0.3.0",
                "0.3.0",
                std::iter::empty::<&str>(),
                None,
            ))),
            Ok(Some(NormalizedRelease::new(
                "conflicting-0.3.0",
                "0.3.0",
                std::iter::empty::<&str>(),
                None,
            ))),
            Ok(Some(NormalizedRelease::new(
                "candidate-0.2.5",
                "0.2.5",
                std::iter::empty::<&str>(),
                None,
            ))),
        ]));
        let runtime = UpdateRuntime::with_noop_sink("0.1.0", source);

        for expected_revision in [0, 2] {
            assert_eq!(
                runtime.dispatch(UpdateDispatchRequest {
                    expected_revision,
                    intent: UpdateIntent::CheckNow,
                }),
                UpdateReceipt::Accepted
            );
            assert!(runtime.run_pending_check().await);
        }
        assert_eq!(
            runtime
                .snapshot()
                .candidate
                .as_ref()
                .map(|value| value.id.as_str()),
            Some("candidate-0.3.0")
        );

        for (expected_revision, fault_code) in [
            (4, "UPDATE_CANDIDATE_IDENTITY_CONFLICT"),
            (6, "UPDATE_CANDIDATE_ROLLBACK_REJECTED"),
        ] {
            assert_eq!(
                runtime.dispatch(UpdateDispatchRequest {
                    expected_revision,
                    intent: UpdateIntent::CheckNow,
                }),
                UpdateReceipt::Accepted
            );
            assert!(runtime.run_pending_check().await);
            let snapshot = runtime.snapshot();
            assert_eq!(snapshot.phase, UpdatePhase::Available);
            assert_eq!(
                snapshot.candidate.as_ref().map(|value| value.id.as_str()),
                Some("candidate-0.3.0")
            );
            assert_eq!(
                snapshot.fault.as_ref().map(|fault| fault.code.as_str()),
                Some(fault_code)
            );
        }
    });
}

#[test]
fn candidate_identity_cannot_be_reused_for_a_different_version() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([
            Ok(Some(NormalizedRelease::new(
                "candidate-reused",
                "0.2.0",
                std::iter::empty::<&str>(),
                None,
            ))),
            Ok(Some(NormalizedRelease::new(
                "candidate-reused",
                "0.3.0",
                std::iter::empty::<&str>(),
                None,
            ))),
        ]));
        let runtime = UpdateRuntime::with_noop_sink("0.1.0", source);

        for expected_revision in [0, 2] {
            assert_eq!(
                runtime.dispatch(UpdateDispatchRequest {
                    expected_revision,
                    intent: UpdateIntent::CheckNow,
                }),
                UpdateReceipt::Accepted
            );
            assert!(runtime.run_pending_check().await);
        }

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Available);
        assert_eq!(
            snapshot
                .candidate
                .as_ref()
                .map(|candidate| (candidate.id.as_str(), candidate.version.as_str())),
            Some(("candidate-reused", "0.2.0"))
        );
        assert_eq!(
            snapshot.fault.as_ref().map(|fault| fault.code.as_str()),
            Some("UPDATE_CANDIDATE_IDENTITY_CONFLICT")
        );
    });
}

#[test]
fn recheck_matrix_preserves_available_and_ready_to_install_authority() {
    #[derive(Debug, Clone, Copy)]
    enum RefreshCase {
        None,
        Same,
        Higher,
        SameVersionConflict,
        Lower,
        Error,
    }

    tauri::async_runtime::block_on(async {
        for phase in [UpdatePhase::Available, UpdatePhase::ReadyToInstall] {
            for case in [
                RefreshCase::None,
                RefreshCase::Same,
                RefreshCase::Higher,
                RefreshCase::SameVersionConflict,
                RefreshCase::Lower,
                RefreshCase::Error,
            ] {
                let outcome = match case {
                    RefreshCase::None => Ok(None),
                    RefreshCase::Same => Ok(Some(NormalizedRelease::new(
                        "candidate-0.3.0",
                        "0.3.0",
                        ["刷新说明"],
                        None,
                    ))),
                    RefreshCase::Higher => Ok(Some(NormalizedRelease::new(
                        "candidate-0.4.0",
                        "0.4.0",
                        ["更高版本"],
                        None,
                    ))),
                    RefreshCase::SameVersionConflict => Ok(Some(NormalizedRelease::new(
                        "conflicting-0.3.0",
                        "0.3.0",
                        std::iter::empty::<&str>(),
                        None,
                    ))),
                    RefreshCase::Lower => Ok(Some(NormalizedRelease::new(
                        "candidate-0.2.0",
                        "0.2.0",
                        std::iter::empty::<&str>(),
                        None,
                    ))),
                    RefreshCase::Error => Err(UpdateSourceError {
                        code: "UPDATE_SOURCE_OFFLINE".into(),
                        retryable: true,
                        message: "更新源暂时不可用".into(),
                    }),
                };
                let runtime = UpdateRuntime::with_noop_sink(
                    "0.1.0",
                    Arc::new(MemoryUpdateSource::with_outcomes([outcome])),
                );
                runtime
                    .state
                    .lock()
                    .expect("update runtime state poisoned")
                    .commit_candidate(
                        NormalizedRelease::new("candidate-0.3.0", "0.3.0", ["原始说明"], None),
                        phase,
                    );

                assert_eq!(
                    runtime.dispatch(UpdateDispatchRequest {
                        expected_revision: 0,
                        intent: UpdateIntent::CheckNow,
                    }),
                    UpdateReceipt::Accepted,
                    "phase={phase:?}, case={case:?}"
                );
                assert!(runtime.run_pending_check().await);

                let snapshot = runtime.snapshot();
                let (expected_phase, expected_id, expected_fault) = match case {
                    RefreshCase::None | RefreshCase::Same => (phase, "candidate-0.3.0", None),
                    RefreshCase::Higher => (UpdatePhase::Available, "candidate-0.4.0", None),
                    RefreshCase::SameVersionConflict => (
                        phase,
                        "candidate-0.3.0",
                        Some("UPDATE_CANDIDATE_IDENTITY_CONFLICT"),
                    ),
                    RefreshCase::Lower => (
                        phase,
                        "candidate-0.3.0",
                        Some("UPDATE_CANDIDATE_ROLLBACK_REJECTED"),
                    ),
                    RefreshCase::Error => (phase, "candidate-0.3.0", Some("UPDATE_SOURCE_OFFLINE")),
                };
                assert_eq!(snapshot.phase, expected_phase, "case={case:?}");
                assert_eq!(
                    snapshot
                        .candidate
                        .as_ref()
                        .map(|candidate| candidate.id.as_str()),
                    Some(expected_id),
                    "phase={phase:?}, case={case:?}"
                );
                assert_eq!(
                    snapshot.fault.as_ref().map(|fault| fault.code.as_str()),
                    expected_fault,
                    "phase={phase:?}, case={case:?}"
                );
                if matches!(case, RefreshCase::Same) {
                    assert_eq!(
                        snapshot.candidate.expect("same candidate 应保留").notes,
                        vec!["刷新说明"]
                    );
                }
            }
        }
    });
}

enum ScriptedDownloadOutcome {
    Success,
    SuccessAt {
        path: PathBuf,
        before_return: Option<Arc<tokio::sync::Notify>>,
    },
    AuthenticityFailure,
    WaitForCancellation,
    CancelledAfterRelease {
        cancel_observed: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    },
    NetworkFailureAfterCancellation,
    NeverCompletes,
    SuccessAfterCancellation {
        cancel_observed: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    },
    AuthenticityAfterRelease(Arc<tokio::sync::Notify>),
}

enum ScriptedInstallStep {
    Complete(Result<UpdateInstallOutcome, UpdateInstallFault>),
    Pending(Arc<tokio::sync::Notify>),
}

struct ScriptedInstaller {
    install_steps: Mutex<VecDeque<ScriptedInstallStep>>,
    recovery_steps: Mutex<VecDeque<Result<UpdateInstallOutcome, UpdateInstallFault>>>,
    calls: Mutex<Vec<(&'static str, String)>>,
}

impl ScriptedInstaller {
    fn new(
        install_steps: impl IntoIterator<Item = ScriptedInstallStep>,
        recovery_steps: impl IntoIterator<Item = Result<UpdateInstallOutcome, UpdateInstallFault>>,
    ) -> Self {
        Self {
            install_steps: Mutex::new(install_steps.into_iter().collect()),
            recovery_steps: Mutex::new(recovery_steps.into_iter().collect()),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<(&'static str, String)> {
        self.calls.lock().expect("install calls poisoned").clone()
    }
}

impl UpdateInstaller for ScriptedInstaller {
    fn install_exact<'a>(
        &'a self,
        candidate_id: String,
        _artifact: VerifiedInstallerArtifact,
        _started_at: u64,
    ) -> Pin<Box<dyn Future<Output = Result<UpdateInstallOutcome, UpdateInstallFault>> + Send + 'a>>
    {
        self.calls
            .lock()
            .expect("install calls poisoned")
            .push(("install", candidate_id));
        let step = self
            .install_steps
            .lock()
            .expect("install steps poisoned")
            .pop_front()
            .expect("测试必须提供 install step");
        Box::pin(async move {
            match step {
                ScriptedInstallStep::Complete(result) => result,
                ScriptedInstallStep::Pending(entered) => {
                    entered.notify_one();
                    std::future::pending().await
                }
            }
        })
    }

    fn retry_recovery(
        &self,
        _updated_at: u64,
    ) -> Pin<Box<dyn Future<Output = Result<UpdateInstallOutcome, UpdateInstallFault>> + Send + '_>>
    {
        self.calls
            .lock()
            .expect("install calls poisoned")
            .push(("retry", String::new()));
        let result = self
            .recovery_steps
            .lock()
            .expect("recovery steps poisoned")
            .pop_front()
            .expect("测试必须提供 recovery step");
        Box::pin(async move { result })
    }
}

struct RuntimeTestDirectory(PathBuf);

impl RuntimeTestDirectory {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(1);
        let path = std::env::temp_dir().join(format!(
            "mineradio-updater-runtime-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).expect("runtime 测试目录应能创建");
        Self(path)
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for RuntimeTestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct RejectQuarantinePolicyStore {
    snapshot: Mutex<UpdatePolicySnapshot>,
}

impl UpdatePolicyStore for RejectQuarantinePolicyStore {
    fn load(&self) -> Result<UpdatePolicySnapshot, UpdatePolicyStoreError> {
        Ok(self
            .snapshot
            .lock()
            .expect("test policy store poisoned")
            .clone())
    }

    fn save(&self, snapshot: &UpdatePolicySnapshot) -> Result<(), UpdatePolicyStoreError> {
        if snapshot.quarantine.is_some() {
            return Err(UpdatePolicyStoreError::runtime(
                "UPDATE_POLICY_TEST_REJECTED",
                "测试策略存储拒绝 quarantine",
            ));
        }
        *self.snapshot.lock().expect("test policy store poisoned") = snapshot.clone();
        Ok(())
    }
}

struct JournaledAuthenticityDownloader {
    updater_directory: PathBuf,
}

impl InstallerDownloader for JournaledAuthenticityDownloader {
    fn run<'a>(
        &'a self,
        plan: VerifiedInstallerPlan,
        _cancellation: CancellationToken,
        _events: &'a dyn InstallerDownloadEvents,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<VerifiedInstallerArtifact, InstallerDownloadError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            let error = InstallerDownloadError::fake_authenticity_failure();
            let pending = cache::persist_pending_quarantine(
                &self.updater_directory,
                plan.candidate_id().as_str(),
                plan.version(),
                error.code(),
            )
            .map_err(|failure| InstallerDownloadError::policy_failure(failure.code))?;
            Err(error.with_pending_rejection(pending))
        })
    }
}

struct PendingUpdateSource {
    entered: Arc<tokio::sync::Notify>,
}

impl UpdateSource for PendingUpdateSource {
    fn check(
        &self,
        _request: CheckRequest,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<NormalizedRelease>, UpdateSourceError>> + Send + '_>,
    > {
        Box::pin(async move {
            self.entered.notify_one();
            std::future::pending().await
        })
    }
}

struct ReentrantSnapshotSink {
    runtime: Mutex<Option<Weak<UpdateRuntime>>>,
    revisions: Mutex<Vec<u64>>,
    reentered: AtomicBool,
    receipt: Mutex<Option<UpdateReceipt>>,
}

impl ReentrantSnapshotSink {
    fn new() -> Self {
        Self {
            runtime: Mutex::new(None),
            revisions: Mutex::new(Vec::new()),
            reentered: AtomicBool::new(false),
            receipt: Mutex::new(None),
        }
    }

    fn attach(&self, runtime: &Arc<UpdateRuntime>) {
        *self.runtime.lock().expect("reentrant runtime poisoned") = Some(Arc::downgrade(runtime));
    }

    fn revisions(&self) -> Vec<u64> {
        self.revisions
            .lock()
            .expect("reentrant revisions poisoned")
            .clone()
    }
}

impl UpdateSnapshotSink for ReentrantSnapshotSink {
    fn publish(&self, snapshot: UpdateSnapshot) {
        self.revisions
            .lock()
            .expect("reentrant revisions poisoned")
            .push(snapshot.revision);
        if snapshot.phase != UpdatePhase::Available || self.reentered.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(candidate_id) = snapshot.candidate.map(|candidate| candidate.id) else {
            return;
        };
        let runtime = self
            .runtime
            .lock()
            .expect("reentrant runtime poisoned")
            .as_ref()
            .and_then(Weak::upgrade);
        let Some(runtime) = runtime else {
            return;
        };
        let receipt = runtime.dispatch(UpdateDispatchRequest {
            expected_revision: snapshot.revision,
            intent: UpdateIntent::Download { candidate_id },
        });
        *self.receipt.lock().expect("reentrant receipt poisoned") = Some(receipt);
    }
}

struct ScriptedDownloader {
    events: Vec<InstallerDownloadEvent>,
    outcome: ScriptedDownloadOutcome,
    events_emitted: Option<Arc<tokio::sync::Notify>>,
}

impl InstallerDownloader for ScriptedDownloader {
    fn run<'a>(
        &'a self,
        plan: VerifiedInstallerPlan,
        cancellation: CancellationToken,
        events: &'a dyn InstallerDownloadEvents,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<VerifiedInstallerArtifact, InstallerDownloadError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            for event in self.events.iter().cloned() {
                if !events.emit(event) {
                    return Err(InstallerDownloadError::stale());
                }
            }
            if let Some(events_emitted) = &self.events_emitted {
                events_emitted.notify_one();
            }
            match &self.outcome {
                ScriptedDownloadOutcome::Success => {
                    Ok(VerifiedInstallerArtifact::fake(plan.candidate_id().clone()))
                }
                ScriptedDownloadOutcome::SuccessAt {
                    path,
                    before_return,
                } => {
                    if let Some(before_return) = before_return {
                        before_return.notify_one();
                    }
                    Ok(VerifiedInstallerArtifact::fake_at(
                        plan.candidate_id().clone(),
                        path.clone(),
                    ))
                }
                ScriptedDownloadOutcome::AuthenticityFailure => {
                    Err(InstallerDownloadError::fake_authenticity_failure())
                }
                ScriptedDownloadOutcome::WaitForCancellation => {
                    cancellation.cancelled().await;
                    Err(InstallerDownloadError::cancelled())
                }
                ScriptedDownloadOutcome::CancelledAfterRelease {
                    cancel_observed,
                    release,
                } => {
                    cancellation.cancelled().await;
                    cancel_observed.notify_one();
                    release.notified().await;
                    Err(InstallerDownloadError::cancelled())
                }
                ScriptedDownloadOutcome::NetworkFailureAfterCancellation => {
                    cancellation.cancelled().await;
                    Err(InstallerDownloadError::fake_network_failure())
                }
                ScriptedDownloadOutcome::NeverCompletes => std::future::pending().await,
                ScriptedDownloadOutcome::SuccessAfterCancellation {
                    cancel_observed,
                    release,
                } => {
                    cancellation.cancelled().await;
                    cancel_observed.notify_one();
                    release.notified().await;
                    Ok(VerifiedInstallerArtifact::fake(plan.candidate_id().clone()))
                }
                ScriptedDownloadOutcome::AuthenticityAfterRelease(release) => {
                    release.notified().await;
                    Err(InstallerDownloadError::fake_authenticity_failure())
                }
            }
        })
    }
}

async fn runtime_with_verified_candidate(
    downloader: Arc<dyn InstallerDownloader>,
    sink: Arc<MemorySnapshotSink>,
) -> UpdateRuntime {
    let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
        verified_fixture_release(&[]),
    ))]));
    let runtime = UpdateRuntime::with_downloader("0.1.0", source, sink, downloader);
    assert_eq!(
        runtime.dispatch(UpdateDispatchRequest {
            expected_revision: 0,
            intent: UpdateIntent::CheckNow,
        }),
        UpdateReceipt::Accepted
    );
    assert!(runtime.run_pending_check().await);
    runtime
}

async fn runtime_ready_to_install(installer: Arc<dyn UpdateInstaller>) -> UpdateRuntime {
    let sink = Arc::new(MemorySnapshotSink::default());
    let downloader = Arc::new(ScriptedDownloader {
        events: vec![InstallerDownloadEvent::Verifying {
            received_bytes: 9,
            total_bytes: Some(9),
        }],
        outcome: ScriptedDownloadOutcome::Success,
        events_emitted: None,
    });
    let mut runtime = runtime_with_verified_candidate(downloader, sink).await;
    let available = runtime.snapshot();
    let candidate_id = available.candidate.expect("应有可信候选").id;
    assert_eq!(
        runtime.dispatch(UpdateDispatchRequest {
            expected_revision: available.revision,
            intent: UpdateIntent::Download { candidate_id },
        }),
        UpdateReceipt::Accepted
    );
    assert!(runtime.run_pending_download().await);
    assert_eq!(runtime.snapshot().phase, UpdatePhase::ReadyToInstall);
    runtime.installer = Some(installer);
    runtime
}

#[test]
fn interrupted_check_runner_restores_a_stable_phase_and_releases_operation_authority() {
    tauri::async_runtime::block_on(async {
        let entered = Arc::new(tokio::sync::Notify::new());
        let source = Arc::new(PendingUpdateSource {
            entered: entered.clone(),
        });
        let sink = Arc::new(MemorySnapshotSink::default());
        let runtime = Arc::new(UpdateRuntime::new("0.1.0", source, sink.clone()));
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 0,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        let task_runtime = runtime.clone();
        let task =
            tauri::async_runtime::spawn(async move { task_runtime.run_pending_check().await });
        entered.notified().await;

        task.abort();
        let _ = task.await;

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Idle);
        assert!(snapshot.operation.is_none());
        assert_eq!(
            snapshot.fault.as_ref().map(|fault| fault.code.as_str()),
            Some("UPDATE_CHECK_INTERRUPTED")
        );
        assert_eq!(sink.revisions(), vec![1, 2]);
    });
}

#[test]
fn snapshot_sink_can_reenter_dispatch_without_deadlock_or_revision_reordering() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
            verified_fixture_release(&[]),
        ))]));
        let sink = Arc::new(ReentrantSnapshotSink::new());
        let downloader = Arc::new(ScriptedDownloader {
            events: Vec::new(),
            outcome: ScriptedDownloadOutcome::Success,
            events_emitted: None,
        });
        let runtime = Arc::new(UpdateRuntime::with_downloader(
            "0.1.0",
            source,
            sink.clone(),
            downloader,
        ));
        sink.attach(&runtime);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 0,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );

        assert!(runtime.run_pending_check().await);
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Downloading);
        assert_eq!(sink.revisions(), vec![1, 2, 3]);
        assert_eq!(
            *sink.receipt.lock().expect("reentrant receipt poisoned"),
            Some(UpdateReceipt::Accepted)
        );
    });
}

#[test]
fn trusted_download_commits_throttled_progress_and_ready_edges_in_revision_order() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![
                InstallerDownloadEvent::Opened {
                    total_bytes: Some(9),
                    elapsed_ms: 0,
                },
                InstallerDownloadEvent::Progress {
                    received_bytes: 1,
                    total_bytes: Some(9),
                    elapsed_ms: 10,
                },
                InstallerDownloadEvent::Progress {
                    received_bytes: 4,
                    total_bytes: Some(9),
                    elapsed_ms: 99,
                },
                InstallerDownloadEvent::Progress {
                    received_bytes: 5,
                    total_bytes: Some(9),
                    elapsed_ms: 100,
                },
                InstallerDownloadEvent::Progress {
                    received_bytes: 8,
                    total_bytes: Some(9),
                    elapsed_ms: 199,
                },
                InstallerDownloadEvent::Progress {
                    received_bytes: 9,
                    total_bytes: Some(9),
                    elapsed_ms: 200,
                },
                InstallerDownloadEvent::Verifying {
                    received_bytes: 9,
                    total_bytes: Some(9),
                },
            ],
            outcome: ScriptedDownloadOutcome::Success,
            events_emitted: None,
        });
        let runtime = runtime_with_verified_candidate(downloader, sink.clone()).await;
        let candidate_id = runtime.snapshot().candidate.unwrap().id;

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Downloading);
        assert!(runtime.run_pending_download().await);

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::ReadyToInstall);
        assert!(snapshot.operation.is_none());
        assert!(snapshot.fault.is_none());
        assert_eq!(sink.revisions(), (1..=7).collect::<Vec<_>>());
    });
}

#[test]
fn retry_open_and_progress_events_share_one_global_ten_hertz_gate() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![
                InstallerDownloadEvent::Opened {
                    total_bytes: Some(9),
                    elapsed_ms: 0,
                },
                InstallerDownloadEvent::Progress {
                    received_bytes: 3,
                    total_bytes: Some(9),
                    elapsed_ms: 100,
                },
                InstallerDownloadEvent::Retrying {
                    attempt: 2,
                    elapsed_ms: 100,
                },
                InstallerDownloadEvent::Opened {
                    total_bytes: Some(9),
                    elapsed_ms: 100,
                },
                InstallerDownloadEvent::Progress {
                    received_bytes: 8,
                    total_bytes: Some(9),
                    elapsed_ms: 199,
                },
                InstallerDownloadEvent::Progress {
                    received_bytes: 9,
                    total_bytes: Some(9),
                    elapsed_ms: 200,
                },
                InstallerDownloadEvent::Verifying {
                    received_bytes: 9,
                    total_bytes: Some(9),
                },
            ],
            outcome: ScriptedDownloadOutcome::Success,
            events_emitted: None,
        });
        let runtime = runtime_with_verified_candidate(downloader, sink.clone()).await;
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );

        assert!(runtime.run_pending_download().await);
        assert_eq!(runtime.snapshot().phase, UpdatePhase::ReadyToInstall);
        assert_eq!(sink.revisions(), (1..=7).collect::<Vec<_>>());
    });
}

#[test]
fn exact_cancel_disables_cancellation_immediately_then_returns_to_available_after_cleanup() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let events_emitted = Arc::new(tokio::sync::Notify::new());
        let cancel_observed = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![InstallerDownloadEvent::Opened {
                total_bytes: Some(9),
                elapsed_ms: 0,
            }],
            outcome: ScriptedDownloadOutcome::CancelledAfterRelease {
                cancel_observed: cancel_observed.clone(),
                release: release.clone(),
            },
            events_emitted: Some(events_emitted.clone()),
        });
        let runtime = Arc::new(runtime_with_verified_candidate(downloader, sink.clone()).await);
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );
        let task_runtime = runtime.clone();
        let task =
            tauri::async_runtime::spawn(async move { task_runtime.run_pending_download().await });
        events_emitted.notified().await;
        let before_cancel = runtime.snapshot();
        let operation_id = before_cancel.operation.unwrap().id;

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: before_cancel.revision,
                intent: UpdateIntent::CancelDownload {
                    operation_id: operation_id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );
        cancel_observed.notified().await;
        assert!(!runtime.snapshot().operation.unwrap().cancellable);
        release.notify_one();
        assert!(task.await.unwrap());
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Available);
        assert!(
            runtime.snapshot().fault.is_none(),
            "取消不应产生 fault: {:?}",
            runtime.snapshot().fault
        );
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CancelDownload { operation_id },
            }),
            UpdateReceipt::StaleOperation
        );
        let revisions = sink.revisions();
        assert!(revisions.windows(2).all(|pair| pair[1] == pair[0] + 1));
    });
}

#[test]
fn accepted_cancel_is_not_overwritten_by_a_racing_transport_failure() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let entered = Arc::new(tokio::sync::Notify::new());
        let downloader = Arc::new(ScriptedDownloader {
            events: Vec::new(),
            outcome: ScriptedDownloadOutcome::NetworkFailureAfterCancellation,
            events_emitted: Some(entered.clone()),
        });
        let runtime = Arc::new(runtime_with_verified_candidate(downloader, sink).await);
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );
        let task_runtime = runtime.clone();
        let task =
            tauri::async_runtime::spawn(async move { task_runtime.run_pending_download().await });
        entered.notified().await;
        let downloading = runtime.snapshot();
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: downloading.revision,
                intent: UpdateIntent::CancelDownload {
                    operation_id: downloading.operation.unwrap().id,
                },
            }),
            UpdateReceipt::Accepted
        );

        assert!(task.await.unwrap());
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Available);
        assert!(runtime.snapshot().fault.is_none());
    });
}

#[test]
fn cancellation_wins_an_opened_event_race_without_projecting_a_stale_fault() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![InstallerDownloadEvent::Opened {
                total_bytes: Some(9),
                elapsed_ms: 0,
            }],
            outcome: ScriptedDownloadOutcome::WaitForCancellation,
            events_emitted: None,
        });
        let runtime = runtime_with_verified_candidate(downloader, sink.clone()).await;
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );
        let downloading = runtime.snapshot();
        let operation_id = downloading.operation.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: downloading.revision,
                intent: UpdateIntent::CancelDownload { operation_id },
            }),
            UpdateReceipt::Accepted
        );

        assert!(runtime.run_pending_download().await);
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Available);
        assert!(runtime.snapshot().fault.is_none());
        assert_eq!(sink.revisions(), (1..=5).collect::<Vec<_>>());
    });
}

#[test]
fn dropped_download_runner_releases_the_claim_and_projects_an_interruption_fault() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let entered = Arc::new(tokio::sync::Notify::new());
        let downloader = Arc::new(ScriptedDownloader {
            events: Vec::new(),
            outcome: ScriptedDownloadOutcome::NeverCompletes,
            events_emitted: Some(entered.clone()),
        });
        let runtime = Arc::new(runtime_with_verified_candidate(downloader, sink).await);
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );
        let task_runtime = runtime.clone();
        let task =
            tauri::async_runtime::spawn(async move { task_runtime.run_pending_download().await });
        entered.notified().await;

        task.abort();
        let _ = task.await;

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Available);
        assert!(snapshot.operation.is_none());
        assert_eq!(
            snapshot.fault.as_ref().map(|fault| fault.code.as_str()),
            Some("UPDATE_DOWNLOAD_INTERRUPTED")
        );
    });
}

#[test]
fn shutdown_waits_for_cleanup_and_rejects_success_after_cancellation() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let verifying = Arc::new(tokio::sync::Notify::new());
        let cancel_observed = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![InstallerDownloadEvent::Verifying {
                received_bytes: 9,
                total_bytes: Some(9),
            }],
            outcome: ScriptedDownloadOutcome::SuccessAfterCancellation {
                cancel_observed: cancel_observed.clone(),
                release: release.clone(),
            },
            events_emitted: Some(verifying.clone()),
        });
        let runtime = Arc::new(runtime_with_verified_candidate(downloader, sink).await);
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );
        let task_runtime = runtime.clone();
        let task =
            tauri::async_runtime::spawn(async move { task_runtime.run_pending_download().await });
        verifying.notified().await;
        let shutdown_runtime = runtime.clone();
        let shutdown = tauri::async_runtime::spawn(async move {
            shutdown_runtime.shutdown_active_download().await
        });
        cancel_observed.notified().await;
        release.notify_one();

        assert!(shutdown.await.unwrap());
        assert!(task.await.unwrap());
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Available);
        assert!(runtime.snapshot().fault.is_none());
        assert!(runtime
            .state
            .lock()
            .expect("update runtime state poisoned")
            .verified_artifact
            .is_none());
    });
}

#[test]
fn shutdown_wins_after_the_downloader_returns_but_before_success_is_committed() {
    tauri::async_runtime::block_on(async {
        let directory = RuntimeTestDirectory::new();
        let artifact_path = directory.join("verified-installer.exe");
        std::fs::write(&artifact_path, b"installer").unwrap();
        let sink = Arc::new(MemorySnapshotSink::default());
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![InstallerDownloadEvent::Verifying {
                received_bytes: 9,
                total_bytes: Some(9),
            }],
            outcome: ScriptedDownloadOutcome::SuccessAt {
                path: artifact_path.clone(),
                before_return: None,
            },
            events_emitted: None,
        });
        let runtime = Arc::new(runtime_with_verified_candidate(downloader, sink).await);
        let arrived = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        runtime.set_download_commit_barrier(arrived.clone(), release.clone());
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );
        let task_runtime = runtime.clone();
        let task =
            tauri::async_runtime::spawn(async move { task_runtime.run_pending_download().await });
        arrived.notified().await;

        // Verifying 事件在进入 barrier 前已把 operation 置为不可取消，关停的
        // begin 阶段因此不再产生可观察修订；若把 shutdown 交给调度器去跑，
        // 它可能在 release 之后才执行而错过窗口。这里同步声明关停，保证下载
        // 任务恢复时取消已经生效。await completion 半段由
        // shutdown_waits_for_cleanup_and_rejects_success_after_cancellation 覆盖。
        assert!(runtime.request_active_download_shutdown());
        assert!(!runtime.snapshot().operation.unwrap().cancellable);
        release.notify_one();

        assert!(task.await.unwrap());
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Available);
        assert!(runtime.snapshot().fault.is_none());
        assert!(!artifact_path.exists());
    });
}

#[test]
fn cancellation_cannot_downgrade_a_confirmed_authenticity_failure() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let ready = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let downloader = Arc::new(ScriptedDownloader {
            events: Vec::new(),
            outcome: ScriptedDownloadOutcome::AuthenticityAfterRelease(release.clone()),
            events_emitted: Some(ready.clone()),
        });
        let runtime = Arc::new(runtime_with_verified_candidate(downloader, sink).await);
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download {
                    candidate_id: candidate_id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );
        let task_runtime = runtime.clone();
        let task =
            tauri::async_runtime::spawn(async move { task_runtime.run_pending_download().await });
        ready.notified().await;
        let downloading = runtime.snapshot();
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: downloading.revision,
                intent: UpdateIntent::CancelDownload {
                    operation_id: downloading.operation.unwrap().id,
                },
            }),
            UpdateReceipt::Accepted
        );
        release.notify_one();
        assert!(task.await.unwrap());

        let failed = runtime.snapshot();
        assert_eq!(failed.phase, UpdatePhase::Available);
        assert_eq!(
            failed.fault.as_ref().map(|fault| fault.stage),
            Some(UpdateFaultStage::Verify)
        );
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: failed.revision,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::PolicyBlocked
        );
    });
}

#[test]
fn authenticity_failure_quarantines_only_the_exact_candidate() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![InstallerDownloadEvent::Verifying {
                received_bytes: 9,
                total_bytes: Some(9),
            }],
            outcome: ScriptedDownloadOutcome::AuthenticityFailure,
            events_emitted: None,
        });
        let runtime = runtime_with_verified_candidate(downloader, sink).await;
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download {
                    candidate_id: candidate_id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_download().await);
        let failed = runtime.snapshot();
        assert_eq!(failed.phase, UpdatePhase::Available);
        assert_eq!(
            failed.fault.as_ref().map(|fault| fault.stage),
            Some(UpdateFaultStage::Verify)
        );
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: failed.revision,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::PolicyBlocked
        );
    });
}

#[test]
fn higher_candidate_removes_the_previous_verified_file_before_replacing_authority() {
    tauri::async_runtime::block_on(async {
        let directory = RuntimeTestDirectory::new();
        let artifact_path = directory.join("verified-installer.exe");
        std::fs::write(&artifact_path, b"installer").unwrap();
        let source = Arc::new(MemoryUpdateSource::with_outcomes([
            Ok(Some(verified_fixture_release(&[]))),
            Ok(Some(NormalizedRelease::new(
                "candidate-1.2.4",
                "1.2.4",
                ["更高版本"],
                Some("2026-07-31T01:00:00Z"),
            ))),
        ]));
        let sink = Arc::new(MemorySnapshotSink::default());
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![InstallerDownloadEvent::Verifying {
                received_bytes: 9,
                total_bytes: Some(9),
            }],
            outcome: ScriptedDownloadOutcome::SuccessAt {
                path: artifact_path.clone(),
                before_return: None,
            },
            events_emitted: None,
        });
        let runtime = UpdateRuntime::with_downloader("0.1.0", source, sink, downloader);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 0,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_download().await);
        assert_eq!(runtime.snapshot().phase, UpdatePhase::ReadyToInstall);
        assert!(artifact_path.exists());

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Available);
        assert_eq!(snapshot.candidate.unwrap().id, "candidate-1.2.4");
        assert!(!artifact_path.exists());
        assert!(runtime
            .state
            .lock()
            .expect("update runtime state poisoned")
            .verified_artifact
            .is_none());
    });
}

#[test]
fn higher_candidate_cleanup_failure_revokes_old_install_authority_and_blocks_runtime() {
    tauri::async_runtime::block_on(async {
        let directory = RuntimeTestDirectory::new();
        let artifact_path = directory.join("verified-installer.exe");
        std::fs::create_dir(&artifact_path).unwrap();
        let source = Arc::new(MemoryUpdateSource::with_outcomes([
            Ok(Some(verified_fixture_release(&[]))),
            Ok(Some(NormalizedRelease::new(
                "candidate-1.2.4",
                "1.2.4",
                ["更高版本"],
                Some("2026-07-31T01:00:00Z"),
            ))),
        ]));
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![InstallerDownloadEvent::Verifying {
                received_bytes: 9,
                total_bytes: Some(9),
            }],
            outcome: ScriptedDownloadOutcome::SuccessAt {
                path: artifact_path,
                before_return: None,
            },
            events_emitted: None,
        });
        let runtime = UpdateRuntime::with_downloader(
            "0.1.0",
            source,
            Arc::new(MemorySnapshotSink::default()),
            downloader,
        );
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 0,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_download().await);
        assert_eq!(runtime.snapshot().phase, UpdatePhase::ReadyToInstall);

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);

        let blocked = runtime.snapshot();
        assert_eq!(blocked.phase, UpdatePhase::Current);
        assert!(blocked.candidate.is_none());
        assert_eq!(
            blocked.fault.as_ref().map(|fault| fault.stage),
            Some(UpdateFaultStage::Cache)
        );
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: blocked.revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::PolicyBlocked
        );
    });
}

#[test]
fn exact_ready_candidate_is_the_only_install_authority() {
    tauri::async_runtime::block_on(async {
        let installer = Arc::new(ScriptedInstaller::new(
            [ScriptedInstallStep::Complete(Ok(
                UpdateInstallOutcome::InstallerSpawned,
            ))],
            [],
        ));
        let runtime = runtime_ready_to_install(installer.clone()).await;
        let ready = runtime.snapshot();
        let candidate_id = ready
            .candidate
            .as_ref()
            .expect("应有 ready candidate")
            .id
            .clone();

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: ready.revision,
                intent: UpdateIntent::InstallAndRestart {
                    candidate_id: "0".repeat(64),
                },
            }),
            UpdateReceipt::StaleCandidate
        );
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: ready.revision,
                intent: UpdateIntent::InstallAndRestart {
                    candidate_id: candidate_id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );
        let preparing = runtime.snapshot();
        assert_eq!(preparing.phase, UpdatePhase::PreparingInstall);
        assert_eq!(
            preparing.operation.as_ref().map(|value| value.kind),
            Some(UpdateOperationKind::Install)
        );
        assert!(runtime.run_pending_install().await);
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Installing);
        assert_eq!(installer.calls(), vec![("install", candidate_id)]);
    });
}

#[test]
fn completed_pre_spawn_failure_returns_to_ready_and_preserves_verified_authority() {
    tauri::async_runtime::block_on(async {
        let installer = Arc::new(ScriptedInstaller::new(
            [ScriptedInstallStep::Complete(Err(UpdateInstallFault::new(
                UpdateFaultStage::Install,
                "UPDATE_INSTALL_SPAWN_FAILED",
                true,
                "无法启动已验证的更新安装包",
                false,
            )))],
            [],
        ));
        let runtime = runtime_ready_to_install(installer).await;
        let ready = runtime.snapshot();
        let candidate_id = ready.candidate.as_ref().unwrap().id.clone();
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: ready.revision,
                intent: UpdateIntent::InstallAndRestart {
                    candidate_id: candidate_id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_install().await);

        let failed = runtime.snapshot();
        assert_eq!(failed.phase, UpdatePhase::ReadyToInstall);
        assert_eq!(
            failed.fault.as_ref().map(|fault| fault.code.as_str()),
            Some("UPDATE_INSTALL_SPAWN_FAILED")
        );
        assert_eq!(
            failed.candidate.as_ref().map(|value| value.id.as_str()),
            Some(candidate_id.as_str())
        );
        assert!(runtime
            .state
            .lock()
            .expect("update runtime state poisoned")
            .verified_artifact
            .is_some());
    });
}

#[test]
fn recovery_required_install_is_retried_without_replaying_install() {
    tauri::async_runtime::block_on(async {
        let installer = Arc::new(ScriptedInstaller::new(
            [ScriptedInstallStep::Complete(Err(UpdateInstallFault::new(
                UpdateFaultStage::Quiesce,
                "UPDATE_WEB_QUIESCENCE_ACK_TIMEOUT",
                true,
                "等待 Web rollback acknowledgement 超时",
                true,
            )))],
            [Ok(UpdateInstallOutcome::RecoveryCompleted)],
        ));
        let runtime = runtime_ready_to_install(installer.clone()).await;
        let ready = runtime.snapshot();
        let candidate_id = ready.candidate.as_ref().unwrap().id.clone();
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: ready.revision,
                intent: UpdateIntent::InstallAndRestart {
                    candidate_id: candidate_id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_install().await);
        assert_eq!(runtime.snapshot().phase, UpdatePhase::PreparingInstall);
        assert!(runtime.run_pending_install().await);
        let recovered = runtime.snapshot();
        assert_eq!(recovered.phase, UpdatePhase::ReadyToInstall);
        assert_eq!(
            recovered.fault.as_ref().map(|fault| fault.code.as_str()),
            Some("UPDATE_WEB_QUIESCENCE_ACK_TIMEOUT")
        );
        assert_eq!(
            installer.calls(),
            vec![("install", candidate_id), ("retry", String::new())]
        );
    });
}

#[test]
fn install_transaction_performs_one_exact_recovery_before_returning() {
    tauri::async_runtime::block_on(async {
        let installer = Arc::new(ScriptedInstaller::new(
            [ScriptedInstallStep::Complete(Err(UpdateInstallFault::new(
                UpdateFaultStage::Quiesce,
                "UPDATE_WEB_QUIESCENCE_ACK_TIMEOUT",
                true,
                "等待 Web rollback acknowledgement 超时",
                true,
            )))],
            [Ok(UpdateInstallOutcome::RecoveryCompleted)],
        ));
        let runtime = runtime_ready_to_install(installer.clone()).await;
        let ready = runtime.snapshot();
        let candidate_id = ready.candidate.as_ref().unwrap().id.clone();
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: ready.revision,
                intent: UpdateIntent::InstallAndRestart {
                    candidate_id: candidate_id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );

        assert!(runtime.run_pending_install_transaction().await);

        assert_eq!(runtime.snapshot().phase, UpdatePhase::ReadyToInstall);
        assert_eq!(
            installer.calls(),
            vec![("install", candidate_id), ("retry", String::new())]
        );
    });
}

#[test]
fn cancelled_install_runner_retains_recovery_authority_for_reconnect() {
    tauri::async_runtime::block_on(async {
        let entered = Arc::new(tokio::sync::Notify::new());
        let installer = Arc::new(ScriptedInstaller::new(
            [ScriptedInstallStep::Pending(entered.clone())],
            [Ok(UpdateInstallOutcome::RecoveryCompleted)],
        ));
        let runtime = Arc::new(runtime_ready_to_install(installer.clone()).await);
        let ready = runtime.snapshot();
        let candidate_id = ready.candidate.as_ref().unwrap().id.clone();
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: ready.revision,
                intent: UpdateIntent::InstallAndRestart {
                    candidate_id: candidate_id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );
        let running_runtime = runtime.clone();
        let running =
            tauri::async_runtime::spawn(async move { running_runtime.run_pending_install().await });
        entered.notified().await;
        running.abort();
        let _ = running.await;

        let interrupted = runtime.snapshot();
        assert_eq!(interrupted.phase, UpdatePhase::PreparingInstall);
        assert_eq!(
            interrupted.fault.as_ref().map(|fault| fault.code.as_str()),
            Some("UPDATE_INSTALL_INTERRUPTED")
        );
        assert!(runtime.run_pending_install().await);
        assert_eq!(runtime.snapshot().phase, UpdatePhase::ReadyToInstall);
        assert_eq!(
            installer.calls(),
            vec![("install", candidate_id), ("retry", String::new())]
        );
    });
}

#[test]
fn disabled_runtime_without_network_rejects_every_update_mutation() {
    let runtime =
        UpdateRuntime::disabled_without_network("1.0.0", Arc::new(MemorySnapshotSink::default()));
    assert_eq!(runtime.snapshot().phase, UpdatePhase::Disabled);
    assert_eq!(
        runtime.dispatch(UpdateDispatchRequest {
            expected_revision: 0,
            intent: UpdateIntent::CheckNow,
        }),
        UpdateReceipt::RuntimeUnavailable
    );
}
