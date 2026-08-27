use std::{
    error::Error,
    ffi::{OsStr, OsString},
    fmt,
    fs::File,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

use super::managed_fs::StableDirectory;

pub(crate) const WEB_QUIESCENCE_FILE_NAME: &str = "web-quiescence-v1.json";
pub(crate) const WEB_QUIESCENCE_COMPLETION_FILE_NAME: &str = "web-quiescence-completion-v1.json";
pub(crate) const PLAYBACK_EXIT_CHECKPOINT_FILE_NAME: &str = "playback-exit-checkpoint-v1.json";
pub(crate) const WEB_QUIESCENCE_SCHEMA: &str = "web-quiescence-v1";
pub(crate) const WEB_QUIESCENCE_COMPLETION_SCHEMA: &str = "web-quiescence-completion-v1";
pub(crate) const PLAYBACK_EXIT_CHECKPOINT_SCHEMA: &str = "playback-exit-checkpoint-v1";

const MAX_WEB_QUIESCENCE_BYTES: u64 = 8 * 1024;
const MAX_PLAYBACK_CHECKPOINT_BYTES: u64 = 256 * 1024;
const MAX_CHECKPOINT_QUEUE: usize = 240;
const MAX_TRACK_ARTISTS: usize = 16;
const MAX_TRACK_QUALITY_HINTS: usize = 16;
const MAX_TRACK_DURATION_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1_000.0;
const MAX_WEB_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const TEMPORARY_FILE_ATTEMPTS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum WebQuiescencePhase {
    PrepareRequested,
    Prepared,
    RollbackRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WebQuiescenceRecordV1 {
    pub(crate) schema: String,
    pub(crate) operation_id: String,
    pub(crate) operation_generation: u64,
    pub(crate) candidate_id: String,
    pub(crate) phase: WebQuiescencePhase,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub(crate) checkpoint_receipt: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub(crate) checkpoint_digest: Option<String>,
    pub(crate) native_rollback_completed: bool,
    pub(crate) rollback_acknowledged: bool,
    pub(crate) updated_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum WebQuiescenceCompletionKind {
    Restored,
    NoOpNotPrepared,
    ConsumedByAppliedInstall,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WebQuiescenceCompletionV1 {
    schema: String,
    operation_id: String,
    operation_generation: u64,
    candidate_id: String,
    kind: WebQuiescenceCompletionKind,
    #[serde(deserialize_with = "deserialize_required_option")]
    checkpoint_receipt: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    checkpoint_digest: Option<String>,
    completed_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PlaybackCheckpointProvider {
    Netease,
    Qq,
    Kugou,
    Soda,
}

impl PlaybackCheckpointProvider {
    fn as_str(self) -> &'static str {
        match self {
            Self::Netease => "netease",
            Self::Qq => "qq",
            Self::Kugou => "kugou",
            Self::Soda => "soda",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlaybackCheckpointStreamSource {
    pub(crate) provider: PlaybackCheckpointProvider,
    pub(crate) id: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PlaybackCheckpointPlayableState {
    #[default]
    Unknown,
    Playable,
    LoginRequired,
    VipRequired,
    PaidRequired,
    CopyrightUnavailable,
    TrialOnly,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlaybackCheckpointTrack {
    pub(crate) provider: PlaybackCheckpointProvider,
    pub(crate) id: String,
    pub(crate) source_id: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) media_mid: Option<String>,
    pub(crate) title: String,
    pub(crate) artists: Vec<String>,
    pub(crate) album: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_u64",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) duration_ms: Option<u64>,
    pub(crate) quality_hints: Vec<String>,
    pub(crate) playable_state: PlaybackCheckpointPlayableState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PlaybackCheckpointMode {
    Single,
    Loop,
    Queue,
    Shuffle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PlaybackCheckpointSourceKind {
    Remote,
    Blob,
    Local,
    Opaque,
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlaybackExitCheckpointV1 {
    pub(crate) schema: String,
    pub(crate) operation_id: String,
    pub(crate) receipt: String,
    pub(crate) queue: Vec<PlaybackCheckpointTrack>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub(crate) current_track_index: Option<usize>,
    pub(crate) current_track_ref: String,
    pub(crate) captured_playback_intent_id: u64,
    pub(crate) position_ms: f64,
    #[serde(deserialize_with = "deserialize_optional_f64")]
    pub(crate) duration_ms: Option<f64>,
    pub(crate) was_playing: bool,
    pub(crate) volume: f64,
    pub(crate) muted: bool,
    pub(crate) mode: PlaybackCheckpointMode,
    pub(crate) source_kind: PlaybackCheckpointSourceKind,
    pub(crate) restart_restorable: bool,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_stream_source",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) stream_source: Option<PlaybackCheckpointStreamSource>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WebQuiescenceIdentity {
    pub(crate) operation_id: String,
    pub(crate) operation_generation: u64,
    pub(crate) candidate_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CheckpointEvidence {
    pub(crate) receipt: String,
    pub(crate) digest: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PersistedPlaybackCheckpoint {
    pub(crate) evidence: CheckpointEvidence,
    pub(crate) payload: PlaybackExitCheckpointV1,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PrepareWebQuiescenceRequest {
    pub(crate) identity: WebQuiescenceIdentity,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RollbackWebQuiescenceRequest {
    pub(crate) identity: WebQuiescenceIdentity,
    pub(crate) checkpoint: Option<PersistedPlaybackCheckpoint>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum RollbackWebQuiescencePlan {
    Request(Box<RollbackWebQuiescenceRequest>),
    AlreadyCompleted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PreparedAcknowledgementOutcome {
    Prepared,
    AlreadyPrepared,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RollbackAcknowledgement {
    Restored(CheckpointEvidence),
    NoOpNotPrepared,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RollbackAcknowledgementOutcome {
    Completed,
    AlreadyCompleted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AppliedCheckpointConsumeOutcome {
    Consumed,
    AlreadyConsumed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InstallAttemptRestorePlan {
    RestoreRequired,
    AlreadyRestored,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum WebQuiescenceReconciliation {
    Idle,
    RequestPrepare(PrepareWebQuiescenceRequest),
    RepeatPreparedAcknowledgement {
        identity: WebQuiescenceIdentity,
        checkpoint: CheckpointEvidence,
    },
    NativeRollbackRequired(WebQuiescenceIdentity),
    RequestRollback(RollbackWebQuiescenceRequest),
    InstallAttemptPending {
        identity: WebQuiescenceIdentity,
        checkpoint: PersistedPlaybackCheckpoint,
    },
    CompletedRecovered(WebQuiescenceIdentity),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WebQuiescenceError {
    code: &'static str,
    message: String,
}

impl WebQuiescenceError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Display for WebQuiescenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for WebQuiescenceError {}

/// Web Playback quiescence 的 crash-safe authority。
///
/// 该 Adapter 不发布 Tauri event，也不接生产 bootstrap。`begin_prepare` 只有在
/// prepare-requested 已经原子落盘后才返回 request，调用方因此不可能合法地先发 event。
#[derive(Debug)]
pub(crate) struct NativeWebQuiescenceStore {
    updater_directory: PathBuf,
    io_lock: Mutex<()>,
}

impl NativeWebQuiescenceStore {
    pub(crate) fn for_app_data(app_data_directory: impl AsRef<Path>) -> Self {
        Self::with_updater_directory(app_data_directory.as_ref().join("updater"))
    }

    pub(crate) fn with_updater_directory(updater_directory: impl Into<PathBuf>) -> Self {
        Self {
            updater_directory: updater_directory.into(),
            io_lock: Mutex::new(()),
        }
    }

    pub(crate) fn begin_prepare(
        &self,
        candidate_id: &str,
        updated_at: u64,
    ) -> Result<PrepareWebQuiescenceRequest, WebQuiescenceError> {
        validate_candidate_id(candidate_id)?;
        let _guard = self.io_lock.lock().expect("web quiescence store poisoned");
        let directory = StableDirectory::open_or_create(&self.updater_directory)
            .map_err(|error| managed_error("UPDATE_WEB_QUIESCENCE_DIRECTORY_FAILED", error))?;
        // 旧 completion 只为上一事务提供幂等答复；格式损坏时必须先 fail closed。
        let previous_completion = load_completion(&directory)?;
        if load_record(&directory)?.is_some() {
            return Err(WebQuiescenceError::new(
                "UPDATE_WEB_QUIESCENCE_OPERATION_ACTIVE",
                "已有安装静默事务尚未协调完成",
            ));
        }
        if load_checkpoint(&directory)?.is_some() {
            return Err(WebQuiescenceError::new(
                "UPDATE_PLAYBACK_CHECKPOINT_ORPHANED",
                "播放退出 checkpoint 缺少对应的 Web 静默事务",
            ));
        }

        let operation_generation = match previous_completion.as_ref() {
            None => 1,
            Some(completion) if completion.operation_generation >= MAX_WEB_SAFE_INTEGER => {
                return Err(WebQuiescenceError::new(
                    "UPDATE_WEB_QUIESCENCE_GENERATION_EXHAUSTED",
                    "Web 静默事务 generation 已达到 JavaScript 安全整数上限",
                ));
            }
            Some(completion) => completion.operation_generation + 1,
        };
        let identity = WebQuiescenceIdentity {
            operation_id: random_lower_hex_128()?,
            operation_generation,
            candidate_id: candidate_id.to_owned(),
        };
        let record = WebQuiescenceRecordV1 {
            schema: WEB_QUIESCENCE_SCHEMA.into(),
            operation_id: identity.operation_id.clone(),
            operation_generation: identity.operation_generation,
            candidate_id: identity.candidate_id.clone(),
            phase: WebQuiescencePhase::PrepareRequested,
            checkpoint_receipt: None,
            checkpoint_digest: None,
            native_rollback_completed: false,
            rollback_acknowledged: false,
            updated_at,
        };
        save_document(
            &directory,
            WEB_QUIESCENCE_FILE_NAME,
            &record,
            MAX_WEB_QUIESCENCE_BYTES,
        )?;
        Ok(PrepareWebQuiescenceRequest { identity })
    }

    pub(crate) fn persist_checkpoint(
        &self,
        identity: &WebQuiescenceIdentity,
        checkpoint: &PlaybackExitCheckpointV1,
    ) -> Result<CheckpointEvidence, WebQuiescenceError> {
        validate_identity(identity)?;
        validate_checkpoint(checkpoint)?;
        if checkpoint.operation_id != identity.operation_id {
            return Err(stale_identity());
        }
        let _guard = self.io_lock.lock().expect("web quiescence store poisoned");
        let directory = existing_directory(&self.updater_directory)?;
        let record = required_record(&directory)?;
        ensure_record_identity(&record, identity)?;
        if record.phase != WebQuiescencePhase::PrepareRequested {
            return Err(invalid_order("只有 prepare-requested 可以接收 checkpoint"));
        }

        let canonical = canonical_document(checkpoint, MAX_PLAYBACK_CHECKPOINT_BYTES)?;
        let evidence = CheckpointEvidence {
            receipt: checkpoint.receipt.clone(),
            digest: sha256_hex(&canonical),
        };
        if let Some(existing) = load_checkpoint(&directory)? {
            let existing_bytes = canonical_document(&existing, MAX_PLAYBACK_CHECKPOINT_BYTES)?;
            let existing_evidence = CheckpointEvidence {
                receipt: existing.receipt.clone(),
                digest: sha256_hex(&existing_bytes),
            };
            if existing_evidence == evidence && existing == *checkpoint {
                return Ok(evidence);
            }
            return Err(WebQuiescenceError::new(
                "UPDATE_PLAYBACK_CHECKPOINT_CONFLICT",
                "当前安装事务已存在不同的播放退出 checkpoint",
            ));
        }
        save_canonical_bytes(&directory, PLAYBACK_EXIT_CHECKPOINT_FILE_NAME, &canonical)?;
        Ok(evidence)
    }

    pub(crate) fn acknowledge_prepared(
        &self,
        identity: &WebQuiescenceIdentity,
        evidence: &CheckpointEvidence,
        updated_at: u64,
    ) -> Result<PreparedAcknowledgementOutcome, WebQuiescenceError> {
        validate_operation_id(&identity.operation_id)?;
        validate_candidate_id(&identity.candidate_id)?;
        let _guard = self.io_lock.lock().expect("web quiescence store poisoned");
        let directory = existing_directory(&self.updater_directory)?;
        let mut record = required_record(&directory)?;
        if record.operation_id != identity.operation_id
            || record.candidate_id != identity.candidate_id
        {
            return Err(stale_identity());
        }
        if let Err(error) = validate_operation_generation(identity.operation_generation) {
            mark_rollback_required_locked(&directory, &mut record, updated_at)?;
            return Err(error);
        }
        if record.operation_generation != identity.operation_generation {
            mark_rollback_required_locked(&directory, &mut record, updated_at)?;
            return Err(stale_identity());
        }
        if let Err(error) = validate_evidence(evidence) {
            mark_rollback_required_locked(&directory, &mut record, updated_at)?;
            return Err(error);
        }
        let actual = match required_checkpoint_evidence(&directory, &identity.operation_id) {
            Ok(actual) => actual,
            Err(error) => {
                mark_rollback_required_locked(&directory, &mut record, updated_at)?;
                return Err(error);
            }
        };
        if &actual != evidence {
            mark_rollback_required_locked(&directory, &mut record, updated_at)?;
            return Err(stale_identity());
        }
        match record.phase {
            WebQuiescencePhase::PrepareRequested => {
                record.phase = WebQuiescencePhase::Prepared;
                record.checkpoint_receipt = Some(evidence.receipt.clone());
                record.checkpoint_digest = Some(evidence.digest.clone());
                record.updated_at = updated_at;
                validate_record(&record)?;
                save_document(
                    &directory,
                    WEB_QUIESCENCE_FILE_NAME,
                    &record,
                    MAX_WEB_QUIESCENCE_BYTES,
                )?;
                Ok(PreparedAcknowledgementOutcome::Prepared)
            }
            WebQuiescencePhase::Prepared if record_evidence(&record).as_ref() == Some(evidence) => {
                Ok(PreparedAcknowledgementOutcome::AlreadyPrepared)
            }
            WebQuiescencePhase::Prepared | WebQuiescencePhase::RollbackRequired => {
                mark_rollback_required_locked(&directory, &mut record, updated_at)?;
                Err(stale_identity())
            }
        }
    }

    /// bounded transport timeout/失败的唯一入口。调用方必须在开始任何 native cleanup 前
    /// 先把 exact operation 推进到 rollback-required。
    pub(crate) fn fail_prepare(
        &self,
        identity: &WebQuiescenceIdentity,
        updated_at: u64,
    ) -> Result<WebQuiescenceReconciliation, WebQuiescenceError> {
        self.mark_rollback_required(identity, updated_at)
    }

    pub(crate) fn mark_rollback_required(
        &self,
        identity: &WebQuiescenceIdentity,
        updated_at: u64,
    ) -> Result<WebQuiescenceReconciliation, WebQuiescenceError> {
        validate_identity(identity)?;
        let _guard = self.io_lock.lock().expect("web quiescence store poisoned");
        let directory = existing_directory(&self.updater_directory)?;
        let mut record = required_record(&directory)?;
        ensure_record_identity(&record, identity)?;
        mark_rollback_required_locked(&directory, &mut record, updated_at)?;
        reconciliation_for_rollback(&directory, &record)
    }

    pub(crate) fn confirm_native_rollback(
        &self,
        identity: &WebQuiescenceIdentity,
        updated_at: u64,
    ) -> Result<RollbackWebQuiescenceRequest, WebQuiescenceError> {
        validate_identity(identity)?;
        let _guard = self.io_lock.lock().expect("web quiescence store poisoned");
        let directory = existing_directory(&self.updater_directory)?;
        let mut record = required_record(&directory)?;
        ensure_record_identity(&record, identity)?;
        if record.phase != WebQuiescencePhase::RollbackRequired {
            return Err(invalid_order(
                "native rollback 只能确认 rollback-required 事务",
            ));
        }
        if !record.native_rollback_completed {
            record.native_rollback_completed = true;
            record.updated_at = updated_at;
            validate_record(&record)?;
            save_document(
                &directory,
                WEB_QUIESCENCE_FILE_NAME,
                &record,
                MAX_WEB_QUIESCENCE_BYTES,
            )?;
        }
        rollback_request(&directory, &record)
    }

    pub(crate) fn request_rollback_after_native_confirmation(
        &self,
        identity: &WebQuiescenceIdentity,
    ) -> Result<RollbackWebQuiescencePlan, WebQuiescenceError> {
        validate_identity(identity)?;
        let _guard = self.io_lock.lock().expect("web quiescence store poisoned");
        let Some(directory) = StableDirectory::open_existing(&self.updater_directory)
            .map_err(|error| managed_error("UPDATE_WEB_QUIESCENCE_DIRECTORY_FAILED", error))?
        else {
            return Err(stale_identity());
        };
        if let Some(record) = load_record(&directory)? {
            if ensure_record_identity(&record, identity).is_ok() {
                if record.rollback_acknowledged {
                    reconcile_acknowledged_rollback(&directory, &record)?;
                    return Ok(RollbackWebQuiescencePlan::AlreadyCompleted);
                }
                if record.phase != WebQuiescencePhase::RollbackRequired
                    || !record.native_rollback_completed
                {
                    return Err(WebQuiescenceError::new(
                        "UPDATE_WEB_QUIESCENCE_NATIVE_ROLLBACK_REQUIRED",
                        "必须先完成 exact native rollback，才能请求 Web 恢复",
                    ));
                }
                return Ok(RollbackWebQuiescencePlan::Request(Box::new(
                    rollback_request(&directory, &record)?,
                )));
            }
            return if completion_has_identity(&directory, identity)? {
                Ok(RollbackWebQuiescencePlan::AlreadyCompleted)
            } else {
                Err(stale_identity())
            };
        }
        if load_checkpoint(&directory)?.is_some() {
            return Err(WebQuiescenceError::new(
                "UPDATE_PLAYBACK_CHECKPOINT_ORPHANED",
                "播放退出 checkpoint 缺少对应的 Web 静默事务",
            ));
        }
        if completion_has_identity(&directory, identity)? {
            Ok(RollbackWebQuiescencePlan::AlreadyCompleted)
        } else {
            Err(stale_identity())
        }
    }

    pub(crate) fn acknowledge_rollback(
        &self,
        identity: &WebQuiescenceIdentity,
        acknowledgement: &RollbackAcknowledgement,
        updated_at: u64,
    ) -> Result<RollbackAcknowledgementOutcome, WebQuiescenceError> {
        validate_identity(identity)?;
        validate_rollback_acknowledgement(acknowledgement)?;
        let _guard = self.io_lock.lock().expect("web quiescence store poisoned");
        let Some(directory) = StableDirectory::open_existing(&self.updater_directory)
            .map_err(|error| managed_error("UPDATE_WEB_QUIESCENCE_DIRECTORY_FAILED", error))?
        else {
            return Err(stale_identity());
        };
        let Some(mut record) = load_record(&directory)? else {
            if load_checkpoint(&directory)?.is_some() {
                return Err(WebQuiescenceError::new(
                    "UPDATE_PLAYBACK_CHECKPOINT_ORPHANED",
                    "播放退出 checkpoint 缺少对应的 Web 静默事务",
                ));
            }
            return completed_rollback_outcome(&directory, identity, acknowledgement);
        };
        if ensure_record_identity(&record, identity).is_err() {
            return if load_completion(&directory)?
                .as_ref()
                .is_some_and(|completion| completion_matches(completion, identity, acknowledgement))
            {
                Ok(RollbackAcknowledgementOutcome::AlreadyCompleted)
            } else {
                Err(stale_identity())
            };
        }
        if record.phase != WebQuiescencePhase::RollbackRequired {
            return Err(invalid_order(
                "Web rollback acknowledgement 到达时事务尚未请求回滚",
            ));
        }
        if !record.native_rollback_completed {
            return Err(WebQuiescenceError::new(
                "UPDATE_NATIVE_ROLLBACK_REQUIRED",
                "native owner 尚未完成可验证回滚",
            ));
        }
        let existing_completion = load_completion(&directory)?;
        let completion_already_persisted = existing_completion
            .as_ref()
            .is_some_and(|completion| completion_matches(completion, identity, acknowledgement));
        if !record.rollback_acknowledged || !completion_already_persisted {
            ensure_rollback_ack_matches(&directory, &record, acknowledgement)?;
        }

        if !record.rollback_acknowledged {
            record.rollback_acknowledged = true;
            record.updated_at = updated_at;
            validate_record(&record)?;
            save_document(
                &directory,
                WEB_QUIESCENCE_FILE_NAME,
                &record,
                MAX_WEB_QUIESCENCE_BYTES,
            )?;
        }
        let completion_already_persisted =
            persist_completion_tombstone(&directory, &record, acknowledgement, updated_at)?;
        finalize_acknowledged_rollback(&directory, &record)?;
        Ok(if completion_already_persisted {
            RollbackAcknowledgementOutcome::AlreadyCompleted
        } else {
            RollbackAcknowledgementOutcome::Completed
        })
    }

    /// Web reload/reconnect reconciliation。Prepared 表示 Web 只需重发 exact ack，
    /// 不得重建 checkpoint；已落盘但未 ack 的 prepare 则转入 rollback-required。
    pub(crate) fn reconcile_web(
        &self,
        updated_at: u64,
    ) -> Result<WebQuiescenceReconciliation, WebQuiescenceError> {
        let _guard = self.io_lock.lock().expect("web quiescence store poisoned");
        let Some(directory) = StableDirectory::open_existing(&self.updater_directory)
            .map_err(|error| managed_error("UPDATE_WEB_QUIESCENCE_DIRECTORY_FAILED", error))?
        else {
            return Ok(WebQuiescenceReconciliation::Idle);
        };
        let Some(mut record) = load_record(&directory)? else {
            return if load_checkpoint(&directory)?.is_some() {
                Err(WebQuiescenceError::new(
                    "UPDATE_PLAYBACK_CHECKPOINT_ORPHANED",
                    "播放退出 checkpoint 缺少对应的 Web 静默事务",
                ))
            } else if let Some(completion) = load_completion(&directory)? {
                Ok(WebQuiescenceReconciliation::CompletedRecovered(
                    identity_from_completion(&completion),
                ))
            } else {
                Ok(WebQuiescenceReconciliation::Idle)
            };
        };
        reconcile_acknowledged_rollback(&directory, &record)?;
        if record.rollback_acknowledged {
            return Ok(WebQuiescenceReconciliation::CompletedRecovered(
                identity_from_record(&record),
            ));
        }
        match record.phase {
            WebQuiescencePhase::PrepareRequested => {
                if load_checkpoint(&directory)?.is_some() {
                    mark_rollback_required_locked(&directory, &mut record, updated_at)?;
                    Ok(WebQuiescenceReconciliation::NativeRollbackRequired(
                        identity_from_record(&record),
                    ))
                } else {
                    Ok(WebQuiescenceReconciliation::RequestPrepare(
                        PrepareWebQuiescenceRequest {
                            identity: identity_from_record(&record),
                        },
                    ))
                }
            }
            WebQuiescencePhase::Prepared => {
                let checkpoint = required_record_evidence(&record)?;
                ensure_record_checkpoint_matches(&directory, &record)?;
                Ok(WebQuiescenceReconciliation::RepeatPreparedAcknowledgement {
                    identity: identity_from_record(&record),
                    checkpoint,
                })
            }
            WebQuiescencePhase::RollbackRequired => {
                reconciliation_for_rollback(&directory, &record)
            }
        }
    }

    /// Rust 启动恢复。没有 install-attempt 时，任何遗留 Web 事务都必须先进入
    /// rollback-required；存在 marker 时只有完整 prepared identity 可以继续交给 #52。
    pub(crate) fn reconcile_startup(
        &self,
        install_attempt_present: bool,
        updated_at: u64,
    ) -> Result<WebQuiescenceReconciliation, WebQuiescenceError> {
        let _guard = self.io_lock.lock().expect("web quiescence store poisoned");
        let Some(directory) = StableDirectory::open_existing(&self.updater_directory)
            .map_err(|error| managed_error("UPDATE_WEB_QUIESCENCE_DIRECTORY_FAILED", error))?
        else {
            return if install_attempt_present {
                Err(WebQuiescenceError::new(
                    "UPDATE_INSTALL_ATTEMPT_IDENTITY_MISSING",
                    "install-attempt 缺少 Web 静默 identity",
                ))
            } else {
                Ok(WebQuiescenceReconciliation::Idle)
            };
        };
        let Some(mut record) = load_record(&directory)? else {
            if load_checkpoint(&directory)?.is_some() {
                return Err(WebQuiescenceError::new(
                    "UPDATE_PLAYBACK_CHECKPOINT_ORPHANED",
                    "播放退出 checkpoint 缺少对应的 Web 静默事务",
                ));
            }
            return if install_attempt_present {
                Err(WebQuiescenceError::new(
                    "UPDATE_INSTALL_ATTEMPT_IDENTITY_MISSING",
                    "install-attempt 缺少 Web 静默 identity",
                ))
            } else if let Some(completion) = load_completion(&directory)? {
                Ok(WebQuiescenceReconciliation::CompletedRecovered(
                    identity_from_completion(&completion),
                ))
            } else {
                Ok(WebQuiescenceReconciliation::Idle)
            };
        };
        reconcile_acknowledged_rollback(&directory, &record)?;
        if record.rollback_acknowledged {
            return Ok(WebQuiescenceReconciliation::CompletedRecovered(
                identity_from_record(&record),
            ));
        }
        if install_attempt_present {
            if record.phase != WebQuiescencePhase::Prepared {
                return Err(WebQuiescenceError::new(
                    "UPDATE_INSTALL_ATTEMPT_WEB_STATE_REJECTED",
                    "install-attempt 只允许绑定完整 prepared Web checkpoint",
                ));
            }
            ensure_record_checkpoint_matches(&directory, &record)?;
            return Ok(WebQuiescenceReconciliation::InstallAttemptPending {
                identity: identity_from_record(&record),
                checkpoint: required_persisted_checkpoint(&directory, &record)?,
            });
        }

        mark_rollback_required_locked(&directory, &mut record, updated_at)?;
        reconciliation_for_rollback(&directory, &record)
    }

    /// 新版本已启动后的本地提交点。先持久化 exact completion，再移除 checkpoint 与
    /// active record；任何一步崩溃都可凭 completion 幂等续做，且不会把 checkpoint
    /// 误当成需要恢复的播放状态。
    pub(crate) fn consume_applied_install(
        &self,
        identity: &WebQuiescenceIdentity,
        evidence: &CheckpointEvidence,
        completed_at: u64,
    ) -> Result<AppliedCheckpointConsumeOutcome, WebQuiescenceError> {
        validate_identity(identity)?;
        validate_evidence(evidence)?;
        let _guard = self.io_lock.lock().expect("web quiescence store poisoned");
        let directory = existing_directory(&self.updater_directory)?;
        let existing_completion = load_completion(&directory)?;
        let completion_already_persisted = existing_completion
            .as_ref()
            .is_some_and(|completion| applied_completion_matches(completion, identity, evidence));

        let record = match load_record(&directory)? {
            Some(record) => record,
            None if load_checkpoint(&directory)?.is_none() && completion_already_persisted => {
                return Ok(AppliedCheckpointConsumeOutcome::AlreadyConsumed)
            }
            None => return Err(stale_identity()),
        };
        ensure_record_identity(&record, identity)?;
        if record.phase != WebQuiescencePhase::Prepared
            || record.native_rollback_completed
            || record.rollback_acknowledged
            || record_evidence(&record).as_ref() != Some(evidence)
        {
            return Err(invalid_order(
                "只有 exact prepared checkpoint 可以由已应用安装消费",
            ));
        }
        ensure_record_checkpoint_matches(&directory, &record)?;

        if !completion_already_persisted {
            if existing_completion
                .as_ref()
                .is_some_and(|completion| completion.operation_id == identity.operation_id)
            {
                return Err(WebQuiescenceError::new(
                    "UPDATE_WEB_QUIESCENCE_COMPLETION_CONFLICT",
                    "同一安装事务存在冲突的 completion tombstone",
                ));
            }
            let completion = completion_from_applied_install(identity, evidence, completed_at);
            validate_completion(&completion)?;
            save_document(
                &directory,
                WEB_QUIESCENCE_COMPLETION_FILE_NAME,
                &completion,
                MAX_WEB_QUIESCENCE_BYTES,
            )?;
        }

        remove_document(&directory, PLAYBACK_EXIT_CHECKPOINT_FILE_NAME)?;
        remove_document(&directory, WEB_QUIESCENCE_FILE_NAME)?;
        Ok(if completion_already_persisted {
            AppliedCheckpointConsumeOutcome::AlreadyConsumed
        } else {
            AppliedCheckpointConsumeOutcome::Consumed
        })
    }

    /// 将 NotApplied/AuthenticityRejected 的 exact install-attempt 绑定转换成可重试恢复事务。
    ///
    /// 首次调用只接受完整 Prepared checkpoint；崩溃重试可继续同一 RollbackRequired
    /// 事务。active record 已清理时，只有 `Restored` 且 evidence 完全相同的 completion
    /// 才能作为成功重放，Consumed/NoOp 或不同 evidence 均 fail closed。
    pub(crate) fn begin_install_attempt_restore(
        &self,
        identity: &WebQuiescenceIdentity,
        expected_evidence: &CheckpointEvidence,
        updated_at: u64,
    ) -> Result<InstallAttemptRestorePlan, WebQuiescenceError> {
        validate_identity(identity)?;
        validate_evidence(expected_evidence)?;
        let _guard = self.io_lock.lock().expect("web quiescence store poisoned");
        let directory = existing_directory(&self.updater_directory)?;
        let Some(mut record) = load_record(&directory)? else {
            if load_checkpoint(&directory)?.is_some() {
                return Err(WebQuiescenceError::new(
                    "UPDATE_PLAYBACK_CHECKPOINT_ORPHANED",
                    "播放退出 checkpoint 缺少对应的 Web 静默事务",
                ));
            }
            return exact_restored_completion(&directory, identity, expected_evidence);
        };

        ensure_record_identity(&record, identity)?;
        if !matches!(
            record.phase,
            WebQuiescencePhase::Prepared | WebQuiescencePhase::RollbackRequired
        ) || record_evidence(&record).as_ref() != Some(expected_evidence)
        {
            return Err(install_attempt_restore_rejected());
        }
        ensure_record_checkpoint_matches(&directory, &record)?;

        if record.rollback_acknowledged {
            reconcile_acknowledged_rollback(&directory, &record)?;
            return exact_restored_completion(&directory, identity, expected_evidence);
        }
        if record.phase == WebQuiescencePhase::Prepared {
            mark_rollback_required_locked(&directory, &mut record, updated_at)?;
        }
        Ok(InstallAttemptRestorePlan::RestoreRequired)
    }
}

fn exact_restored_completion(
    directory: &StableDirectory,
    identity: &WebQuiescenceIdentity,
    expected_evidence: &CheckpointEvidence,
) -> Result<InstallAttemptRestorePlan, WebQuiescenceError> {
    let Some(completion) = load_completion(directory)? else {
        return Err(stale_identity());
    };
    if identity_from_completion(&completion) == *identity
        && completion.kind == WebQuiescenceCompletionKind::Restored
        && completion.checkpoint_receipt.as_deref() == Some(expected_evidence.receipt.as_str())
        && completion.checkpoint_digest.as_deref() == Some(expected_evidence.digest.as_str())
    {
        Ok(InstallAttemptRestorePlan::AlreadyRestored)
    } else {
        Err(install_attempt_restore_rejected())
    }
}

fn install_attempt_restore_rejected() -> WebQuiescenceError {
    WebQuiescenceError::new(
        "UPDATE_INSTALL_ATTEMPT_WEB_STATE_REJECTED",
        "install-attempt 与 exact prepared/restored Web checkpoint 不一致",
    )
}

fn mark_rollback_required_locked(
    directory: &StableDirectory,
    record: &mut WebQuiescenceRecordV1,
    updated_at: u64,
) -> Result<(), WebQuiescenceError> {
    if record.phase == WebQuiescencePhase::RollbackRequired {
        return Ok(());
    }
    // rollback-required 是补偿边界，不能被 checkpoint 丢失或损坏阻止持久化。
    // Prepared 已把 exact evidence 写入 record；prepare-requested 才尝试从磁盘绑定 evidence。
    let checkpoint_result = match record.phase {
        WebQuiescencePhase::Prepared => Ok(record_evidence(record)),
        WebQuiescencePhase::PrepareRequested => {
            rollback_evidence_from_checkpoint(directory, record)
        }
        WebQuiescencePhase::RollbackRequired => unreachable!("已在函数开头返回"),
    };
    let (checkpoint, checkpoint_error) = match checkpoint_result {
        Ok(checkpoint) => (checkpoint, None),
        Err(error) => (record_evidence(record), Some(error)),
    };
    persist_rollback_required_locked(directory, record, checkpoint, updated_at)?;
    if let Some(error) = checkpoint_error {
        return Err(error);
    }
    Ok(())
}

fn rollback_evidence_from_checkpoint(
    directory: &StableDirectory,
    record: &WebQuiescenceRecordV1,
) -> Result<Option<CheckpointEvidence>, WebQuiescenceError> {
    let Some(checkpoint) = load_checkpoint(directory)? else {
        return Ok(None);
    };
    if checkpoint.operation_id != record.operation_id {
        return Err(stale_identity());
    }
    let canonical = canonical_document(&checkpoint, MAX_PLAYBACK_CHECKPOINT_BYTES)?;
    Ok(Some(CheckpointEvidence {
        receipt: checkpoint.receipt,
        digest: sha256_hex(&canonical),
    }))
}

fn persist_rollback_required_locked(
    directory: &StableDirectory,
    record: &mut WebQuiescenceRecordV1,
    checkpoint: Option<CheckpointEvidence>,
    updated_at: u64,
) -> Result<(), WebQuiescenceError> {
    record.phase = WebQuiescencePhase::RollbackRequired;
    record.checkpoint_receipt = checkpoint.as_ref().map(|value| value.receipt.clone());
    record.checkpoint_digest = checkpoint.as_ref().map(|value| value.digest.clone());
    record.native_rollback_completed = false;
    record.rollback_acknowledged = false;
    record.updated_at = updated_at;
    validate_record(record)?;
    save_document(
        directory,
        WEB_QUIESCENCE_FILE_NAME,
        record,
        MAX_WEB_QUIESCENCE_BYTES,
    )
}

fn reconciliation_for_rollback(
    directory: &StableDirectory,
    record: &WebQuiescenceRecordV1,
) -> Result<WebQuiescenceReconciliation, WebQuiescenceError> {
    let identity = identity_from_record(record);
    if record.native_rollback_completed {
        Ok(WebQuiescenceReconciliation::RequestRollback(
            rollback_request(directory, record)?,
        ))
    } else {
        Ok(WebQuiescenceReconciliation::NativeRollbackRequired(
            identity,
        ))
    }
}

fn rollback_request(
    directory: &StableDirectory,
    record: &WebQuiescenceRecordV1,
) -> Result<RollbackWebQuiescenceRequest, WebQuiescenceError> {
    Ok(RollbackWebQuiescenceRequest {
        identity: identity_from_record(record),
        checkpoint: optional_persisted_checkpoint(directory, record)?,
    })
}

fn ensure_rollback_ack_matches(
    directory: &StableDirectory,
    record: &WebQuiescenceRecordV1,
    acknowledgement: &RollbackAcknowledgement,
) -> Result<(), WebQuiescenceError> {
    match (record_evidence(record), acknowledgement) {
        (Some(expected), RollbackAcknowledgement::Restored(actual)) if expected == *actual => {
            let disk = required_checkpoint_evidence(directory, &record.operation_id)?;
            if disk == expected {
                Ok(())
            } else {
                Err(stale_identity())
            }
        }
        (None, RollbackAcknowledgement::NoOpNotPrepared)
            if load_checkpoint(directory)?.is_none() =>
        {
            Ok(())
        }
        _ => Err(stale_identity()),
    }
}

fn completed_rollback_outcome(
    directory: &StableDirectory,
    identity: &WebQuiescenceIdentity,
    acknowledgement: &RollbackAcknowledgement,
) -> Result<RollbackAcknowledgementOutcome, WebQuiescenceError> {
    if load_completion(directory)?
        .as_ref()
        .is_some_and(|completion| completion_matches(completion, identity, acknowledgement))
    {
        Ok(RollbackAcknowledgementOutcome::AlreadyCompleted)
    } else {
        Err(stale_identity())
    }
}

fn completion_has_identity(
    directory: &StableDirectory,
    identity: &WebQuiescenceIdentity,
) -> Result<bool, WebQuiescenceError> {
    Ok(load_completion(directory)?
        .as_ref()
        .is_some_and(|completion| identity_from_completion(completion) == *identity))
}

fn persist_completion_tombstone(
    directory: &StableDirectory,
    record: &WebQuiescenceRecordV1,
    acknowledgement: &RollbackAcknowledgement,
    completed_at: u64,
) -> Result<bool, WebQuiescenceError> {
    if !record.rollback_acknowledged || !record.native_rollback_completed {
        return Err(invalid_order(
            "completion tombstone 只能记录 native 与 Web 均已确认的 rollback",
        ));
    }
    let identity = identity_from_record(record);
    let desired = completion_from_acknowledgement(&identity, acknowledgement, completed_at);
    validate_completion(&desired)?;
    if let Some(existing) = load_completion(directory)? {
        if completion_matches(&existing, &identity, acknowledgement) {
            return Ok(true);
        }
        if existing.operation_id == identity.operation_id {
            return Err(WebQuiescenceError::new(
                "UPDATE_WEB_QUIESCENCE_COMPLETION_CONFLICT",
                "同一 Web 静默事务存在冲突的 completion tombstone",
            ));
        }
    }
    // 只有持有当前 active record 的 exact acknowledgement 才能替换上一条 completion。
    save_document(
        directory,
        WEB_QUIESCENCE_COMPLETION_FILE_NAME,
        &desired,
        MAX_WEB_QUIESCENCE_BYTES,
    )?;
    Ok(false)
}

fn completion_from_acknowledgement(
    identity: &WebQuiescenceIdentity,
    acknowledgement: &RollbackAcknowledgement,
    completed_at: u64,
) -> WebQuiescenceCompletionV1 {
    let (kind, checkpoint_receipt, checkpoint_digest) = match acknowledgement {
        RollbackAcknowledgement::Restored(evidence) => (
            WebQuiescenceCompletionKind::Restored,
            Some(evidence.receipt.clone()),
            Some(evidence.digest.clone()),
        ),
        RollbackAcknowledgement::NoOpNotPrepared => {
            (WebQuiescenceCompletionKind::NoOpNotPrepared, None, None)
        }
    };
    WebQuiescenceCompletionV1 {
        schema: WEB_QUIESCENCE_COMPLETION_SCHEMA.into(),
        operation_id: identity.operation_id.clone(),
        operation_generation: identity.operation_generation,
        candidate_id: identity.candidate_id.clone(),
        kind,
        checkpoint_receipt,
        checkpoint_digest,
        completed_at,
    }
}

fn completion_from_applied_install(
    identity: &WebQuiescenceIdentity,
    evidence: &CheckpointEvidence,
    completed_at: u64,
) -> WebQuiescenceCompletionV1 {
    WebQuiescenceCompletionV1 {
        schema: WEB_QUIESCENCE_COMPLETION_SCHEMA.into(),
        operation_id: identity.operation_id.clone(),
        operation_generation: identity.operation_generation,
        candidate_id: identity.candidate_id.clone(),
        kind: WebQuiescenceCompletionKind::ConsumedByAppliedInstall,
        checkpoint_receipt: Some(evidence.receipt.clone()),
        checkpoint_digest: Some(evidence.digest.clone()),
        completed_at,
    }
}

fn acknowledgement_from_completion(
    completion: &WebQuiescenceCompletionV1,
) -> Result<RollbackAcknowledgement, WebQuiescenceError> {
    validate_completion(completion)?;
    Ok(match completion.kind {
        WebQuiescenceCompletionKind::Restored => {
            RollbackAcknowledgement::Restored(CheckpointEvidence {
                receipt: completion
                    .checkpoint_receipt
                    .clone()
                    .ok_or_else(completion_invalid)?,
                digest: completion
                    .checkpoint_digest
                    .clone()
                    .ok_or_else(completion_invalid)?,
            })
        }
        WebQuiescenceCompletionKind::NoOpNotPrepared => RollbackAcknowledgement::NoOpNotPrepared,
        WebQuiescenceCompletionKind::ConsumedByAppliedInstall => {
            return Err(invalid_order(
                "已应用安装消费的 checkpoint 不能转换为 rollback acknowledgement",
            ))
        }
    })
}

fn acknowledgement_from_record(
    record: &WebQuiescenceRecordV1,
) -> Result<RollbackAcknowledgement, WebQuiescenceError> {
    if !record.rollback_acknowledged || !record.native_rollback_completed {
        return Err(invalid_order("rollback completion 尚未取得双重确认"));
    }
    Ok(match record_evidence(record) {
        Some(evidence) => RollbackAcknowledgement::Restored(evidence),
        None => RollbackAcknowledgement::NoOpNotPrepared,
    })
}

fn completion_matches(
    completion: &WebQuiescenceCompletionV1,
    identity: &WebQuiescenceIdentity,
    acknowledgement: &RollbackAcknowledgement,
) -> bool {
    identity_from_completion(completion) == *identity
        && acknowledgement_from_completion(completion)
            .is_ok_and(|completed| completed == *acknowledgement)
}

fn applied_completion_matches(
    completion: &WebQuiescenceCompletionV1,
    identity: &WebQuiescenceIdentity,
    evidence: &CheckpointEvidence,
) -> bool {
    identity_from_completion(completion) == *identity
        && completion.kind == WebQuiescenceCompletionKind::ConsumedByAppliedInstall
        && completion.checkpoint_receipt.as_deref() == Some(evidence.receipt.as_str())
        && completion.checkpoint_digest.as_deref() == Some(evidence.digest.as_str())
}

fn identity_from_completion(completion: &WebQuiescenceCompletionV1) -> WebQuiescenceIdentity {
    WebQuiescenceIdentity {
        operation_id: completion.operation_id.clone(),
        operation_generation: completion.operation_generation,
        candidate_id: completion.candidate_id.clone(),
    }
}

fn reconcile_acknowledged_rollback(
    directory: &StableDirectory,
    record: &WebQuiescenceRecordV1,
) -> Result<(), WebQuiescenceError> {
    if record.rollback_acknowledged {
        let acknowledgement = acknowledgement_from_record(record)?;
        let completion_already_persisted =
            load_completion(directory)?
                .as_ref()
                .is_some_and(|completion| {
                    completion_matches(completion, &identity_from_record(record), &acknowledgement)
                });
        if !completion_already_persisted {
            ensure_rollback_ack_matches(directory, record, &acknowledgement)?;
        }
        persist_completion_tombstone(directory, record, &acknowledgement, record.updated_at)?;
        finalize_acknowledged_rollback(directory, record)?;
    }
    Ok(())
}

fn finalize_acknowledged_rollback(
    directory: &StableDirectory,
    record: &WebQuiescenceRecordV1,
) -> Result<(), WebQuiescenceError> {
    if !record.rollback_acknowledged || !record.native_rollback_completed {
        return Err(invalid_order("rollback 尚未满足 native 与 Web 双重确认"));
    }
    let acknowledgement = acknowledgement_from_record(record)?;
    let completion = load_completion(directory)?.ok_or_else(|| {
        WebQuiescenceError::new(
            "UPDATE_WEB_QUIESCENCE_COMPLETION_MISSING",
            "rollback cleanup 前缺少 crash-safe completion tombstone",
        )
    })?;
    if !completion_matches(&completion, &identity_from_record(record), &acknowledgement) {
        return Err(WebQuiescenceError::new(
            "UPDATE_WEB_QUIESCENCE_COMPLETION_CONFLICT",
            "completion tombstone 与 active rollback 不一致",
        ));
    }
    if record.checkpoint_receipt.is_some() {
        if let Some(checkpoint) = load_checkpoint(directory)? {
            if checkpoint.operation_id != record.operation_id {
                return Err(stale_identity());
            }
            let actual = required_checkpoint_evidence(directory, &record.operation_id)?;
            if Some(actual) != record_evidence(record) {
                return Err(stale_identity());
            }
            remove_document(directory, PLAYBACK_EXIT_CHECKPOINT_FILE_NAME)?;
        }
    } else if load_checkpoint(directory)?.is_some() {
        return Err(WebQuiescenceError::new(
            "UPDATE_PLAYBACK_CHECKPOINT_ORPHANED",
            "no-op rollback 不能清除未绑定 evidence 的 checkpoint",
        ));
    }
    remove_document(directory, WEB_QUIESCENCE_FILE_NAME)
}

fn required_checkpoint_evidence(
    directory: &StableDirectory,
    operation_id: &str,
) -> Result<CheckpointEvidence, WebQuiescenceError> {
    Ok(required_checkpoint(directory, operation_id)?.evidence)
}

fn required_checkpoint(
    directory: &StableDirectory,
    operation_id: &str,
) -> Result<PersistedPlaybackCheckpoint, WebQuiescenceError> {
    let checkpoint = load_checkpoint(directory)?.ok_or_else(|| {
        WebQuiescenceError::new(
            "UPDATE_PLAYBACK_CHECKPOINT_MISSING",
            "播放退出 checkpoint 不存在",
        )
    })?;
    validate_checkpoint(&checkpoint)?;
    if checkpoint.operation_id != operation_id {
        return Err(stale_identity());
    }
    let canonical = canonical_document(&checkpoint, MAX_PLAYBACK_CHECKPOINT_BYTES)?;
    Ok(PersistedPlaybackCheckpoint {
        evidence: CheckpointEvidence {
            receipt: checkpoint.receipt.clone(),
            digest: sha256_hex(&canonical),
        },
        payload: checkpoint,
    })
}

fn optional_persisted_checkpoint(
    directory: &StableDirectory,
    record: &WebQuiescenceRecordV1,
) -> Result<Option<PersistedPlaybackCheckpoint>, WebQuiescenceError> {
    match record_evidence(record) {
        Some(expected) => {
            let persisted = required_checkpoint(directory, &record.operation_id)?;
            if persisted.evidence != expected {
                return Err(WebQuiescenceError::new(
                    "UPDATE_PLAYBACK_CHECKPOINT_EVIDENCE_MISMATCH",
                    "Web record 与磁盘 checkpoint evidence 不一致",
                ));
            }
            Ok(Some(persisted))
        }
        None if load_checkpoint(directory)?.is_none() => Ok(None),
        None => Err(WebQuiescenceError::new(
            "UPDATE_PLAYBACK_CHECKPOINT_ORPHANED",
            "Web record 未绑定磁盘 checkpoint evidence",
        )),
    }
}

fn required_persisted_checkpoint(
    directory: &StableDirectory,
    record: &WebQuiescenceRecordV1,
) -> Result<PersistedPlaybackCheckpoint, WebQuiescenceError> {
    optional_persisted_checkpoint(directory, record)?.ok_or_else(|| {
        WebQuiescenceError::new(
            "UPDATE_PLAYBACK_CHECKPOINT_MISSING",
            "prepared Web record 缺少播放退出 checkpoint",
        )
    })
}

fn ensure_record_checkpoint_matches(
    directory: &StableDirectory,
    record: &WebQuiescenceRecordV1,
) -> Result<(), WebQuiescenceError> {
    if required_checkpoint_evidence(directory, &record.operation_id)?
        == required_record_evidence(record)?
    {
        Ok(())
    } else {
        Err(WebQuiescenceError::new(
            "UPDATE_PLAYBACK_CHECKPOINT_EVIDENCE_MISMATCH",
            "Web record 与磁盘 checkpoint evidence 不一致",
        ))
    }
}

fn required_record_evidence(
    record: &WebQuiescenceRecordV1,
) -> Result<CheckpointEvidence, WebQuiescenceError> {
    record_evidence(record).ok_or_else(|| {
        WebQuiescenceError::new(
            "UPDATE_PLAYBACK_CHECKPOINT_EVIDENCE_MISSING",
            "Web record 缺少 checkpoint evidence",
        )
    })
}

fn record_evidence(record: &WebQuiescenceRecordV1) -> Option<CheckpointEvidence> {
    Some(CheckpointEvidence {
        receipt: record.checkpoint_receipt.clone()?,
        digest: record.checkpoint_digest.clone()?,
    })
}

fn identity_from_record(record: &WebQuiescenceRecordV1) -> WebQuiescenceIdentity {
    WebQuiescenceIdentity {
        operation_id: record.operation_id.clone(),
        operation_generation: record.operation_generation,
        candidate_id: record.candidate_id.clone(),
    }
}

fn existing_directory(path: &Path) -> Result<StableDirectory, WebQuiescenceError> {
    StableDirectory::open_existing(path)
        .map_err(|error| managed_error("UPDATE_WEB_QUIESCENCE_DIRECTORY_FAILED", error))?
        .ok_or_else(|| {
            WebQuiescenceError::new(
                "UPDATE_WEB_QUIESCENCE_STATE_MISSING",
                "Web 静默事务目录不存在",
            )
        })
}

fn required_record(
    directory: &StableDirectory,
) -> Result<WebQuiescenceRecordV1, WebQuiescenceError> {
    load_record(directory)?.ok_or_else(|| {
        WebQuiescenceError::new("UPDATE_WEB_QUIESCENCE_STATE_MISSING", "Web 静默事务不存在")
    })
}

fn load_record(
    directory: &StableDirectory,
) -> Result<Option<WebQuiescenceRecordV1>, WebQuiescenceError> {
    let record = load_document(
        directory,
        WEB_QUIESCENCE_FILE_NAME,
        MAX_WEB_QUIESCENCE_BYTES,
    )?;
    if let Some(record) = record.as_ref() {
        validate_record(record)?;
    }
    Ok(record)
}

fn load_completion(
    directory: &StableDirectory,
) -> Result<Option<WebQuiescenceCompletionV1>, WebQuiescenceError> {
    let completion = load_document(
        directory,
        WEB_QUIESCENCE_COMPLETION_FILE_NAME,
        MAX_WEB_QUIESCENCE_BYTES,
    )?;
    if let Some(completion) = completion.as_ref() {
        validate_completion(completion)?;
    }
    Ok(completion)
}

fn load_checkpoint(
    directory: &StableDirectory,
) -> Result<Option<PlaybackExitCheckpointV1>, WebQuiescenceError> {
    let checkpoint = load_document(
        directory,
        PLAYBACK_EXIT_CHECKPOINT_FILE_NAME,
        MAX_PLAYBACK_CHECKPOINT_BYTES,
    )?;
    if let Some(checkpoint) = checkpoint.as_ref() {
        validate_checkpoint(checkpoint)?;
    }
    Ok(checkpoint)
}

fn load_document<T>(
    directory: &StableDirectory,
    file_name: &str,
    max_bytes: u64,
) -> Result<Option<T>, WebQuiescenceError>
where
    T: DeserializeOwned + Serialize,
{
    let Some(mut file) = directory
        .open_regular_read(OsStr::new(file_name))
        .map_err(|error| managed_error("UPDATE_WEB_QUIESCENCE_OPEN_FAILED", error))?
    else {
        return Ok(None);
    };
    let metadata = file.metadata().map_err(|error| {
        io_error(
            "UPDATE_WEB_QUIESCENCE_READ_FAILED",
            "读取静默事务文件元数据",
            error,
        )
    })?;
    if metadata.len() > max_bytes {
        return Err(size_error());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            io_error(
                "UPDATE_WEB_QUIESCENCE_READ_FAILED",
                "读取静默事务文件",
                error,
            )
        })?;
    if bytes.len() as u64 > max_bytes {
        return Err(size_error());
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Err(WebQuiescenceError::new(
            "UPDATE_WEB_QUIESCENCE_BOM_REJECTED",
            "静默事务文件不允许 UTF-8 BOM",
        ));
    }
    let document: T = serde_json::from_slice(&bytes).map_err(|error| {
        WebQuiescenceError::new(
            "UPDATE_WEB_QUIESCENCE_INVALID_JSON",
            format!("静默事务文件不是严格 v1 JSON：{error}"),
        )
    })?;
    if canonical_document(&document, max_bytes)? != bytes {
        return Err(WebQuiescenceError::new(
            "UPDATE_WEB_QUIESCENCE_NONCANONICAL",
            "静默事务文件不是 canonical v1 编码",
        ));
    }
    Ok(Some(document))
}

fn save_document<T: Serialize>(
    directory: &StableDirectory,
    file_name: &str,
    document: &T,
    max_bytes: u64,
) -> Result<(), WebQuiescenceError> {
    let canonical = canonical_document(document, max_bytes)?;
    save_canonical_bytes(directory, file_name, &canonical)
}

fn save_canonical_bytes(
    directory: &StableDirectory,
    file_name: &str,
    canonical: &[u8],
) -> Result<(), WebQuiescenceError> {
    let (temporary_name, mut temporary) = create_temporary_file(directory, file_name)?;
    if let Err(error) = temporary
        .write_all(canonical)
        .and_then(|()| temporary.sync_all())
    {
        drop(temporary);
        let _ = directory.remove_regular(&temporary_name);
        return Err(io_error(
            "UPDATE_WEB_QUIESCENCE_WRITE_FAILED",
            "写入并同步静默事务临时文件",
            error,
        ));
    }
    if let Err(error) =
        directory.publish_replace(&temporary, &temporary_name, OsStr::new(file_name))
    {
        drop(temporary);
        let _ = directory.remove_regular(&temporary_name);
        return Err(managed_error("UPDATE_WEB_QUIESCENCE_REPLACE_FAILED", error));
    }
    drop(temporary);
    sync_parent_directory(directory.path()).map_err(|error| {
        io_error(
            "UPDATE_WEB_QUIESCENCE_DIRECTORY_SYNC_FAILED",
            "同步静默事务目录",
            error,
        )
    })
}

fn remove_document(directory: &StableDirectory, file_name: &str) -> Result<(), WebQuiescenceError> {
    match directory.remove_regular(OsStr::new(file_name)) {
        Ok(true) => sync_parent_directory(directory.path()).map_err(|error| {
            io_error(
                "UPDATE_WEB_QUIESCENCE_DIRECTORY_SYNC_FAILED",
                "同步静默事务目录",
                error,
            )
        }),
        Ok(false) => Ok(()),
        Err(error) => Err(managed_error("UPDATE_WEB_QUIESCENCE_DELETE_FAILED", error)),
    }
}

fn canonical_document<T: Serialize>(
    document: &T,
    max_bytes: u64,
) -> Result<Vec<u8>, WebQuiescenceError> {
    let mut bytes = serde_json::to_vec(document).map_err(|error| {
        WebQuiescenceError::new(
            "UPDATE_WEB_QUIESCENCE_ENCODE_FAILED",
            format!("编码静默事务失败：{error}"),
        )
    })?;
    bytes.push(b'\n');
    if bytes.len() as u64 > max_bytes {
        return Err(size_error());
    }
    Ok(bytes)
}

fn create_temporary_file(
    directory: &StableDirectory,
    destination_name: &str,
) -> Result<(OsString, File), WebQuiescenceError> {
    for _ in 0..TEMPORARY_FILE_ATTEMPTS {
        let suffix = random_lower_hex_128()?;
        let temporary_name = OsString::from(format!(".{destination_name}.tmp-{suffix}"));
        match directory.create_new_renameable(&temporary_name) {
            Ok(file) => return Ok((temporary_name, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(managed_error(
                    "UPDATE_WEB_QUIESCENCE_TEMP_CREATE_FAILED",
                    error,
                ));
            }
        }
    }
    Err(WebQuiescenceError::new(
        "UPDATE_WEB_QUIESCENCE_TEMP_COLLISION",
        "无法创建唯一的静默事务临时文件",
    ))
}

fn validate_record(record: &WebQuiescenceRecordV1) -> Result<(), WebQuiescenceError> {
    if record.schema != WEB_QUIESCENCE_SCHEMA {
        return Err(WebQuiescenceError::new(
            "UPDATE_WEB_QUIESCENCE_SCHEMA_REJECTED",
            "Web 静默事务 schema 不受支持",
        ));
    }
    validate_identity(&identity_from_record(record))?;
    match record.phase {
        WebQuiescencePhase::PrepareRequested => {
            if record.checkpoint_receipt.is_some()
                || record.checkpoint_digest.is_some()
                || record.native_rollback_completed
                || record.rollback_acknowledged
            {
                return Err(invalid_record());
            }
        }
        WebQuiescencePhase::Prepared => {
            validate_evidence(&required_record_evidence(record)?)?;
            if record.native_rollback_completed || record.rollback_acknowledged {
                return Err(invalid_record());
            }
        }
        WebQuiescencePhase::RollbackRequired => {
            if record.checkpoint_receipt.is_some() != record.checkpoint_digest.is_some() {
                return Err(invalid_record());
            }
            if let Some(evidence) = record_evidence(record) {
                validate_evidence(&evidence)?;
            }
            if record.rollback_acknowledged && !record.native_rollback_completed {
                return Err(invalid_record());
            }
        }
    }
    Ok(())
}

fn validate_completion(completion: &WebQuiescenceCompletionV1) -> Result<(), WebQuiescenceError> {
    if completion.schema != WEB_QUIESCENCE_COMPLETION_SCHEMA {
        return Err(WebQuiescenceError::new(
            "UPDATE_WEB_QUIESCENCE_COMPLETION_SCHEMA_REJECTED",
            "Web 静默 completion schema 不受支持",
        ));
    }
    validate_identity(&identity_from_completion(completion))?;
    match completion.kind {
        WebQuiescenceCompletionKind::Restored => {
            let evidence = CheckpointEvidence {
                receipt: completion
                    .checkpoint_receipt
                    .clone()
                    .ok_or_else(completion_invalid)?,
                digest: completion
                    .checkpoint_digest
                    .clone()
                    .ok_or_else(completion_invalid)?,
            };
            validate_evidence(&evidence)
        }
        WebQuiescenceCompletionKind::NoOpNotPrepared
            if completion.checkpoint_receipt.is_none()
                && completion.checkpoint_digest.is_none() =>
        {
            Ok(())
        }
        WebQuiescenceCompletionKind::NoOpNotPrepared => Err(completion_invalid()),
        WebQuiescenceCompletionKind::ConsumedByAppliedInstall => {
            let evidence = CheckpointEvidence {
                receipt: completion
                    .checkpoint_receipt
                    .clone()
                    .ok_or_else(completion_invalid)?,
                digest: completion
                    .checkpoint_digest
                    .clone()
                    .ok_or_else(completion_invalid)?,
            };
            validate_evidence(&evidence)
        }
    }
}

fn validate_checkpoint(checkpoint: &PlaybackExitCheckpointV1) -> Result<(), WebQuiescenceError> {
    if checkpoint.schema != PLAYBACK_EXIT_CHECKPOINT_SCHEMA {
        return Err(checkpoint_invalid("checkpoint schema 不受支持"));
    }
    validate_operation_id(&checkpoint.operation_id)?;
    validate_receipt(&checkpoint.receipt)?;
    if matches!(
        checkpoint.source_kind,
        PlaybackCheckpointSourceKind::Blob
            | PlaybackCheckpointSourceKind::Local
            | PlaybackCheckpointSourceKind::Opaque
    ) {
        return Err(WebQuiescenceError::new(
            "UPDATE_PLAYBACK_CHECKPOINT_LOCAL_SOURCE_UNSUPPORTED",
            "本地、blob 或 opaque 播放源不能作为跨重启 checkpoint",
        ));
    }
    if checkpoint.queue.len() > MAX_CHECKPOINT_QUEUE {
        return Err(checkpoint_invalid("checkpoint queue 超过 240 首硬上限"));
    }
    if checkpoint.captured_playback_intent_id > MAX_WEB_SAFE_INTEGER {
        return Err(checkpoint_invalid(
            "capturedPlaybackIntentId 超出 JavaScript 安全整数边界",
        ));
    }
    for track in &checkpoint.queue {
        validate_track(track)?;
    }
    if let Some(stream_source) = checkpoint.stream_source.as_ref() {
        validate_text(&stream_source.id, 512, false, "streamSource.id")?;
        if checkpoint.current_track_index.is_none() {
            return Err(checkpoint_invalid("空 currentTrack 不能携带 streamSource"));
        }
    }
    validate_bounded_number(checkpoint.position_ms, "positionMs")?;
    if let Some(duration) = checkpoint.duration_ms {
        validate_bounded_number(duration, "durationMs")?;
        if checkpoint.position_ms > duration + 1_000.0 {
            return Err(checkpoint_invalid("positionMs 超出 durationMs"));
        }
    }
    if !checkpoint.volume.is_finite() || !(0.0..=1.0).contains(&checkpoint.volume) {
        return Err(checkpoint_invalid("volume 必须位于 0..=1"));
    }
    let restart_restorable = matches!(
        checkpoint.source_kind,
        PlaybackCheckpointSourceKind::Remote | PlaybackCheckpointSourceKind::None
    );
    if checkpoint.restart_restorable != restart_restorable {
        return Err(checkpoint_invalid("restartRestorable 与 sourceKind 不一致"));
    }
    match checkpoint.current_track_index {
        None => {
            if !checkpoint.current_track_ref.is_empty()
                || checkpoint.source_kind != PlaybackCheckpointSourceKind::None
                || checkpoint.was_playing
                || checkpoint.position_ms != 0.0
                || checkpoint.duration_ms.is_some()
            {
                return Err(checkpoint_invalid("空 currentTrack 的状态不一致"));
            }
        }
        Some(index) => {
            if checkpoint.source_kind != PlaybackCheckpointSourceKind::Remote {
                return Err(checkpoint_invalid(
                    "有 currentTrack 时 sourceKind 必须是 remote",
                ));
            }
            let track = checkpoint
                .queue
                .get(index)
                .ok_or_else(|| checkpoint_invalid("currentTrackIndex 越界"))?;
            let expected = format!("{}:{}", track.provider.as_str(), track.id);
            if checkpoint.current_track_ref != expected {
                return Err(checkpoint_invalid(
                    "currentTrackRef 与 queue identity 不一致",
                ));
            }
        }
    }
    Ok(())
}

fn validate_track(track: &PlaybackCheckpointTrack) -> Result<(), WebQuiescenceError> {
    validate_text(&track.id, 512, false, "track.id")?;
    validate_text(&track.source_id, 512, false, "track.sourceId")?;
    if let Some(media_mid) = track.media_mid.as_ref() {
        validate_text(media_mid, 512, false, "track.mediaMid")?;
    }
    validate_text(&track.title, 512, true, "track.title")?;
    validate_text(&track.album, 512, true, "track.album")?;
    if track.artists.len() > MAX_TRACK_ARTISTS
        || track.quality_hints.len() > MAX_TRACK_QUALITY_HINTS
    {
        return Err(checkpoint_invalid("track array 字段超过上限"));
    }
    for artist in &track.artists {
        validate_text(artist, 256, true, "track.artists")?;
    }
    for hint in &track.quality_hints {
        validate_text(hint, 64, true, "track.qualityHints")?;
    }
    if let Some(duration) = track.duration_ms {
        if duration > MAX_TRACK_DURATION_MS as u64 {
            return Err(checkpoint_invalid(
                "track.durationMs 必须是有界非负安全整数",
            ));
        }
    }
    Ok(())
}

fn validate_bounded_number(value: f64, field: &str) -> Result<(), WebQuiescenceError> {
    if !value.is_finite() || !(0.0..=MAX_TRACK_DURATION_MS).contains(&value) {
        return Err(checkpoint_invalid(format!("{field} 必须是有界非负数")));
    }
    Ok(())
}

fn validate_text(
    value: &str,
    max_utf16_units: usize,
    allow_empty: bool,
    field: &str,
) -> Result<(), WebQuiescenceError> {
    if (!allow_empty && value.is_empty())
        || value.encode_utf16().count() > max_utf16_units
        || value
            .chars()
            .any(|character| matches!(character, '\u{0000}'..='\u{001f}' | '\u{007f}'))
    {
        return Err(checkpoint_invalid(format!("{field} 不是有界安全文本")));
    }
    Ok(())
}

fn validate_identity(identity: &WebQuiescenceIdentity) -> Result<(), WebQuiescenceError> {
    validate_operation_id(&identity.operation_id)?;
    validate_operation_generation(identity.operation_generation)?;
    validate_candidate_id(&identity.candidate_id)
}

fn validate_operation_generation(value: u64) -> Result<(), WebQuiescenceError> {
    if value == 0 || value > MAX_WEB_SAFE_INTEGER {
        return Err(WebQuiescenceError::new(
            "UPDATE_WEB_QUIESCENCE_GENERATION_REJECTED",
            "operationGeneration 必须是正的 JavaScript 安全整数",
        ));
    }
    Ok(())
}

fn validate_operation_id(value: &str) -> Result<(), WebQuiescenceError> {
    if is_lower_hex(value, 32) {
        Ok(())
    } else {
        Err(WebQuiescenceError::new(
            "UPDATE_WEB_QUIESCENCE_OPERATION_ID_REJECTED",
            "operationId 必须是 128-bit 小写十六进制",
        ))
    }
}

fn validate_candidate_id(value: &str) -> Result<(), WebQuiescenceError> {
    if is_lower_hex(value, 64) {
        Ok(())
    } else {
        Err(WebQuiescenceError::new(
            "UPDATE_WEB_QUIESCENCE_CANDIDATE_ID_REJECTED",
            "candidateId 必须是 256-bit 小写十六进制",
        ))
    }
}

fn validate_receipt(value: &str) -> Result<(), WebQuiescenceError> {
    if is_lower_hex(value, 32) {
        Ok(())
    } else {
        Err(WebQuiescenceError::new(
            "UPDATE_PLAYBACK_CHECKPOINT_RECEIPT_REJECTED",
            "checkpoint receipt 必须是 128-bit 小写十六进制",
        ))
    }
}

fn validate_evidence(evidence: &CheckpointEvidence) -> Result<(), WebQuiescenceError> {
    validate_receipt(&evidence.receipt)?;
    if is_lower_hex(&evidence.digest, 64) {
        Ok(())
    } else {
        Err(WebQuiescenceError::new(
            "UPDATE_PLAYBACK_CHECKPOINT_DIGEST_REJECTED",
            "checkpoint digest 必须是 SHA-256 小写十六进制",
        ))
    }
}

fn validate_rollback_acknowledgement(
    acknowledgement: &RollbackAcknowledgement,
) -> Result<(), WebQuiescenceError> {
    match acknowledgement {
        RollbackAcknowledgement::Restored(evidence) => validate_evidence(evidence),
        RollbackAcknowledgement::NoOpNotPrepared => Ok(()),
    }
}

fn ensure_record_identity(
    record: &WebQuiescenceRecordV1,
    identity: &WebQuiescenceIdentity,
) -> Result<(), WebQuiescenceError> {
    if record.operation_id == identity.operation_id
        && record.operation_generation == identity.operation_generation
        && record.candidate_id == identity.candidate_id
    {
        Ok(())
    } else {
        Err(stale_identity())
    }
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn random_lower_hex_128() -> Result<String, WebQuiescenceError> {
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce).map_err(|error| {
        WebQuiescenceError::new(
            "UPDATE_WEB_QUIESCENCE_ENTROPY_FAILED",
            format!("生成 Web 静默事务随机 identity 失败：{error}"),
        )
    })?;
    Ok(nonce.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn checkpoint_invalid(message: impl Into<String>) -> WebQuiescenceError {
    WebQuiescenceError::new("UPDATE_PLAYBACK_CHECKPOINT_INVALID", message)
}

fn invalid_record() -> WebQuiescenceError {
    WebQuiescenceError::new(
        "UPDATE_WEB_QUIESCENCE_STATE_REJECTED",
        "Web 静默事务状态组合无效",
    )
}

fn completion_invalid() -> WebQuiescenceError {
    WebQuiescenceError::new(
        "UPDATE_WEB_QUIESCENCE_COMPLETION_REJECTED",
        "Web 静默 completion tombstone 状态无效",
    )
}

fn invalid_order(message: impl Into<String>) -> WebQuiescenceError {
    WebQuiescenceError::new("UPDATE_WEB_QUIESCENCE_INVALID_ORDER", message)
}

fn stale_identity() -> WebQuiescenceError {
    WebQuiescenceError::new(
        "UPDATE_WEB_QUIESCENCE_STALE_IDENTITY",
        "Web 静默 acknowledgement identity 已过期或不匹配",
    )
}

fn size_error() -> WebQuiescenceError {
    WebQuiescenceError::new(
        "UPDATE_WEB_QUIESCENCE_SIZE_REJECTED",
        "静默事务文件超过固定大小上限",
    )
}

fn managed_error(code: &'static str, error: io::Error) -> WebQuiescenceError {
    let message = if matches!(
        error.kind(),
        io::ErrorKind::InvalidInput | io::ErrorKind::PermissionDenied | io::ErrorKind::IsADirectory
    ) {
        "受管静默事务路径不安全".into()
    } else {
        format!("访问受管静默事务路径失败：{error}")
    };
    WebQuiescenceError::new(code, message)
}

fn io_error(code: &'static str, operation: &'static str, error: io::Error) -> WebQuiescenceError {
    WebQuiescenceError::new(code, format!("{operation}失败：{error}"))
}

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn deserialize_optional_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

fn deserialize_optional_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    u64::deserialize(deserializer).map(Some)
}

fn deserialize_optional_f64<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<f64>::deserialize(deserializer)
}

fn deserialize_optional_stream_source<'de, D>(
    deserializer: D,
) -> Result<Option<PlaybackCheckpointStreamSource>, D::Error>
where
    D: Deserializer<'de>,
{
    PlaybackCheckpointStreamSource::deserialize(deserializer).map(Some)
}

#[cfg(windows)]
fn sync_parent_directory(_path: &Path) -> io::Result<()> {
    // Windows 的 replace 已对 source handle FlushFileBuffers；StableDirectory 仍固定目录链。
    Ok(())
}

#[cfg(not(windows))]
fn sync_parent_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            for _ in 0..8 {
                let suffix = random_lower_hex_128().expect("测试目录应取得系统随机数");
                let path =
                    std::env::temp_dir().join(format!("mineradio-web-quiescence-{label}-{suffix}"));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("应创建 quiescence 测试目录：{error}"),
                }
            }
            panic!("无法创建唯一 quiescence 测试目录");
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn candidate_id() -> String {
        "a".repeat(64)
    }

    fn receipt() -> String {
        "b".repeat(32)
    }

    fn begin(
        store: &NativeWebQuiescenceStore,
    ) -> (PrepareWebQuiescenceRequest, WebQuiescenceIdentity) {
        let request = store
            .begin_prepare(&candidate_id(), 100)
            .expect("应提交 prepare-requested");
        let identity = request.identity.clone();
        (request, identity)
    }

    fn checkpoint(operation_id: &str) -> PlaybackExitCheckpointV1 {
        PlaybackExitCheckpointV1 {
            schema: PLAYBACK_EXIT_CHECKPOINT_SCHEMA.into(),
            operation_id: operation_id.into(),
            receipt: receipt(),
            queue: vec![PlaybackCheckpointTrack {
                provider: PlaybackCheckpointProvider::Netease,
                id: "song-1".into(),
                source_id: "song-1".into(),
                media_mid: None,
                title: "测试歌曲".into(),
                artists: vec!["测试歌手".into()],
                album: "测试专辑".into(),
                duration_ms: Some(180_000),
                quality_hints: vec!["standard".into()],
                playable_state: PlaybackCheckpointPlayableState::Playable,
            }],
            current_track_index: Some(0),
            current_track_ref: "netease:song-1".into(),
            captured_playback_intent_id: 7,
            position_ms: 12_345.0,
            duration_ms: Some(180_000.0),
            was_playing: true,
            volume: 0.84,
            muted: false,
            mode: PlaybackCheckpointMode::Loop,
            source_kind: PlaybackCheckpointSourceKind::Remote,
            restart_restorable: true,
            stream_source: None,
        }
    }

    fn prepared(store: &NativeWebQuiescenceStore) -> (WebQuiescenceIdentity, CheckpointEvidence) {
        let (_, identity) = begin(store);
        let evidence = store
            .persist_checkpoint(&identity, &checkpoint(&identity.operation_id))
            .expect("应持久化 checkpoint");
        assert_eq!(
            store
                .acknowledge_prepared(&identity, &evidence, 200)
                .unwrap(),
            PreparedAcknowledgementOutcome::Prepared
        );
        (identity, evidence)
    }

    #[test]
    fn shared_web_checkpoint_fixture_round_trips_without_private_urls_or_null_optionals() {
        let raw = include_str!("fixtures/playback-exit-checkpoint-v1.json");
        let expected: serde_json::Value = serde_json::from_str(raw).unwrap();
        let checkpoint: PlaybackExitCheckpointV1 = serde_json::from_str(raw).unwrap();

        validate_checkpoint(&checkpoint).unwrap();
        let actual = serde_json::to_value(&checkpoint).unwrap();
        assert_eq!(actual, expected);
        assert!(actual.get("operationGeneration").is_none());
        assert!(actual["queue"]
            .as_array()
            .unwrap()
            .iter()
            .all(|track| track.get("coverUrl").is_none()));
        assert!(actual["queue"][0].get("mediaMid").is_none());
        assert!(actual["queue"][0].get("durationMs").is_none());

        let mut forbidden_url = expected.clone();
        forbidden_url["queue"][0]["coverUrl"] =
            serde_json::json!("https://media.invalid/cover?token=secret");
        assert!(serde_json::from_value::<PlaybackExitCheckpointV1>(forbidden_url).is_err());

        let mut missing_required = expected.clone();
        missing_required["queue"][0]
            .as_object_mut()
            .unwrap()
            .remove("album");
        assert!(serde_json::from_value::<PlaybackExitCheckpointV1>(missing_required).is_err());

        let mut explicit_null = expected;
        explicit_null["queue"][0]["mediaMid"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<PlaybackExitCheckpointV1>(explicit_null).is_err());
    }

    #[test]
    fn stream_source_and_kugou_checkpoint_round_trip_strictly() {
        let mut value = checkpoint(&"a".repeat(32));
        value.queue[0].provider = PlaybackCheckpointProvider::Kugou;
        value.current_track_ref = "kugou:song-1".into();
        value.stream_source = Some(PlaybackCheckpointStreamSource {
            provider: PlaybackCheckpointProvider::Kugou,
            id: "radio-42".into(),
        });

        validate_checkpoint(&value).expect("Kugou 流式 checkpoint 应有效");
        let encoded = serde_json::to_value(&value).unwrap();
        assert_eq!(encoded["streamSource"]["provider"], "kugou");
        let decoded: PlaybackExitCheckpointV1 = serde_json::from_value(encoded.clone()).unwrap();
        assert_eq!(decoded, value);

        let mut explicit_null = encoded;
        explicit_null["streamSource"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<PlaybackExitCheckpointV1>(explicit_null).is_err());

        value.stream_source.as_mut().unwrap().id.clear();
        assert_eq!(
            validate_checkpoint(&value).unwrap_err().code(),
            "UPDATE_PLAYBACK_CHECKPOINT_INVALID"
        );
    }

    #[test]
    fn playback_intent_is_an_identity_counter_not_a_media_duration() {
        let mut value = checkpoint(&"a".repeat(32));
        value.captured_playback_intent_id = 700_000_000;
        validate_checkpoint(&value).expect("长生命周期 intent 计数器应保持有效");

        value.captured_playback_intent_id = MAX_WEB_SAFE_INTEGER + 1;
        assert_eq!(
            validate_checkpoint(&value).unwrap_err().code(),
            "UPDATE_PLAYBACK_CHECKPOINT_INVALID"
        );
    }

    #[test]
    fn operation_generation_is_bounded_by_the_javascript_safe_integer_limit() {
        let valid = WebQuiescenceIdentity {
            operation_id: "a".repeat(32),
            operation_generation: MAX_WEB_SAFE_INTEGER,
            candidate_id: candidate_id(),
        };
        validate_identity(&valid).expect("JavaScript 最大安全整数应仍可作为 generation");

        let mut overflow = valid.clone();
        overflow.operation_generation = MAX_WEB_SAFE_INTEGER + 1;
        assert_eq!(
            validate_identity(&overflow).unwrap_err().code(),
            "UPDATE_WEB_QUIESCENCE_GENERATION_REJECTED"
        );

        let root = TestDirectory::new("generation-exhausted");
        let directory = StableDirectory::open_existing(&root.0).unwrap().unwrap();
        let completion =
            completion_from_acknowledgement(&valid, &RollbackAcknowledgement::NoOpNotPrepared, 100);
        save_document(
            &directory,
            WEB_QUIESCENCE_COMPLETION_FILE_NAME,
            &completion,
            MAX_WEB_QUIESCENCE_BYTES,
        )
        .unwrap();
        drop(directory);

        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        assert_eq!(
            store
                .begin_prepare(&candidate_id(), 101)
                .unwrap_err()
                .code(),
            "UPDATE_WEB_QUIESCENCE_GENERATION_EXHAUSTED"
        );
        assert!(!root.0.join(WEB_QUIESCENCE_FILE_NAME).exists());
    }

    #[test]
    fn checkpoint_total_size_is_capped_at_the_shared_256_kib_boundary() {
        let root = TestDirectory::new("checkpoint-size");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (_, identity) = begin(&store);
        let mut value = checkpoint(&identity.operation_id);
        let mut large_track = value.queue[0].clone();
        large_track.artists = vec!["艺".repeat(256); MAX_TRACK_ARTISTS];
        value.queue = vec![large_track; MAX_CHECKPOINT_QUEUE];

        assert_eq!(
            store
                .persist_checkpoint(&identity, &value)
                .unwrap_err()
                .code(),
            "UPDATE_WEB_QUIESCENCE_SIZE_REJECTED"
        );
        assert!(!root.0.join(PLAYBACK_EXIT_CHECKPOINT_FILE_NAME).exists());
    }

    #[test]
    fn prepare_request_is_returned_only_after_canonical_record_is_durable() {
        let root = TestDirectory::new("prepare-first");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);

        let (request, identity) = begin(&store);

        assert_eq!(request.identity, identity);
        assert!(is_lower_hex(&identity.operation_id, 32));
        let raw = fs::read(root.0.join(WEB_QUIESCENCE_FILE_NAME)).unwrap();
        let directory = StableDirectory::open_existing(&root.0).unwrap().unwrap();
        let record = load_record(&directory).unwrap().unwrap();
        assert_eq!(record.phase, WebQuiescencePhase::PrepareRequested);
        assert_eq!(
            raw,
            canonical_document(&record, MAX_WEB_QUIESCENCE_BYTES).unwrap()
        );
        assert!(!root.0.join(PLAYBACK_EXIT_CHECKPOINT_FILE_NAME).exists());
    }

    #[test]
    fn checkpoint_is_persisted_before_prepared_ack_and_ack_is_exact_and_idempotent() {
        let root = TestDirectory::new("prepared-ack");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (_, identity) = begin(&store);
        let value = checkpoint(&identity.operation_id);

        let evidence = store.persist_checkpoint(&identity, &value).unwrap();
        assert_eq!(evidence.receipt, receipt());
        assert_eq!(
            evidence.digest,
            sha256_hex(&canonical_document(&value, MAX_PLAYBACK_CHECKPOINT_BYTES).unwrap())
        );
        assert_eq!(
            store
                .acknowledge_prepared(&identity, &evidence, 200)
                .unwrap(),
            PreparedAcknowledgementOutcome::Prepared
        );
        assert_eq!(
            store
                .acknowledge_prepared(&identity, &evidence, 201)
                .unwrap(),
            PreparedAcknowledgementOutcome::AlreadyPrepared
        );

        let mut forged = evidence.clone();
        forged.digest = "c".repeat(64);
        assert_eq!(
            store
                .acknowledge_prepared(&identity, &forged, 202)
                .unwrap_err()
                .code(),
            "UPDATE_WEB_QUIESCENCE_STALE_IDENTITY"
        );
        assert_eq!(
            store.reconcile_web(203).unwrap(),
            WebQuiescenceReconciliation::NativeRollbackRequired(identity)
        );
    }

    #[test]
    fn malformed_or_missing_current_ack_evidence_is_durably_rollback_required() {
        let root = TestDirectory::new("malformed-current-ack");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (_, identity) = begin(&store);
        let evidence = store
            .persist_checkpoint(&identity, &checkpoint(&identity.operation_id))
            .unwrap();
        let malformed = CheckpointEvidence {
            receipt: "not-a-receipt".into(),
            digest: evidence.digest.clone(),
        };

        assert_eq!(
            store
                .acknowledge_prepared(&identity, &malformed, 200)
                .unwrap_err()
                .code(),
            "UPDATE_PLAYBACK_CHECKPOINT_RECEIPT_REJECTED"
        );
        assert_eq!(
            store.reconcile_web(201).unwrap(),
            WebQuiescenceReconciliation::NativeRollbackRequired(identity)
        );

        let missing_root = TestDirectory::new("missing-current-checkpoint");
        let missing_store = NativeWebQuiescenceStore::with_updater_directory(&missing_root.0);
        let (_, missing_identity) = begin(&missing_store);
        let missing_evidence = missing_store
            .persist_checkpoint(
                &missing_identity,
                &checkpoint(&missing_identity.operation_id),
            )
            .unwrap();
        missing_store
            .acknowledge_prepared(&missing_identity, &missing_evidence, 299)
            .unwrap();
        fs::remove_file(missing_root.0.join(PLAYBACK_EXIT_CHECKPOINT_FILE_NAME)).unwrap();

        assert_eq!(
            missing_store
                .acknowledge_prepared(&missing_identity, &missing_evidence, 300)
                .unwrap_err()
                .code(),
            "UPDATE_PLAYBACK_CHECKPOINT_MISSING"
        );
        assert_eq!(
            missing_store.reconcile_web(301).unwrap(),
            WebQuiescenceReconciliation::NativeRollbackRequired(missing_identity)
        );
    }

    #[test]
    fn acknowledgement_from_a_completed_old_operation_does_not_mutate_the_current_operation() {
        let root = TestDirectory::new("old-ack-isolated");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (old_identity, old_evidence) = prepared(&store);
        store.mark_rollback_required(&old_identity, 300).unwrap();
        store.confirm_native_rollback(&old_identity, 301).unwrap();
        store
            .acknowledge_rollback(
                &old_identity,
                &RollbackAcknowledgement::Restored(old_evidence.clone()),
                302,
            )
            .unwrap();

        let (_, current_identity) = begin(&store);
        let current_evidence = store
            .persist_checkpoint(
                &current_identity,
                &checkpoint(&current_identity.operation_id),
            )
            .unwrap();
        assert_eq!(
            store
                .acknowledge_prepared(&old_identity, &old_evidence, 400)
                .unwrap_err()
                .code(),
            "UPDATE_WEB_QUIESCENCE_STALE_IDENTITY"
        );

        let directory = StableDirectory::open_existing(&root.0).unwrap().unwrap();
        let current = load_record(&directory).unwrap().unwrap();
        assert_eq!(identity_from_record(&current), current_identity);
        assert_eq!(current.phase, WebQuiescencePhase::PrepareRequested);
        drop(directory);
        assert_eq!(
            store
                .request_rollback_after_native_confirmation(&old_identity)
                .unwrap(),
            RollbackWebQuiescencePlan::AlreadyCompleted
        );
        assert_eq!(
            store
                .acknowledge_prepared(&current_identity, &current_evidence, 401)
                .unwrap(),
            PreparedAcknowledgementOutcome::Prepared
        );
    }

    #[test]
    fn local_blob_and_opaque_sources_fail_closed_without_creating_checkpoint() {
        for source_kind in [
            PlaybackCheckpointSourceKind::Local,
            PlaybackCheckpointSourceKind::Blob,
            PlaybackCheckpointSourceKind::Opaque,
        ] {
            let root = TestDirectory::new("unsupported-source");
            let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
            let (_, identity) = begin(&store);
            let mut value = checkpoint(&identity.operation_id);
            value.source_kind = source_kind;
            value.restart_restorable = false;

            assert_eq!(
                store
                    .persist_checkpoint(&identity, &value)
                    .unwrap_err()
                    .code(),
                "UPDATE_PLAYBACK_CHECKPOINT_LOCAL_SOURCE_UNSUPPORTED"
            );
            assert!(!root.0.join(PLAYBACK_EXIT_CHECKPOINT_FILE_NAME).exists());
        }
    }

    #[test]
    fn staged_but_unacknowledged_checkpoint_reconciles_to_exact_rollback() {
        let root = TestDirectory::new("staged-reconcile");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (_, identity) = begin(&store);
        let evidence = store
            .persist_checkpoint(&identity, &checkpoint(&identity.operation_id))
            .unwrap();

        assert_eq!(
            store.reconcile_web(300).unwrap(),
            WebQuiescenceReconciliation::NativeRollbackRequired(identity.clone())
        );
        let request = store.confirm_native_rollback(&identity, 301).unwrap();
        assert_eq!(request.identity, identity);
        let persisted = request
            .checkpoint
            .as_ref()
            .expect("rollback request 应携带完整 checkpoint");
        assert_eq!(persisted.evidence, evidence.clone());
        assert_eq!(persisted.payload, checkpoint(&identity.operation_id));
        assert_eq!(
            store
                .acknowledge_rollback(
                    &identity,
                    &RollbackAcknowledgement::Restored(evidence.clone()),
                    302,
                )
                .unwrap(),
            RollbackAcknowledgementOutcome::Completed
        );
        assert!(!root.0.join(WEB_QUIESCENCE_FILE_NAME).exists());
        assert!(!root.0.join(PLAYBACK_EXIT_CHECKPOINT_FILE_NAME).exists());
        assert_eq!(
            store
                .acknowledge_rollback(&identity, &RollbackAcknowledgement::Restored(evidence), 303,)
                .unwrap(),
            RollbackAcknowledgementOutcome::AlreadyCompleted
        );
    }

    #[test]
    fn exact_rollback_retry_survives_lost_response_and_process_restart() {
        let root = TestDirectory::new("completion-retry");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (identity, evidence) = prepared(&store);
        store.mark_rollback_required(&identity, 300).unwrap();
        store.confirm_native_rollback(&identity, 301).unwrap();
        let acknowledgement = RollbackAcknowledgement::Restored(evidence);

        assert_eq!(
            store
                .acknowledge_rollback(&identity, &acknowledgement, 302)
                .unwrap(),
            RollbackAcknowledgementOutcome::Completed
        );
        assert!(root.0.join("web-quiescence-completion-v1.json").is_file());

        let restarted = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        assert_eq!(
            restarted
                .acknowledge_rollback(&identity, &acknowledgement, 303)
                .unwrap(),
            RollbackAcknowledgementOutcome::AlreadyCompleted
        );
        assert_eq!(
            restarted.reconcile_web(304).unwrap(),
            WebQuiescenceReconciliation::CompletedRecovered(identity)
        );
    }

    #[test]
    fn no_op_completion_retry_is_durable_and_cannot_be_forged_as_restored() {
        let root = TestDirectory::new("completion-no-op");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (_, identity) = begin(&store);
        store.mark_rollback_required(&identity, 200).unwrap();
        store.confirm_native_rollback(&identity, 201).unwrap();

        assert_eq!(
            store
                .acknowledge_rollback(&identity, &RollbackAcknowledgement::NoOpNotPrepared, 202,)
                .unwrap(),
            RollbackAcknowledgementOutcome::Completed
        );
        let restarted = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        assert_eq!(
            restarted
                .acknowledge_rollback(&identity, &RollbackAcknowledgement::NoOpNotPrepared, 203,)
                .unwrap(),
            RollbackAcknowledgementOutcome::AlreadyCompleted
        );
        assert_eq!(
            restarted
                .acknowledge_rollback(
                    &identity,
                    &RollbackAcknowledgement::Restored(CheckpointEvidence {
                        receipt: receipt(),
                        digest: "d".repeat(64),
                    }),
                    204,
                )
                .unwrap_err()
                .code(),
            "UPDATE_WEB_QUIESCENCE_STALE_IDENTITY"
        );
    }

    #[test]
    fn completing_a_newer_active_operation_replaces_only_the_previous_tombstone() {
        let root = TestDirectory::new("completion-bounded");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (first_identity, first_evidence) = prepared(&store);
        store.mark_rollback_required(&first_identity, 300).unwrap();
        store.confirm_native_rollback(&first_identity, 301).unwrap();
        let first_ack = RollbackAcknowledgement::Restored(first_evidence);
        store
            .acknowledge_rollback(&first_identity, &first_ack, 302)
            .unwrap();

        let (_, second_identity) = begin(&store);
        store.mark_rollback_required(&second_identity, 400).unwrap();
        store
            .confirm_native_rollback(&second_identity, 401)
            .unwrap();
        store
            .acknowledge_rollback(
                &second_identity,
                &RollbackAcknowledgement::NoOpNotPrepared,
                402,
            )
            .unwrap();

        let directory = StableDirectory::open_existing(&root.0).unwrap().unwrap();
        let completion = load_completion(&directory).unwrap().unwrap();
        assert_eq!(identity_from_completion(&completion), second_identity);
        assert_eq!(
            store
                .acknowledge_rollback(&first_identity, &first_ack, 403)
                .unwrap_err()
                .code(),
            "UPDATE_WEB_QUIESCENCE_STALE_IDENTITY"
        );
    }

    #[test]
    fn missing_checkpoint_uses_only_no_op_not_prepared_and_never_fabricates_receipt() {
        let root = TestDirectory::new("no-op-rollback");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (_, identity) = begin(&store);

        assert_eq!(
            store.mark_rollback_required(&identity, 200).unwrap(),
            WebQuiescenceReconciliation::NativeRollbackRequired(identity.clone())
        );
        let request = store.confirm_native_rollback(&identity, 201).unwrap();
        assert_eq!(request.checkpoint, None);
        assert_eq!(
            store
                .acknowledge_rollback(
                    &identity,
                    &RollbackAcknowledgement::Restored(CheckpointEvidence {
                        receipt: receipt(),
                        digest: "d".repeat(64),
                    }),
                    202,
                )
                .unwrap_err()
                .code(),
            "UPDATE_WEB_QUIESCENCE_STALE_IDENTITY"
        );
        assert_eq!(
            store
                .acknowledge_rollback(&identity, &RollbackAcknowledgement::NoOpNotPrepared, 203,)
                .unwrap(),
            RollbackAcknowledgementOutcome::Completed
        );
    }

    #[test]
    fn web_reload_repeats_prepared_evidence_without_replacing_checkpoint() {
        let root = TestDirectory::new("web-reload");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (identity, evidence) = prepared(&store);
        let before = fs::read(root.0.join(PLAYBACK_EXIT_CHECKPOINT_FILE_NAME)).unwrap();

        assert_eq!(
            store.reconcile_web(300).unwrap(),
            WebQuiescenceReconciliation::RepeatPreparedAcknowledgement {
                identity,
                checkpoint: evidence,
            }
        );
        assert_eq!(
            fs::read(root.0.join(PLAYBACK_EXIT_CHECKPOINT_FILE_NAME)).unwrap(),
            before
        );
    }

    #[test]
    fn startup_without_install_attempt_rolls_back_but_marker_keeps_exact_prepared_state() {
        let root = TestDirectory::new("startup");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (identity, evidence) = prepared(&store);
        let directory = StableDirectory::open_existing(&root.0).unwrap().unwrap();
        let persisted = required_checkpoint(&directory, &identity.operation_id).unwrap();
        assert_eq!(persisted.evidence, evidence);

        assert_eq!(
            store.reconcile_startup(true, 300).unwrap(),
            WebQuiescenceReconciliation::InstallAttemptPending {
                identity: identity.clone(),
                checkpoint: persisted,
            }
        );
        assert_eq!(
            store.reconcile_startup(false, 301).unwrap(),
            WebQuiescenceReconciliation::NativeRollbackRequired(identity)
        );
    }

    #[test]
    fn applied_install_consumes_exact_checkpoint_once_and_keeps_completion_identity() {
        let root = TestDirectory::new("applied-consume");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (identity, evidence) = prepared(&store);

        assert_eq!(
            store
                .consume_applied_install(&identity, &evidence, 400)
                .unwrap(),
            AppliedCheckpointConsumeOutcome::Consumed
        );
        assert!(!root.0.join(WEB_QUIESCENCE_FILE_NAME).exists());
        assert!(!root.0.join(PLAYBACK_EXIT_CHECKPOINT_FILE_NAME).exists());
        assert!(root.0.join(WEB_QUIESCENCE_COMPLETION_FILE_NAME).exists());

        assert_eq!(
            store
                .consume_applied_install(&identity, &evidence, 401)
                .unwrap(),
            AppliedCheckpointConsumeOutcome::AlreadyConsumed
        );
        assert_eq!(
            store.reconcile_startup(false, 402).unwrap(),
            WebQuiescenceReconciliation::CompletedRecovered(identity)
        );
    }

    #[test]
    fn applied_install_rejects_mismatched_checkpoint_without_deleting_evidence() {
        let root = TestDirectory::new("applied-mismatch");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (identity, mut evidence) = prepared(&store);
        evidence.digest = "a".repeat(64);

        assert_eq!(
            store
                .consume_applied_install(&identity, &evidence, 400)
                .unwrap_err()
                .code(),
            "UPDATE_WEB_QUIESCENCE_INVALID_ORDER"
        );
        assert!(root.0.join(WEB_QUIESCENCE_FILE_NAME).exists());
        assert!(root.0.join(PLAYBACK_EXIT_CHECKPOINT_FILE_NAME).exists());
        assert!(!root.0.join(WEB_QUIESCENCE_COMPLETION_FILE_NAME).exists());
    }

    #[test]
    fn applied_install_resumes_cleanup_after_completion_was_persisted() {
        let root = TestDirectory::new("applied-completion-crash");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (identity, evidence) = prepared(&store);
        let directory = StableDirectory::open_existing(&root.0).unwrap().unwrap();
        save_document(
            &directory,
            WEB_QUIESCENCE_COMPLETION_FILE_NAME,
            &completion_from_applied_install(&identity, &evidence, 400),
            MAX_WEB_QUIESCENCE_BYTES,
        )
        .unwrap();

        assert_eq!(
            store
                .consume_applied_install(&identity, &evidence, 401)
                .unwrap(),
            AppliedCheckpointConsumeOutcome::AlreadyConsumed
        );
        assert!(!root.0.join(WEB_QUIESCENCE_FILE_NAME).exists());
        assert!(!root.0.join(PLAYBACK_EXIT_CHECKPOINT_FILE_NAME).exists());
    }

    #[test]
    fn install_attempt_restore_accepts_only_exact_restored_completion() {
        let consumed_root = TestDirectory::new("restore-rejects-consumed");
        let consumed_store = NativeWebQuiescenceStore::with_updater_directory(&consumed_root.0);
        let (consumed_identity, consumed_evidence) = prepared(&consumed_store);
        consumed_store
            .consume_applied_install(&consumed_identity, &consumed_evidence, 300)
            .unwrap();
        assert_eq!(
            consumed_store
                .begin_install_attempt_restore(&consumed_identity, &consumed_evidence, 301)
                .unwrap_err()
                .code(),
            "UPDATE_INSTALL_ATTEMPT_WEB_STATE_REJECTED"
        );

        let no_op_root = TestDirectory::new("restore-rejects-no-op");
        let no_op_store = NativeWebQuiescenceStore::with_updater_directory(&no_op_root.0);
        let (_, no_op_identity) = begin(&no_op_store);
        no_op_store
            .mark_rollback_required(&no_op_identity, 400)
            .unwrap();
        no_op_store
            .confirm_native_rollback(&no_op_identity, 401)
            .unwrap();
        no_op_store
            .acknowledge_rollback(
                &no_op_identity,
                &RollbackAcknowledgement::NoOpNotPrepared,
                402,
            )
            .unwrap();
        let never_prepared_evidence = CheckpointEvidence {
            receipt: receipt(),
            digest: "d".repeat(64),
        };
        assert_eq!(
            no_op_store
                .begin_install_attempt_restore(&no_op_identity, &never_prepared_evidence, 403,)
                .unwrap_err()
                .code(),
            "UPDATE_INSTALL_ATTEMPT_WEB_STATE_REJECTED"
        );

        let restored_root = TestDirectory::new("restore-rejects-other-evidence");
        let restored_store = NativeWebQuiescenceStore::with_updater_directory(&restored_root.0);
        let (restored_identity, restored_evidence) = prepared(&restored_store);
        restored_store
            .mark_rollback_required(&restored_identity, 500)
            .unwrap();
        restored_store
            .confirm_native_rollback(&restored_identity, 501)
            .unwrap();
        restored_store
            .acknowledge_rollback(
                &restored_identity,
                &RollbackAcknowledgement::Restored(restored_evidence.clone()),
                502,
            )
            .unwrap();
        let mut different_evidence = restored_evidence;
        different_evidence.digest = "e".repeat(64);
        assert_eq!(
            restored_store
                .begin_install_attempt_restore(&restored_identity, &different_evidence, 503)
                .unwrap_err()
                .code(),
            "UPDATE_INSTALL_ATTEMPT_WEB_STATE_REJECTED"
        );
    }

    #[test]
    fn native_rollback_must_be_confirmed_before_web_ack() {
        let root = TestDirectory::new("native-first");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (identity, evidence) = prepared(&store);
        store.mark_rollback_required(&identity, 300).unwrap();

        assert_eq!(
            store
                .acknowledge_rollback(&identity, &RollbackAcknowledgement::Restored(evidence), 301,)
                .unwrap_err()
                .code(),
            "UPDATE_NATIVE_ROLLBACK_REQUIRED"
        );
        assert!(root.0.join(WEB_QUIESCENCE_FILE_NAME).exists());
        assert!(root.0.join(PLAYBACK_EXIT_CHECKPOINT_FILE_NAME).exists());
    }

    #[test]
    fn acknowledged_rollback_crash_point_finishes_cleanup_idempotently_on_reconcile() {
        let root = TestDirectory::new("ack-crash");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (identity, evidence) = prepared(&store);
        store.mark_rollback_required(&identity, 300).unwrap();
        store.confirm_native_rollback(&identity, 301).unwrap();

        let directory = StableDirectory::open_existing(&root.0).unwrap().unwrap();
        let mut record = load_record(&directory).unwrap().unwrap();
        record.rollback_acknowledged = true;
        record.updated_at = 302;
        save_document(
            &directory,
            WEB_QUIESCENCE_FILE_NAME,
            &record,
            MAX_WEB_QUIESCENCE_BYTES,
        )
        .unwrap();
        assert_eq!(record_evidence(&record), Some(evidence));

        assert_eq!(
            store.reconcile_web(303).unwrap(),
            WebQuiescenceReconciliation::CompletedRecovered(identity)
        );
        assert!(!root.0.join(WEB_QUIESCENCE_FILE_NAME).exists());
        assert!(!root.0.join(PLAYBACK_EXIT_CHECKPOINT_FILE_NAME).exists());
    }

    #[test]
    fn tombstone_before_cleanup_recovers_after_crash_and_preserves_exact_retry() {
        let root = TestDirectory::new("tombstone-crash");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (identity, evidence) = prepared(&store);
        store.mark_rollback_required(&identity, 300).unwrap();
        store.confirm_native_rollback(&identity, 301).unwrap();
        let acknowledgement = RollbackAcknowledgement::Restored(evidence);

        let directory = StableDirectory::open_existing(&root.0).unwrap().unwrap();
        let mut record = load_record(&directory).unwrap().unwrap();
        record.rollback_acknowledged = true;
        record.updated_at = 302;
        save_document(
            &directory,
            WEB_QUIESCENCE_FILE_NAME,
            &record,
            MAX_WEB_QUIESCENCE_BYTES,
        )
        .unwrap();
        assert!(
            !persist_completion_tombstone(&directory, &record, &acknowledgement, 302,).unwrap()
        );
        drop(directory);
        drop(store);

        let restarted = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        assert_eq!(
            restarted.reconcile_web(303).unwrap(),
            WebQuiescenceReconciliation::CompletedRecovered(identity.clone())
        );
        assert!(!root.0.join(WEB_QUIESCENCE_FILE_NAME).exists());
        assert!(!root.0.join(PLAYBACK_EXIT_CHECKPOINT_FILE_NAME).exists());
        assert_eq!(
            restarted
                .acknowledge_rollback(&identity, &acknowledgement, 304)
                .unwrap(),
            RollbackAcknowledgementOutcome::AlreadyCompleted
        );
    }

    #[test]
    fn conflicting_completion_for_the_active_operation_fails_closed() {
        let root = TestDirectory::new("tombstone-conflict");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (identity, _) = prepared(&store);
        store.mark_rollback_required(&identity, 300).unwrap();
        store.confirm_native_rollback(&identity, 301).unwrap();

        let directory = StableDirectory::open_existing(&root.0).unwrap().unwrap();
        let mut record = load_record(&directory).unwrap().unwrap();
        record.rollback_acknowledged = true;
        record.updated_at = 302;
        save_document(
            &directory,
            WEB_QUIESCENCE_FILE_NAME,
            &record,
            MAX_WEB_QUIESCENCE_BYTES,
        )
        .unwrap();
        let conflict = completion_from_acknowledgement(
            &identity,
            &RollbackAcknowledgement::NoOpNotPrepared,
            302,
        );
        save_document(
            &directory,
            WEB_QUIESCENCE_COMPLETION_FILE_NAME,
            &conflict,
            MAX_WEB_QUIESCENCE_BYTES,
        )
        .unwrap();
        drop(directory);

        assert_eq!(
            store.reconcile_web(303).unwrap_err().code(),
            "UPDATE_WEB_QUIESCENCE_COMPLETION_CONFLICT"
        );
        assert!(root.0.join(WEB_QUIESCENCE_FILE_NAME).exists());
        assert!(root.0.join(PLAYBACK_EXIT_CHECKPOINT_FILE_NAME).exists());
    }

    #[test]
    fn noncanonical_unknown_or_oversized_documents_fail_closed() {
        let root = TestDirectory::new("strict-files");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (_, _identity) = begin(&store);
        let path = root.0.join(WEB_QUIESCENCE_FILE_NAME);
        let canonical = fs::read_to_string(&path).unwrap();
        fs::write(&path, format!("  {canonical}")).unwrap();
        assert_eq!(
            store.reconcile_web(200).unwrap_err().code(),
            "UPDATE_WEB_QUIESCENCE_NONCANONICAL"
        );

        let mut value: serde_json::Value = serde_json::from_str(canonical.trim()).unwrap();
        value["unknown"] = serde_json::json!(true);
        fs::write(
            &path,
            format!("{}\n", serde_json::to_string(&value).unwrap()),
        )
        .unwrap();
        assert_eq!(
            store.reconcile_web(201).unwrap_err().code(),
            "UPDATE_WEB_QUIESCENCE_INVALID_JSON"
        );

        fs::write(&path, vec![b'x'; MAX_WEB_QUIESCENCE_BYTES as usize + 1]).unwrap();
        assert_eq!(
            store.reconcile_web(202).unwrap_err().code(),
            "UPDATE_WEB_QUIESCENCE_SIZE_REJECTED"
        );
    }

    #[test]
    fn queue_limit_and_exact_candidate_identity_are_enforced() {
        let root = TestDirectory::new("bounds-identity");
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);
        let (_, identity) = begin(&store);
        let mut value = checkpoint(&identity.operation_id);
        value.queue = vec![value.queue[0].clone(); MAX_CHECKPOINT_QUEUE + 1];
        assert_eq!(
            store
                .persist_checkpoint(&identity, &value)
                .unwrap_err()
                .code(),
            "UPDATE_PLAYBACK_CHECKPOINT_INVALID"
        );

        let forged = WebQuiescenceIdentity {
            operation_id: identity.operation_id,
            operation_generation: identity.operation_generation,
            candidate_id: "c".repeat(64),
        };
        assert_eq!(
            store
                .mark_rollback_required(&forged, 200)
                .unwrap_err()
                .code(),
            "UPDATE_WEB_QUIESCENCE_STALE_IDENTITY"
        );
    }

    #[test]
    fn orphan_checkpoint_blocks_new_prepare_and_reconciliation() {
        let root = TestDirectory::new("orphan");
        let directory = StableDirectory::open_existing(&root.0).unwrap().unwrap();
        let operation_id = "d".repeat(32);
        save_document(
            &directory,
            PLAYBACK_EXIT_CHECKPOINT_FILE_NAME,
            &checkpoint(&operation_id),
            MAX_PLAYBACK_CHECKPOINT_BYTES,
        )
        .unwrap();
        let store = NativeWebQuiescenceStore::with_updater_directory(&root.0);

        assert_eq!(
            store
                .begin_prepare(&candidate_id(), 100)
                .unwrap_err()
                .code(),
            "UPDATE_PLAYBACK_CHECKPOINT_ORPHANED"
        );
        assert_eq!(
            store.reconcile_web(100).unwrap_err().code(),
            "UPDATE_PLAYBACK_CHECKPOINT_ORPHANED"
        );
    }
}
