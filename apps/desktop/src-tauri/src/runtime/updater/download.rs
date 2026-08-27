use std::{
    ffi::OsStr,
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use reqwest::header;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use super::{
    cache::{
        commit_downloaded_candidate, discard_verified_cache, persist_pending_quarantine,
        PendingQuarantineRejection, AUTH_REJECTED_PART_FILE_NAME,
    },
    github_source::{
        build_hardened_github_client, is_retryable_reqwest_error, validate_installer_request_url,
        validate_release_redirect_url, MAX_REDIRECTS,
    },
    managed_fs::StableDirectory,
    provenance::{InstallerVerificationMaterial, ReleaseCandidateId, VerifiedReleaseEvidence},
};

pub(crate) const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;
pub(crate) const PUBLIC_PROGRESS_INTERVAL_MS: u64 = 100;
const MAX_AUTOMATIC_RETRIES: usize = 2;
const INSTALLER_REVALIDATION_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InstallerDownloadFailureStage {
    Download,
    Verify,
    Cache,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstallerDownloadError {
    stage: InstallerDownloadFailureStage,
    code: &'static str,
    retryable: bool,
    authenticity_failure: bool,
    cancelled: bool,
    message: &'static str,
    pending_rejection: Option<Box<PendingQuarantineRejection>>,
}

impl InstallerDownloadError {
    fn new(
        stage: InstallerDownloadFailureStage,
        code: &'static str,
        retryable: bool,
        message: &'static str,
    ) -> Self {
        Self {
            stage,
            code,
            retryable,
            authenticity_failure: false,
            cancelled: false,
            message,
            pending_rejection: None,
        }
    }

    fn authenticity(code: &'static str, message: &'static str) -> Self {
        Self {
            stage: InstallerDownloadFailureStage::Verify,
            code,
            retryable: false,
            authenticity_failure: true,
            cancelled: false,
            message,
            pending_rejection: None,
        }
    }

    pub(crate) fn cancelled() -> Self {
        Self {
            stage: InstallerDownloadFailureStage::Download,
            code: "UPDATE_DOWNLOAD_CANCELLED",
            retryable: false,
            authenticity_failure: false,
            cancelled: true,
            message: "更新下载已取消",
            pending_rejection: None,
        }
    }

    pub(crate) fn stale() -> Self {
        Self::new(
            InstallerDownloadFailureStage::Download,
            "UPDATE_DOWNLOAD_STALE_OPERATION",
            false,
            "更新下载 operation 已失去 authority",
        )
    }

    pub(crate) fn policy_failure(code: &'static str) -> Self {
        Self::new(
            InstallerDownloadFailureStage::Cache,
            code,
            false,
            "无法持久化本机更新策略",
        )
    }

    pub(crate) fn stage(&self) -> InstallerDownloadFailureStage {
        self.stage
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }

    pub(crate) fn retryable(&self) -> bool {
        self.retryable
    }

    pub(crate) fn is_authenticity_failure(&self) -> bool {
        self.authenticity_failure
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled
    }

    pub(crate) fn message(&self) -> &'static str {
        self.message
    }

    pub(crate) fn pending_rejection(&self) -> Option<&PendingQuarantineRejection> {
        self.pending_rejection.as_deref()
    }

    pub(crate) fn with_pending_rejection(mut self, pending: PendingQuarantineRejection) -> Self {
        self.pending_rejection = Some(Box::new(pending));
        self
    }

    fn with_cleanup_failure(mut self) -> Self {
        self.retryable = false;
        self.message = "更新安装包验证失败，且未完成文件无法清理";
        self
    }

    #[cfg(test)]
    pub(crate) fn fake_authenticity_failure() -> Self {
        Self::authenticity("UPDATE_INSTALLER_SIGNATURE_REJECTED", "测试安装包验签失败")
    }

    #[cfg(test)]
    pub(crate) fn fake_network_failure() -> Self {
        Self::new(
            InstallerDownloadFailureStage::Download,
            "UPDATE_DOWNLOAD_NETWORK",
            true,
            "测试网络失败",
        )
    }
}

#[derive(Debug, Clone)]
pub(crate) struct VerifiedInstallerPlan {
    candidate_id: ReleaseCandidateId,
    asset_url: String,
    evidence: VerifiedReleaseEvidence,
}

impl VerifiedInstallerPlan {
    pub(super) fn new(
        candidate_id: ReleaseCandidateId,
        asset_url: String,
        evidence: VerifiedReleaseEvidence,
    ) -> Self {
        Self {
            candidate_id,
            asset_url,
            evidence,
        }
    }

    pub(crate) fn candidate_id(&self) -> &ReleaseCandidateId {
        &self.candidate_id
    }

    pub(crate) fn version(&self) -> &str {
        self.evidence.version()
    }
}

#[derive(Debug)]
struct VerifiedInstallerAuthority {
    _directory: Arc<StableDirectory>,
    _file: std::fs::File,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerifiedInstallerIdentity {
    candidate_id: ReleaseCandidateId,
    version: String,
    provenance_sha256: String,
    metadata_digest: String,
    installer_sha256: String,
    installer_size: u64,
}

impl VerifiedInstallerIdentity {
    fn from_verified_measurement(
        evidence: &VerifiedReleaseEvidence,
        metadata_digest: String,
        installer_size: u64,
        installer_sha256: String,
    ) -> Self {
        Self {
            candidate_id: evidence.candidate_id().clone(),
            version: evidence.version().to_owned(),
            provenance_sha256: evidence.provenance_sha256().to_owned(),
            metadata_digest,
            installer_sha256,
            installer_size,
        }
    }

    #[cfg(test)]
    fn fake(candidate_id: ReleaseCandidateId) -> Self {
        Self {
            candidate_id,
            version: "1.2.3".into(),
            provenance_sha256: "9e0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c"
                .into(),
            metadata_digest: "8e0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c"
                .into(),
            installer_sha256: "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c"
                .into(),
            installer_size: 9,
        }
    }

    pub(crate) fn candidate_id(&self) -> &ReleaseCandidateId {
        &self.candidate_id
    }

    pub(crate) fn version(&self) -> &str {
        &self.version
    }

    pub(crate) fn provenance_sha256(&self) -> &str {
        &self.provenance_sha256
    }

    pub(crate) fn metadata_digest(&self) -> &str {
        &self.metadata_digest
    }

    pub(crate) fn installer_sha256(&self) -> &str {
        &self.installer_sha256
    }

    pub(crate) fn installer_size(&self) -> u64 {
        self.installer_size
    }
}

#[derive(Debug, Clone)]
pub(crate) struct VerifiedInstallerArtifact {
    identity: VerifiedInstallerIdentity,
    path: PathBuf,
    updater_directory: Option<PathBuf>,
    authority: Option<Arc<Mutex<Option<VerifiedInstallerAuthority>>>>,
}

impl VerifiedInstallerArtifact {
    pub(crate) fn identity(&self) -> &VerifiedInstallerIdentity {
        &self.identity
    }

    pub(crate) fn candidate_id(&self) -> &ReleaseCandidateId {
        self.identity.candidate_id()
    }

    pub(crate) fn discard(&self) -> Result<(), InstallerDownloadError> {
        self.release_authority();
        if let Some(updater_directory) = self.updater_directory.as_ref() {
            return discard_verified_cache(updater_directory).map_err(|error| {
                InstallerDownloadError::new(
                    InstallerDownloadFailureStage::Cache,
                    error.code,
                    false,
                    error.message,
                )
            });
        }
        cleanup_regular_file_sync(&self.path).map_err(|_| {
            InstallerDownloadError::new(
                InstallerDownloadFailureStage::Cache,
                "UPDATE_VERIFIED_ARTIFACT_CLEANUP_FAILED",
                false,
                "无法清理已验证的旧更新安装包",
            )
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn size(&self) -> u64 {
        self.identity.installer_size()
    }

    pub(crate) fn sha256(&self) -> &str {
        self.identity.installer_sha256()
    }

    pub(crate) fn from_recovered(
        evidence: &VerifiedReleaseEvidence,
        metadata_digest: String,
        path: PathBuf,
        installer_size: u64,
        installer_sha256: String,
        directory: Arc<StableDirectory>,
        file: std::fs::File,
    ) -> Self {
        let updater_directory = path.parent().and_then(Path::parent).map(Path::to_path_buf);
        Self {
            identity: VerifiedInstallerIdentity::from_verified_measurement(
                evidence,
                metadata_digest,
                installer_size,
                installer_sha256,
            ),
            path,
            updater_directory,
            authority: Some(Arc::new(Mutex::new(Some(VerifiedInstallerAuthority {
                _directory: directory,
                _file: file,
            })))),
        }
    }

    #[cfg(test)]
    pub(crate) fn fake(candidate_id: ReleaseCandidateId) -> Self {
        Self::fake_at(candidate_id, PathBuf::from("verified-installer.exe"))
    }

    #[cfg(test)]
    pub(crate) fn fake_at(candidate_id: ReleaseCandidateId, path: PathBuf) -> Self {
        Self {
            identity: VerifiedInstallerIdentity::fake(candidate_id),
            path,
            updater_directory: None,
            authority: None,
        }
    }

    fn release_authority(&self) {
        if let Some(authority) = self.authority.as_ref() {
            authority
                .lock()
                .expect("verified installer authority poisoned")
                .take();
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum InstallerDownloadEvent {
    Opened {
        total_bytes: Option<u64>,
        elapsed_ms: u64,
    },
    Progress {
        received_bytes: u64,
        total_bytes: Option<u64>,
        elapsed_ms: u64,
    },
    Retrying {
        attempt: usize,
        elapsed_ms: u64,
    },
    Verifying {
        received_bytes: u64,
        total_bytes: Option<u64>,
    },
}

pub(crate) trait InstallerDownloadEvents: Send + Sync {
    fn emit(&self, event: InstallerDownloadEvent) -> bool;
}

pub(crate) trait InstallerDownloader: Send + Sync {
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
    >;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstallerTransportError {
    pub(crate) retryable: bool,
}

impl InstallerTransportError {
    #[cfg(test)]
    fn retryable() -> Self {
        Self { retryable: true }
    }
}

pub(crate) trait InstallerBody: Send {
    fn next_chunk(&mut self) -> InstallerChunkFuture<'_>;
}

pub(crate) type InstallerChunkFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Option<Vec<u8>>, InstallerTransportError>> + Send + 'a>>;

pub(crate) struct InstallerHttpResponse {
    pub(crate) status: u16,
    pub(crate) location: Option<String>,
    pub(crate) content_length: Option<u64>,
    pub(crate) body: Box<dyn InstallerBody>,
}

pub(crate) trait InstallerHttpTransport: Send + Sync {
    fn get(
        &self,
        url: &str,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<InstallerHttpResponse, InstallerTransportError>> + Send + '_,
        >,
    >;
}

pub(crate) trait DiskSpaceProbe: Send + Sync {
    fn available_bytes(&self, directory: &Path) -> io::Result<u64>;
}

#[derive(Default)]
pub(crate) struct SystemDiskSpaceProbe;

impl DiskSpaceProbe for SystemDiskSpaceProbe {
    fn available_bytes(&self, directory: &Path) -> io::Result<u64> {
        available_disk_space(directory)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct UpdateArtifactStore {
    updater_directory: PathBuf,
    cache_directory: PathBuf,
    part_path: PathBuf,
    installer_path: PathBuf,
}

#[derive(Debug)]
struct UpdateArtifactLease {
    updater: Arc<StableDirectory>,
    cache: Arc<StableDirectory>,
}

impl UpdateArtifactStore {
    pub(crate) fn new(updater_directory: impl Into<PathBuf>) -> Self {
        let updater_directory = updater_directory.into();
        let cache_directory = updater_directory.join("cache-v1");
        Self {
            updater_directory,
            part_path: cache_directory.join("installer.part"),
            installer_path: cache_directory.join("installer.exe"),
            cache_directory,
        }
    }

    async fn prepare(&self) -> Result<Arc<UpdateArtifactLease>, InstallerDownloadError> {
        let updater =
            StableDirectory::open_or_create(&self.updater_directory).map_err(map_cache_io_error)?;
        reject_existing_managed_leaf(
            &updater,
            "cache-delete-v1.json",
            "UPDATE_CACHE_CLEANUP_BLOCKED",
        )?;
        reject_existing_managed_leaf(
            &updater,
            "quarantine-pending-v1.json",
            "UPDATE_QUARANTINE_FINALIZATION_REQUIRED",
        )?;
        reject_existing_managed_leaf(
            &updater,
            "quarantine-pending-v1.json.tmp",
            "UPDATE_QUARANTINE_JOURNAL_REJECTED",
        )?;
        reject_existing_managed_leaf(
            &updater,
            "install-attempt-v1.json",
            "UPDATE_INSTALL_RECONCILIATION_REQUIRED",
        )?;
        let cache =
            StableDirectory::open_or_create(&self.cache_directory).map_err(map_cache_io_error)?;
        let lease = Arc::new(UpdateArtifactLease {
            updater: Arc::new(updater),
            cache: Arc::new(cache),
        });
        reject_existing_managed_leaf(
            &lease.cache,
            AUTH_REJECTED_PART_FILE_NAME,
            "UPDATE_QUARANTINE_FINALIZATION_REQUIRED",
        )?;
        self.cleanup_stale_part_entries(&lease)?;
        reject_existing_managed_leaf(
            &lease.cache,
            "candidate.json",
            "UPDATE_VERIFIED_METADATA_EXISTS",
        )?;
        reject_existing_managed_leaf(
            &lease.cache,
            "candidate.json.tmp",
            "UPDATE_VERIFIED_METADATA_TEMP_EXISTS",
        )?;
        reject_existing_managed_leaf(
            &lease.cache,
            "installer.exe",
            "UPDATE_VERIFIED_ARTIFACT_EXISTS",
        )?;
        Ok(lease)
    }

    fn cleanup_stale_part_entries(
        &self,
        lease: &UpdateArtifactLease,
    ) -> Result<(), InstallerDownloadError> {
        for name in lease.cache.entry_names().map_err(map_cache_io_error)? {
            let Some(name) = name.to_str() else {
                self.persist_cleanup_tombstone(&lease.updater)?;
                return Err(InstallerDownloadError::new(
                    InstallerDownloadFailureStage::Cache,
                    "UPDATE_CACHE_UNKNOWN_ENTRY",
                    false,
                    "更新缓存包含未知条目",
                ));
            };
            if matches!(
                name,
                "candidate.json" | "candidate.json.tmp" | "installer.exe"
            ) {
                continue;
            }
            if name == "installer.part" {
                return Err(InstallerDownloadError::new(
                    InstallerDownloadFailureStage::Cache,
                    "UPDATE_DOWNLOAD_PART_EXISTS",
                    false,
                    "更新下载残片已存在",
                ));
            }
            if !name.starts_with(".installer.part.delete-") {
                self.persist_cleanup_tombstone(&lease.updater)?;
                return Err(InstallerDownloadError::new(
                    InstallerDownloadFailureStage::Cache,
                    "UPDATE_CACHE_UNKNOWN_ENTRY",
                    false,
                    "更新缓存包含未知条目",
                ));
            }
            self.persist_cleanup_tombstone(&lease.updater)?;
            return Err(InstallerDownloadError::new(
                InstallerDownloadFailureStage::Cache,
                "UPDATE_CACHE_CLEANUP_BLOCKED",
                false,
                "更新下载残片需要在启动恢复时清理",
            ));
        }
        Ok(())
    }

    fn persist_cleanup_tombstone(
        &self,
        updater: &StableDirectory,
    ) -> Result<(), InstallerDownloadError> {
        use std::io::Write as _;

        match updater.open_regular_read(OsStr::new("cache-delete-v1.json")) {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => {}
            Err(error) => return Err(map_cache_io_error(error)),
        }
        let mut file = updater
            .create_new_renameable(OsStr::new("cache-delete-v1.json"))
            .map_err(map_cache_io_error)?;
        file.write_all(b"{\"schemaVersion\":1}\n")
            .map_err(map_cache_io_error)?;
        file.sync_all().map_err(map_cache_io_error)
    }

    fn clear_cleanup_tombstone(
        &self,
        updater: &StableDirectory,
    ) -> Result<(), InstallerDownloadError> {
        if updater
            .remove_regular(OsStr::new("cache-delete-v1.json"))
            .map_err(map_cache_io_error)?
        {
            Ok(())
        } else {
            Err(InstallerDownloadError::new(
                InstallerDownloadFailureStage::Cache,
                "UPDATE_CACHE_CLEANUP_FAILED",
                false,
                "更新缓存清理凭据意外消失",
            ))
        }
    }

    fn persist_auth_rejected_marker(
        &self,
        cache: &StableDirectory,
    ) -> Result<(), InstallerDownloadError> {
        use std::io::Write as _;

        match cache.open_regular_read(OsStr::new(AUTH_REJECTED_PART_FILE_NAME)) {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => {}
            Err(error) => return Err(map_cache_io_error(error)),
        }
        let mut file = cache
            .create_new_renameable(OsStr::new(AUTH_REJECTED_PART_FILE_NAME))
            .map_err(map_cache_io_error)?;
        file.write_all(b"auth-rejected-v1\n")
            .and_then(|()| file.sync_all())
            .map_err(map_cache_io_error)
    }

    fn create_part(
        &self,
        lease: &Arc<UpdateArtifactLease>,
    ) -> Result<(tokio::fs::File, std::fs::File, PathBuf), InstallerDownloadError> {
        let cleanup_path = self.new_cleanup_path(lease)?;
        reject_existing_managed_leaf(
            &lease.cache,
            "installer.part",
            "UPDATE_DOWNLOAD_PART_EXISTS",
        )?;
        let file = lease
            .cache
            .create_new_renameable(OsStr::new("installer.part"))
            .map_err(|error| map_download_io_error(error, "UPDATE_DOWNLOAD_PART_CREATE_FAILED"))?;
        let cleanup_handle = match file.try_clone() {
            Ok(handle) => handle,
            Err(error) => {
                let handle_error =
                    map_download_io_error(error, "UPDATE_DOWNLOAD_PART_HANDLE_FAILED");
                self.persist_cleanup_tombstone(&lease.updater)?;
                if cleanup_owned_part_file(&file, &self.part_path, &cleanup_path).is_err() {
                    return Err(InstallerDownloadError::new(
                        InstallerDownloadFailureStage::Cache,
                        "UPDATE_DOWNLOAD_CLEANUP_FAILED",
                        false,
                        "无法清理未完成的更新安装包",
                    ));
                }
                self.clear_cleanup_tombstone(&lease.updater)?;
                return Err(handle_error);
            }
        };
        Ok((
            tokio::fs::File::from_std(file),
            cleanup_handle,
            cleanup_path,
        ))
    }

    fn new_cleanup_path(
        &self,
        lease: &UpdateArtifactLease,
    ) -> Result<PathBuf, InstallerDownloadError> {
        for _ in 0..4 {
            let mut random = [0u8; 16];
            getrandom::fill(&mut random).map_err(|_| {
                InstallerDownloadError::new(
                    InstallerDownloadFailureStage::Cache,
                    "UPDATE_DOWNLOAD_CLEANUP_ID_FAILED",
                    false,
                    "无法创建更新下载清理标识",
                )
            })?;
            let suffix = random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let name = format!(".installer.part.delete-{suffix}");
            match lease.cache.open_regular_read(OsStr::new(&name)) {
                Ok(None) => return Ok(self.cache_directory.join(name)),
                Ok(Some(_)) => continue,
                Err(error) => return Err(map_cache_io_error(error)),
            }
        }
        Err(InstallerDownloadError::new(
            InstallerDownloadFailureStage::Cache,
            "UPDATE_DOWNLOAD_CLEANUP_ID_COLLISION",
            false,
            "无法分配更新下载清理标识",
        ))
    }

    fn publish_verified(
        &self,
        lease: &UpdateArtifactLease,
        file: &tokio::fs::File,
    ) -> Result<(), InstallerDownloadError> {
        if self.part_path.parent() != self.installer_path.parent() {
            return Err(InstallerDownloadError::new(
                InstallerDownloadFailureStage::Cache,
                "UPDATE_DOWNLOAD_PUBLISH_REJECTED",
                false,
                "更新安装包不在同一缓存目录",
            ));
        }
        reject_existing_managed_leaf(
            &lease.cache,
            "installer.exe",
            "UPDATE_VERIFIED_ARTIFACT_EXISTS",
        )?;
        publish_without_replace(file, &self.part_path, &self.installer_path).map_err(|_| {
            InstallerDownloadError::new(
                InstallerDownloadFailureStage::Cache,
                "UPDATE_DOWNLOAD_PUBLISH_FAILED",
                false,
                "无法原子发布已验证的更新安装包",
            )
        })
    }
}

pub(crate) struct StreamingInstallerDownloader {
    transport: Arc<dyn InstallerHttpTransport>,
    artifact_store: UpdateArtifactStore,
    disk_space: Arc<dyn DiskSpaceProbe>,
    maximum_bytes: u64,
    maximum_automatic_retries: usize,
}

struct VerificationStreamContext<'a> {
    material: &'a InstallerVerificationMaterial,
    cancellation: CancellationToken,
    events: &'a dyn InstallerDownloadEvents,
    total_bytes: Option<u64>,
    operation_started_at: Instant,
}

impl StreamingInstallerDownloader {
    pub(crate) fn new(
        updater_directory: impl Into<PathBuf>,
    ) -> Result<Self, InstallerDownloadError> {
        Ok(Self {
            transport: Arc::new(ReqwestInstallerHttpTransport::new()?),
            artifact_store: UpdateArtifactStore::new(updater_directory),
            disk_space: Arc::new(SystemDiskSpaceProbe),
            maximum_bytes: MAX_INSTALLER_BYTES,
            maximum_automatic_retries: MAX_AUTOMATIC_RETRIES,
        })
    }

    #[cfg(feature = "updater-smoke")]
    pub(crate) fn with_staged_transport(
        updater_directory: impl Into<PathBuf>,
        transport: Arc<dyn InstallerHttpTransport>,
    ) -> Self {
        Self {
            transport,
            artifact_store: UpdateArtifactStore::new(updater_directory),
            disk_space: Arc::new(SystemDiskSpaceProbe),
            maximum_bytes: MAX_INSTALLER_BYTES,
            maximum_automatic_retries: 0,
        }
    }

    #[cfg(test)]
    fn with_dependencies(
        transport: Arc<dyn InstallerHttpTransport>,
        artifact_store: UpdateArtifactStore,
        disk_space: Arc<dyn DiskSpaceProbe>,
    ) -> Self {
        Self {
            transport,
            artifact_store,
            disk_space,
            maximum_bytes: MAX_INSTALLER_BYTES,
            maximum_automatic_retries: MAX_AUTOMATIC_RETRIES,
        }
    }

    async fn download(
        &self,
        plan: VerifiedInstallerPlan,
        cancellation: CancellationToken,
        events: &dyn InstallerDownloadEvents,
    ) -> Result<VerifiedInstallerArtifact, InstallerDownloadError> {
        let result = self.download_inner(&plan, cancellation, events).await;
        match result {
            Err(error)
                if error.is_authenticity_failure() && error.pending_rejection().is_none() =>
            {
                Err(self.persist_authenticity_rejection(&plan, error)?)
            }
            result => result,
        }
    }

    async fn download_inner(
        &self,
        plan: &VerifiedInstallerPlan,
        cancellation: CancellationToken,
        events: &dyn InstallerDownloadEvents,
    ) -> Result<VerifiedInstallerArtifact, InstallerDownloadError> {
        let material = plan
            .evidence
            .installer_verification_material()
            .map_err(|_| {
                InstallerDownloadError::authenticity(
                    "UPDATE_INSTALLER_SIGNATURE_REJECTED",
                    "更新安装包签名材料无效",
                )
            })?;
        if material.expected_size == 0 || material.expected_size > self.maximum_bytes {
            return Err(InstallerDownloadError::authenticity(
                "UPDATE_INSTALLER_SIZE_REJECTED",
                "更新安装包声明大小超过安全上限",
            ));
        }
        let artifact_lease = self.artifact_store.prepare().await?;
        let available = self
            .disk_space
            .available_bytes(&self.artifact_store.cache_directory)
            .map_err(map_cache_io_error)?;
        if available < material.expected_size {
            return Err(InstallerDownloadError::new(
                InstallerDownloadFailureStage::Cache,
                "UPDATE_DOWNLOAD_DISK_FULL",
                false,
                "磁盘空间不足，无法下载更新",
            ));
        }

        let operation_started_at = Instant::now();
        for attempt in 0..=self.maximum_automatic_retries {
            if cancellation.is_cancelled() {
                return Err(InstallerDownloadError::cancelled());
            }
            if attempt > 0
                && !events.emit(InstallerDownloadEvent::Retrying {
                    attempt: attempt + 1,
                    elapsed_ms: elapsed_millis(operation_started_at),
                })
            {
                return Err(InstallerDownloadError::stale());
            }
            match self
                .download_once(
                    plan,
                    &material,
                    artifact_lease.clone(),
                    cancellation.clone(),
                    events,
                    operation_started_at,
                )
                .await
            {
                Err(error) if error.retryable && attempt < self.maximum_automatic_retries => {
                    continue;
                }
                result => return result,
            }
        }
        unreachable!("有界重试循环必须返回结果")
    }

    fn persist_authenticity_rejection(
        &self,
        plan: &VerifiedInstallerPlan,
        error: InstallerDownloadError,
    ) -> Result<InstallerDownloadError, InstallerDownloadError> {
        let pending = persist_pending_quarantine(
            &self.artifact_store.updater_directory,
            plan.candidate_id().as_str(),
            plan.version(),
            error.code(),
        )
        .map_err(|journal_error| {
            InstallerDownloadError::new(
                InstallerDownloadFailureStage::Cache,
                journal_error.code,
                false,
                journal_error.message,
            )
        })?;
        Ok(error.with_pending_rejection(pending))
    }

    async fn download_once(
        &self,
        plan: &VerifiedInstallerPlan,
        material: &InstallerVerificationMaterial,
        artifact_lease: Arc<UpdateArtifactLease>,
        cancellation: CancellationToken,
        events: &dyn InstallerDownloadEvents,
        operation_started_at: Instant,
    ) -> Result<VerifiedInstallerArtifact, InstallerDownloadError> {
        let response = self
            .open_response(&plan.asset_url, cancellation.clone())
            .await?;
        if let Some(length) = response.content_length {
            if length > self.maximum_bytes {
                return Err(InstallerDownloadError::new(
                    InstallerDownloadFailureStage::Download,
                    "UPDATE_DOWNLOAD_TOO_LARGE",
                    false,
                    "更新安装包超过 512 MiB 安全上限",
                ));
            }
            if length != material.expected_size {
                return Err(InstallerDownloadError::authenticity(
                    "UPDATE_INSTALLER_SIZE_MISMATCH",
                    "更新安装包大小与签名 provenance 不一致",
                ));
            }
        }
        if !events.emit(InstallerDownloadEvent::Opened {
            total_bytes: response.content_length,
            elapsed_ms: elapsed_millis(operation_started_at),
        }) {
            return Err(InstallerDownloadError::stale());
        }

        let (mut file, cleanup_handle, cleanup_path) =
            self.artifact_store.create_part(&artifact_lease)?;
        let guard = PartFileGuard::armed(
            self.artifact_store.clone(),
            artifact_lease.clone(),
            cleanup_handle,
            cleanup_path,
        );
        let result = self
            .stream_and_verify(
                response.body,
                &mut file,
                VerificationStreamContext {
                    material,
                    cancellation,
                    events,
                    total_bytes: response.content_length,
                    operation_started_at,
                },
            )
            .await;

        let measurement = match result {
            Ok(measurement) => measurement,
            Err(error) => {
                close_download_file(file).await;
                if error.is_authenticity_failure() && error.pending_rejection().is_none() {
                    // 先把失败 part 原子改名为 durable 证据，再尝试写 exact journal。
                    // 即使 journal 因磁盘或冲突失败，重启也只会 fail closed，不会把它
                    // 当普通中断残片删除。
                    let marker_result = guard.mark_auth_rejected();
                    return match self.persist_authenticity_rejection(plan, error) {
                        Ok(error) => Err(error),
                        Err(journal_error) => match marker_result {
                            Ok(()) => Err(journal_error),
                            Err(marker_error) => Err(marker_error),
                        },
                    };
                }
                return match guard.cleanup() {
                    Ok(()) => Err(error),
                    Err(_cleanup_error) if error.is_authenticity_failure() => {
                        Err(error.with_cleanup_failure())
                    }
                    Err(cleanup_error) => Err(cleanup_error),
                };
            }
        };
        if let Err(error) = self.artifact_store.publish_verified(&artifact_lease, &file) {
            close_download_file(file).await;
            guard.cleanup()?;
            return Err(error);
        }
        close_download_file(file).await;
        guard.disarm();

        // 发布只是把同一个已写入的 handle 原子改名；在 metadata 获得安装权限前，
        // 必须从受管目录重新打开最终 leaf，并对这个最终 handle 做完整复验。
        let (verified_file, published_measurement) = match self
            .revalidate_published_installer(&artifact_lease.cache, material)
            .await
        {
            Ok(result) => result,
            Err(mut error) => {
                if error.is_authenticity_failure() && error.pending_rejection().is_none() {
                    let marker_result = self
                        .artifact_store
                        .persist_auth_rejected_marker(&artifact_lease.cache);
                    error = match self.persist_authenticity_rejection(plan, error) {
                        Ok(error) => error,
                        Err(journal_error) => {
                            marker_result?;
                            return Err(journal_error);
                        }
                    };
                    // rejection journal 已 durable；由 Runtime 先保存 policy，再 finalize 清理。
                    return Err(error);
                }
                discard_verified_cache(&self.artifact_store.updater_directory).map_err(
                    |cleanup_error| {
                        InstallerDownloadError::new(
                            InstallerDownloadFailureStage::Cache,
                            cleanup_error.code,
                            false,
                            cleanup_error.message,
                        )
                    },
                )?;
                return Err(error);
            }
        };
        if measurement.size != published_measurement.size
            || measurement.sha256 != published_measurement.sha256
        {
            let marker_result = self
                .artifact_store
                .persist_auth_rejected_marker(&artifact_lease.cache);
            let journal_result = self.persist_authenticity_rejection(
                plan,
                InstallerDownloadError::authenticity(
                    "UPDATE_INSTALLER_PUBLISH_REVALIDATION_REJECTED",
                    "更新安装包发布后复验不一致",
                ),
            );
            return match journal_result {
                Ok(error) => Err(error),
                Err(journal_error) => match marker_result {
                    Ok(()) => Err(journal_error),
                    Err(marker_error) => Err(marker_error),
                },
            };
        }

        let verified_at = unix_timestamp_millis()?;
        let metadata_digest = match commit_downloaded_candidate(
            &self.artifact_store.updater_directory,
            &plan.evidence,
            published_measurement.size,
            &published_measurement.sha256,
            verified_at,
            verified_at,
        )
        .await
        {
            Ok(metadata_digest) => metadata_digest,
            Err(error) => {
                drop(verified_file);
                discard_verified_cache(&self.artifact_store.updater_directory).map_err(|_| {
                    InstallerDownloadError::new(
                        InstallerDownloadFailureStage::Cache,
                        "UPDATE_CACHE_COMMIT_CLEANUP_FAILED",
                        false,
                        "更新缓存 metadata 提交失败，且安装包无法清理",
                    )
                })?;
                return Err(InstallerDownloadError::new(
                    InstallerDownloadFailureStage::Cache,
                    error.code,
                    false,
                    error.message,
                ));
            }
        };
        let artifact = VerifiedInstallerArtifact {
            identity: VerifiedInstallerIdentity::from_verified_measurement(
                &plan.evidence,
                metadata_digest,
                published_measurement.size,
                published_measurement.sha256,
            ),
            path: self.artifact_store.installer_path.clone(),
            updater_directory: Some(self.artifact_store.updater_directory.clone()),
            authority: Some(Arc::new(Mutex::new(Some(VerifiedInstallerAuthority {
                _directory: artifact_lease.cache.clone(),
                _file: verified_file,
            })))),
        };

        Ok(artifact)
    }

    async fn revalidate_published_installer(
        &self,
        cache: &StableDirectory,
        material: &InstallerVerificationMaterial,
    ) -> Result<(std::fs::File, InstallerMeasurement), InstallerDownloadError> {
        let installer = cache
            .open_regular_read(OsStr::new("installer.exe"))
            .map_err(map_cache_io_error)?
            .ok_or_else(|| {
                InstallerDownloadError::new(
                    InstallerDownloadFailureStage::Cache,
                    "UPDATE_INSTALLER_PUBLISHED_FILE_MISSING",
                    false,
                    "已发布的更新安装包意外消失",
                )
            })?;
        let mut file = tokio::fs::File::from_std(installer);
        let mut minisign = material
            .public_key
            .verify_stream(&material.signature)
            .map_err(|_| {
                InstallerDownloadError::authenticity(
                    "UPDATE_INSTALLER_SIGNATURE_REJECTED",
                    "更新安装包签名材料无效",
                )
            })?;
        let mut sha256 = Sha256::new();
        let mut size = 0u64;
        let mut buffer = vec![0u8; INSTALLER_REVALIDATION_CHUNK_BYTES];
        loop {
            let read = file.read(&mut buffer).await.map_err(|_| {
                InstallerDownloadError::new(
                    InstallerDownloadFailureStage::Cache,
                    "UPDATE_INSTALLER_REVALIDATION_READ_FAILED",
                    false,
                    "无法复验已发布的更新安装包",
                )
            })?;
            if read == 0 {
                break;
            }
            size = size.checked_add(read as u64).ok_or_else(|| {
                InstallerDownloadError::authenticity(
                    "UPDATE_INSTALLER_SIZE_MISMATCH",
                    "更新安装包大小与签名 provenance 不一致",
                )
            })?;
            if size > self.maximum_bytes || size > material.expected_size {
                return Err(InstallerDownloadError::authenticity(
                    "UPDATE_INSTALLER_SIZE_MISMATCH",
                    "更新安装包大小与签名 provenance 不一致",
                ));
            }
            sha256.update(&buffer[..read]);
            minisign.update(&buffer[..read]);
        }
        let digest = format!("{:x}", sha256.finalize());
        if size != material.expected_size || digest != material.expected_sha256 {
            return Err(InstallerDownloadError::authenticity(
                "UPDATE_INSTALLER_MEASUREMENT_REJECTED",
                "更新安装包与签名 provenance 不一致",
            ));
        }
        minisign.finalize().map_err(|_| {
            InstallerDownloadError::authenticity(
                "UPDATE_INSTALLER_SIGNATURE_REJECTED",
                "更新安装包 Minisign 验证失败",
            )
        })?;
        Ok((
            file.into_std().await,
            InstallerMeasurement {
                size,
                sha256: digest,
            },
        ))
    }

    async fn stream_and_verify(
        &self,
        mut body: Box<dyn InstallerBody>,
        file: &mut tokio::fs::File,
        context: VerificationStreamContext<'_>,
    ) -> Result<InstallerMeasurement, InstallerDownloadError> {
        let VerificationStreamContext {
            material,
            cancellation,
            events,
            total_bytes,
            operation_started_at,
        } = context;
        let mut sha256 = Sha256::new();
        let mut minisign = material
            .public_key
            .verify_stream(&material.signature)
            .map_err(|_| {
                InstallerDownloadError::authenticity(
                    "UPDATE_INSTALLER_SIGNATURE_REJECTED",
                    "更新安装包签名材料无效",
                )
            })?;
        let mut received = 0u64;
        let mut progress_deadline = next_progress_deadline(operation_started_at);

        loop {
            let chunk = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(InstallerDownloadError::cancelled()),
                _ = tokio::time::sleep_until(progress_deadline) => {
                    if !events.emit(InstallerDownloadEvent::Progress {
                        received_bytes: received,
                        total_bytes,
                        elapsed_ms: elapsed_millis(operation_started_at),
                    }) {
                        return Err(InstallerDownloadError::stale());
                    }
                    progress_deadline = next_progress_deadline(operation_started_at);
                    continue;
                }
                chunk = body.next_chunk() => chunk.map_err(map_transport_error)?,
            };
            let Some(chunk) = chunk else {
                break;
            };
            if chunk.is_empty() {
                continue;
            }
            let next_received = received.checked_add(chunk.len() as u64).ok_or_else(|| {
                InstallerDownloadError::new(
                    InstallerDownloadFailureStage::Download,
                    "UPDATE_DOWNLOAD_TOO_LARGE",
                    false,
                    "更新安装包超过 512 MiB 安全上限",
                )
            })?;
            if next_received > self.maximum_bytes {
                return Err(InstallerDownloadError::new(
                    InstallerDownloadFailureStage::Download,
                    "UPDATE_DOWNLOAD_TOO_LARGE",
                    false,
                    "更新安装包超过 512 MiB 安全上限",
                ));
            }
            if next_received > material.expected_size {
                return Err(InstallerDownloadError::authenticity(
                    "UPDATE_INSTALLER_SIZE_MISMATCH",
                    "更新安装包大小与签名 provenance 不一致",
                ));
            }
            file.write_all(&chunk)
                .await
                .map_err(|error| map_download_io_error(error, "UPDATE_DOWNLOAD_WRITE_FAILED"))?;
            sha256.update(&chunk);
            minisign.update(&chunk);
            received = next_received;
            progress_deadline = next_progress_deadline(operation_started_at);
        }

        file.flush()
            .await
            .map_err(|error| map_download_io_error(error, "UPDATE_DOWNLOAD_FLUSH_FAILED"))?;
        if cancellation.is_cancelled() {
            return Err(InstallerDownloadError::cancelled());
        }
        file.sync_all()
            .await
            .map_err(|error| map_download_io_error(error, "UPDATE_DOWNLOAD_SYNC_FAILED"))?;
        if cancellation.is_cancelled() {
            return Err(InstallerDownloadError::cancelled());
        }
        if !events.emit(InstallerDownloadEvent::Verifying {
            received_bytes: received,
            total_bytes,
        }) {
            return Err(InstallerDownloadError::stale());
        }
        if cancellation.is_cancelled() {
            return Err(InstallerDownloadError::cancelled());
        }

        let sha256 = format!("{:x}", sha256.finalize());
        if received != material.expected_size || sha256 != material.expected_sha256 {
            return Err(InstallerDownloadError::authenticity(
                "UPDATE_INSTALLER_MEASUREMENT_REJECTED",
                "更新安装包与签名 provenance 不一致",
            ));
        }
        minisign.finalize().map_err(|_| {
            InstallerDownloadError::authenticity(
                "UPDATE_INSTALLER_SIGNATURE_REJECTED",
                "更新安装包 Minisign 验证失败",
            )
        })?;
        if cancellation.is_cancelled() {
            return Err(InstallerDownloadError::cancelled());
        }

        Ok(InstallerMeasurement {
            size: received,
            sha256,
        })
    }

    async fn open_response(
        &self,
        initial_url: &str,
        cancellation: CancellationToken,
    ) -> Result<InstallerHttpResponse, InstallerDownloadError> {
        let mut current_url = validate_installer_request_url(initial_url)
            .map_err(|_| policy_error("UPDATE_DOWNLOAD_URL_REJECTED"))?;
        let mut redirect_count = 0usize;

        loop {
            let response = tokio::select! {
                _ = cancellation.cancelled() => return Err(InstallerDownloadError::cancelled()),
                response = self.transport.get(current_url.as_str()) => response.map_err(map_transport_error)?,
            };
            if (300..400).contains(&response.status) {
                if redirect_count >= MAX_REDIRECTS {
                    return Err(policy_error("UPDATE_DOWNLOAD_REDIRECT_REJECTED"));
                }
                let location = response
                    .location
                    .ok_or_else(|| policy_error("UPDATE_DOWNLOAD_REDIRECT_REJECTED"))?;
                let next_url = current_url
                    .join(&location)
                    .map_err(|_| policy_error("UPDATE_DOWNLOAD_REDIRECT_REJECTED"))?;
                current_url = validate_release_redirect_url(next_url.as_str())
                    .map_err(|_| policy_error("UPDATE_DOWNLOAD_REDIRECT_REJECTED"))?;
                redirect_count += 1;
                continue;
            }
            if response.status != 200 {
                return Err(InstallerDownloadError::new(
                    InstallerDownloadFailureStage::Download,
                    "UPDATE_DOWNLOAD_HTTP_STATUS",
                    matches!(response.status, 500..=599),
                    "GitHub 更新安装包请求失败",
                ));
            }
            return Ok(response);
        }
    }
}

impl InstallerDownloader for StreamingInstallerDownloader {
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
        Box::pin(async move { self.download(plan, cancellation, events).await })
    }
}

struct InstallerMeasurement {
    size: u64,
    sha256: String,
}

struct PartFileGuard {
    store: UpdateArtifactStore,
    lease: Arc<UpdateArtifactLease>,
    cleanup_handle: Option<std::fs::File>,
    cleanup_path: PathBuf,
    active: bool,
}

impl PartFileGuard {
    fn armed(
        store: UpdateArtifactStore,
        lease: Arc<UpdateArtifactLease>,
        cleanup_handle: std::fs::File,
        cleanup_path: PathBuf,
    ) -> Self {
        Self {
            store,
            lease,
            cleanup_handle: Some(cleanup_handle),
            cleanup_path,
            active: true,
        }
    }

    fn cleanup(mut self) -> Result<(), InstallerDownloadError> {
        let result = cleanup_owned_part(
            self.cleanup_handle
                .as_ref()
                .expect("active part guard must own a cleanup handle"),
            &self.store,
            &self.lease,
            &self.cleanup_path,
        );
        if result.is_ok() {
            self.active = false;
            self.cleanup_handle = None;
        }
        result
    }

    fn disarm(mut self) {
        self.active = false;
        self.cleanup_handle = None;
    }

    /// Journal 无法落盘时把认证失败的 part 原子改名成不可被普通启动清理吞掉的证据。
    fn mark_auth_rejected(mut self) -> Result<(), InstallerDownloadError> {
        let handle = self
            .cleanup_handle
            .as_ref()
            .expect("active part guard must own a cleanup handle");
        let result = self.lease.cache.publish_without_replace(
            handle,
            OsStr::new("installer.part"),
            OsStr::new(AUTH_REJECTED_PART_FILE_NAME),
        );
        self.active = false;
        self.cleanup_handle = None;
        result.map_err(|_| {
            InstallerDownloadError::new(
                InstallerDownloadFailureStage::Cache,
                "UPDATE_AUTH_REJECTED_MARKER_FAILED",
                false,
                "认证失败证据无法安全标记，已阻止继续更新",
            )
        })
    }
}

impl Drop for PartFileGuard {
    fn drop(&mut self) {
        if self.active {
            if let Some(handle) = self.cleanup_handle.as_ref() {
                let _ = cleanup_owned_part(handle, &self.store, &self.lease, &self.cleanup_path);
            }
        }
    }
}

async fn close_download_file(file: tokio::fs::File) {
    drop(file.into_std().await);
}

struct ReqwestInstallerHttpTransport {
    client: reqwest::Client,
}

impl ReqwestInstallerHttpTransport {
    fn new() -> Result<Self, InstallerDownloadError> {
        let client = build_hardened_github_client(None, Duration::from_secs(30)).map_err(|_| {
            InstallerDownloadError::new(
                InstallerDownloadFailureStage::Download,
                "UPDATE_DOWNLOAD_INIT_FAILED",
                false,
                "更新下载器初始化失败",
            )
        })?;
        Ok(Self { client })
    }
}

impl InstallerHttpTransport for ReqwestInstallerHttpTransport {
    fn get(
        &self,
        url: &str,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<InstallerHttpResponse, InstallerTransportError>> + Send + '_,
        >,
    > {
        let validated = validate_installer_request_url(url);
        Box::pin(async move {
            let url = validated.map_err(|_| InstallerTransportError { retryable: false })?;
            let response = self
                .client
                .get(url)
                .header(header::ACCEPT, "application/octet-stream")
                .header(header::ACCEPT_ENCODING, "identity")
                .send()
                .await
                .map_err(|error| InstallerTransportError {
                    retryable: is_retryable_reqwest_error(&error),
                })?;
            let status = response.status().as_u16();
            let location = if response.status().is_redirection() {
                Some(
                    response
                        .headers()
                        .get(header::LOCATION)
                        .and_then(|value| value.to_str().ok())
                        .ok_or(InstallerTransportError { retryable: false })?
                        .to_owned(),
                )
            } else {
                None
            };
            let content_length = response.content_length();
            Ok(InstallerHttpResponse {
                status,
                location,
                content_length,
                body: Box::new(ReqwestInstallerBody { response }),
            })
        })
    }
}

struct ReqwestInstallerBody {
    response: reqwest::Response,
}

impl InstallerBody for ReqwestInstallerBody {
    fn next_chunk(&mut self) -> InstallerChunkFuture<'_> {
        Box::pin(async move {
            self.response
                .chunk()
                .await
                .map(|chunk| chunk.map(|bytes| bytes.to_vec()))
                .map_err(|error| InstallerTransportError {
                    retryable: is_retryable_reqwest_error(&error),
                })
        })
    }
}

fn map_transport_error(error: InstallerTransportError) -> InstallerDownloadError {
    InstallerDownloadError::new(
        InstallerDownloadFailureStage::Download,
        "UPDATE_DOWNLOAD_NETWORK",
        error.retryable,
        "读取 GitHub 更新安装包失败",
    )
}

fn elapsed_millis(started_at: Instant) -> u64 {
    started_at.elapsed().as_millis().min(u64::MAX as u128) as u64
}

fn unix_timestamp_millis() -> Result<u64, InstallerDownloadError> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| {
            InstallerDownloadError::new(
                InstallerDownloadFailureStage::Cache,
                "UPDATE_CACHE_CLOCK_REJECTED",
                false,
                "系统时间无效，无法提交更新缓存 metadata",
            )
        })?
        .as_millis();
    u64::try_from(millis).map_err(|_| {
        InstallerDownloadError::new(
            InstallerDownloadFailureStage::Cache,
            "UPDATE_CACHE_CLOCK_REJECTED",
            false,
            "系统时间超出更新缓存支持范围",
        )
    })
}

fn next_progress_deadline(operation_started_at: Instant) -> tokio::time::Instant {
    let elapsed = elapsed_millis(operation_started_at);
    let next_boundary = elapsed
        .saturating_div(PUBLIC_PROGRESS_INTERVAL_MS)
        .saturating_add(1)
        .saturating_mul(PUBLIC_PROGRESS_INTERVAL_MS);
    tokio::time::Instant::now()
        + Duration::from_millis(next_boundary.saturating_sub(elapsed).max(1))
}

fn policy_error(code: &'static str) -> InstallerDownloadError {
    InstallerDownloadError::new(
        InstallerDownloadFailureStage::Download,
        code,
        false,
        "GitHub 更新安装包请求不符合安全策略",
    )
}

fn map_cache_io_error(error: io::Error) -> InstallerDownloadError {
    map_download_io_error(error, "UPDATE_DOWNLOAD_CACHE_IO_FAILED")
}

fn map_download_io_error(error: io::Error, code: &'static str) -> InstallerDownloadError {
    let is_disk_full = error.kind() == io::ErrorKind::StorageFull
        || matches!(error.raw_os_error(), Some(39 | 112));
    InstallerDownloadError::new(
        InstallerDownloadFailureStage::Cache,
        if is_disk_full {
            "UPDATE_DOWNLOAD_DISK_FULL"
        } else {
            code
        },
        false,
        if is_disk_full {
            "磁盘空间不足，无法保存更新安装包"
        } else {
            "无法安全写入更新安装包缓存"
        },
    )
}

fn reject_existing_managed_leaf(
    directory: &StableDirectory,
    name: &str,
    code: &'static str,
) -> Result<(), InstallerDownloadError> {
    match directory.open_regular_read(OsStr::new(name)) {
        Ok(Some(_)) => Err(InstallerDownloadError::new(
            InstallerDownloadFailureStage::Cache,
            code,
            false,
            "更新缓存中已存在冲突文件",
        )),
        Ok(None) => Ok(()),
        Err(error) => Err(map_cache_io_error(error)),
    }
}

fn cleanup_regular_file_sync(path: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !is_reparse_point(&metadata) => {
            std::fs::remove_file(path)
        }
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to remove non-regular updater file",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn cleanup_owned_part(
    handle: &std::fs::File,
    store: &UpdateArtifactStore,
    lease: &UpdateArtifactLease,
    cleanup_path: &Path,
) -> Result<(), InstallerDownloadError> {
    store.persist_cleanup_tombstone(&lease.updater)?;
    cleanup_owned_part_file(handle, &store.part_path, cleanup_path).map_err(|_| {
        InstallerDownloadError::new(
            InstallerDownloadFailureStage::Cache,
            "UPDATE_DOWNLOAD_CLEANUP_FAILED",
            false,
            "无法清理未完成的更新安装包",
        )
    })?;
    store.clear_cleanup_tombstone(&lease.updater)
}

#[cfg(windows)]
fn cleanup_owned_part_file(
    handle: &std::fs::File,
    _path: &Path,
    cleanup_path: &Path,
) -> io::Result<()> {
    use std::{mem, os::windows::io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfo, FileDispositionInfoEx, SetFileInformationByHandle,
        FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO,
        FILE_DISPOSITION_INFO_EX,
    };

    let rename_result = rename_file_handle_without_replace(handle.as_raw_handle(), cleanup_path);
    let extended = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    };
    let extended_result = unsafe {
        SetFileInformationByHandle(
            handle.as_raw_handle(),
            FileDispositionInfoEx,
            (&raw const extended).cast(),
            mem::size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    };
    if extended_result != 0 {
        return rename_result;
    }

    let legacy = FILE_DISPOSITION_INFO { DeleteFile: true };
    let legacy_result = unsafe {
        SetFileInformationByHandle(
            handle.as_raw_handle(),
            FileDispositionInfo,
            (&raw const legacy).cast(),
            mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if legacy_result == 0 {
        Err(io::Error::last_os_error())
    } else {
        rename_result
    }
}

#[cfg(not(windows))]
fn cleanup_owned_part_file(
    _handle: &std::fs::File,
    path: &Path,
    _cleanup_path: &Path,
) -> io::Result<()> {
    cleanup_regular_file_sync(path)
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn available_disk_space(directory: &Path) -> io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide = directory
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut available = 0u64;
    let result = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(available)
    }
}

#[cfg(not(windows))]
fn available_disk_space(_directory: &Path) -> io::Result<u64> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "only the Windows NSIS updater is supported",
    ))
}

#[cfg(windows)]
fn publish_without_replace(
    file: &tokio::fs::File,
    _source: &Path,
    destination: &Path,
) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;

    rename_file_handle_without_replace(file.as_raw_handle(), destination)
}

#[cfg(windows)]
fn rename_file_handle_without_replace(
    handle: std::os::windows::io::RawHandle,
    destination: &Path,
) -> io::Result<()> {
    use std::{mem, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FileRenameInfo, SetFileInformationByHandle, FILE_RENAME_INFO,
    };

    let mut destination = destination.as_os_str().encode_wide().collect::<Vec<_>>();
    let name_bytes = destination
        .len()
        .checked_mul(mem::size_of::<u16>())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "installer path too long"))?;
    destination.push(0);
    let allocated_name_bytes = destination
        .len()
        .checked_mul(mem::size_of::<u16>())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "installer path too long"))?;
    let buffer_bytes = mem::offset_of!(FILE_RENAME_INFO, FileName)
        .checked_add(allocated_name_bytes)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "installer path too long"))?;
    let word_count = buffer_bytes.div_ceil(mem::size_of::<usize>());
    let mut buffer = vec![0usize; word_count];
    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*info).Anonymous.ReplaceIfExists = false;
        (*info).RootDirectory = std::ptr::null_mut();
        (*info).FileNameLength = u32::try_from(name_bytes)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "installer path too long"))?;
        std::ptr::copy_nonoverlapping(
            destination.as_ptr(),
            buffer
                .as_mut_ptr()
                .cast::<u8>()
                .add(mem::offset_of!(FILE_RENAME_INFO, FileName))
                .cast::<u16>(),
            destination.len(),
        );
    }
    let result = unsafe {
        SetFileInformationByHandle(
            handle,
            FileRenameInfo,
            buffer.as_ptr().cast(),
            u32::try_from(buffer_bytes).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "installer path too long")
            })?,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn publish_without_replace(
    _file: &tokio::fs::File,
    source: &Path,
    destination: &Path,
) -> io::Result<()> {
    if destination.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "verified installer already exists",
        ));
    }
    std::fs::rename(source, destination)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Mutex,
        },
    };

    use serde::Deserialize;

    use super::*;
    use crate::runtime::updater::{
        cache::{CacheRecoveryOutcome, VerifiedCacheStore},
        provenance::{ProvenanceVerificationInput, ProvenanceVerifier},
    };

    const RAW_PROVENANCE: &[u8] = include_bytes!("fixtures/provenance-v2.json");
    const CONTRACT_JSON: &str = include_str!("fixtures/provenance-v2-contract.json");

    #[derive(Deserialize)]
    struct ContractFixture {
        encoded_public_key: String,
        provenance_signature: String,
        installer_signature: String,
    }

    fn verified_plan() -> VerifiedInstallerPlan {
        let contract: ContractFixture =
            serde_json::from_str(CONTRACT_JSON).expect("共享 provenance contract 应有效");
        let verifier = ProvenanceVerifier::from_tauri_pubkey(&contract.encoded_public_key)
            .expect("fixture 公钥应有效");
        let evidence = verifier
            .verify(ProvenanceVerificationInput {
                raw_provenance: RAW_PROVENANCE,
                provenance_signature: &contract.provenance_signature,
                installer_signature: &contract.installer_signature,
                expected_repository: "zzstar101/Mineradio-Tauri",
                expected_tag: "v1.2.3",
                expected_version: "1.2.3",
                expected_commit_sha: "0123456789abcdef0123456789abcdef01234567",
                expected_target: "windows-x86_64-nsis",
            })
            .expect("fixture provenance 应有效");
        VerifiedInstallerPlan::new(
            evidence.candidate_id().clone(),
            "https://github.com/zzstar101/Mineradio-Tauri/releases/download/v1.2.3/MineRadio-Tauri_1.2.3_x64-setup.exe".into(),
            evidence,
        )
    }

    fn encoded_public_key() -> String {
        serde_json::from_str::<ContractFixture>(CONTRACT_JSON)
            .expect("共享 provenance contract 应有效")
            .encoded_public_key
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce).expect("测试目录应取得系统随机标识");
            let suffix = nonce
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let path = std::env::temp_dir().join(format!("mineradio-updater-download-{suffix}"));
            std::fs::create_dir(&path).expect("测试目录应以跨进程唯一身份创建");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct FixedDiskSpace(u64);

    impl DiskSpaceProbe for FixedDiskSpace {
        fn available_bytes(&self, _directory: &Path) -> io::Result<u64> {
            Ok(self.0)
        }
    }

    #[derive(Default)]
    struct RecordingEvents {
        values: Mutex<Vec<InstallerDownloadEvent>>,
    }

    impl InstallerDownloadEvents for RecordingEvents {
        fn emit(&self, event: InstallerDownloadEvent) -> bool {
            self.values
                .lock()
                .expect("event recorder poisoned")
                .push(event);
            true
        }
    }

    struct MemoryBody {
        chunks: VecDeque<Result<Vec<u8>, InstallerTransportError>>,
    }

    impl InstallerBody for MemoryBody {
        fn next_chunk(&mut self) -> InstallerChunkFuture<'_> {
            let value = self.chunks.pop_front().transpose();
            Box::pin(async move { value })
        }
    }

    struct PendingBody;

    impl InstallerBody for PendingBody {
        fn next_chunk(&mut self) -> InstallerChunkFuture<'_> {
            Box::pin(std::future::pending())
        }
    }

    struct NotifyingPendingBody {
        entered: Arc<tokio::sync::Notify>,
    }

    impl InstallerBody for NotifyingPendingBody {
        fn next_chunk(&mut self) -> InstallerChunkFuture<'_> {
            let entered = self.entered.clone();
            Box::pin(async move {
                entered.notify_one();
                std::future::pending().await
            })
        }
    }

    struct JournalConflictBody {
        updater_directory: PathBuf,
        emitted: bool,
    }

    impl InstallerBody for JournalConflictBody {
        fn next_chunk(&mut self) -> InstallerChunkFuture<'_> {
            if self.emitted {
                return Box::pin(async { Ok(None) });
            }
            self.emitted = true;
            std::fs::write(
                self.updater_directory
                    .join("quarantine-pending-v1.json.tmp"),
                b"not-a-valid-journal",
            )
            .expect("测试应能在 prepare 后注入 journal 冲突");
            Box::pin(async { Ok(Some(b"installeX".to_vec())) })
        }
    }

    struct MemoryTransport {
        responses: Mutex<VecDeque<Result<InstallerHttpResponse, InstallerTransportError>>>,
        calls: AtomicUsize,
    }

    impl MemoryTransport {
        fn new(responses: Vec<InstallerHttpResponse>) -> Self {
            Self::with_results(responses.into_iter().map(Ok))
        }

        fn with_results(
            responses: impl IntoIterator<Item = Result<InstallerHttpResponse, InstallerTransportError>>,
        ) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().collect()),
                calls: AtomicUsize::new(0),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::Acquire)
        }
    }

    impl InstallerHttpTransport for MemoryTransport {
        fn get(
            &self,
            _url: &str,
        ) -> Pin<
            Box<
                dyn Future<Output = Result<InstallerHttpResponse, InstallerTransportError>>
                    + Send
                    + '_,
            >,
        > {
            self.calls.fetch_add(1, Ordering::AcqRel);
            let response = self
                .responses
                .lock()
                .expect("memory transport poisoned")
                .pop_front()
                .unwrap_or(Err(InstallerTransportError { retryable: false }));
            Box::pin(async move { response })
        }
    }

    fn response(
        content_length: Option<u64>,
        chunks: impl IntoIterator<Item = Result<Vec<u8>, InstallerTransportError>>,
    ) -> InstallerHttpResponse {
        InstallerHttpResponse {
            status: 200,
            location: None,
            content_length,
            body: Box::new(MemoryBody {
                chunks: chunks.into_iter().collect(),
            }),
        }
    }

    fn status_response(status: u16) -> InstallerHttpResponse {
        InstallerHttpResponse {
            status,
            location: None,
            content_length: None,
            body: Box::new(MemoryBody {
                chunks: VecDeque::new(),
            }),
        }
    }

    fn downloader(
        root: &TestDirectory,
        transport: Arc<dyn InstallerHttpTransport>,
        available: u64,
    ) -> StreamingInstallerDownloader {
        StreamingInstallerDownloader::with_dependencies(
            transport,
            UpdateArtifactStore::new(&root.0),
            Arc::new(FixedDiskSpace(available)),
        )
    }

    #[test]
    fn signed_fixture_is_streamed_to_a_verified_artifact() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let transport = Arc::new(MemoryTransport::new(vec![response(
                Some(9),
                [
                    Ok(b"ins".to_vec()),
                    Ok(b"tall".to_vec()),
                    Ok(b"er".to_vec()),
                ],
            )]));
            let events = RecordingEvents::default();
            let artifact = downloader(&root, transport.clone(), 9)
                .run(verified_plan(), CancellationToken::new(), &events)
                .await
                .expect("真实共享签名 fixture 应通过流式验签");

            assert_eq!(std::fs::read(artifact.path()).unwrap(), b"installer");
            assert!(!root.0.join("cache-v1/installer.part").exists());
            assert_eq!(transport.calls(), 1);
            assert!(events
                .values
                .lock()
                .unwrap()
                .iter()
                .any(|event| matches!(event, InstallerDownloadEvent::Verifying { .. })));
            let fresh_identity = artifact.identity().clone();
            let recovered = VerifiedCacheStore::new(&root.0, encoded_public_key())
                .unwrap()
                .recover("0.1.0")
                .await;
            let CacheRecoveryOutcome::Recovered(recovered) = recovered else {
                panic!("fresh cache 应恢复为同一个已验证 artifact identity: {recovered:?}");
            };
            assert_eq!(recovered.artifact.identity(), &fresh_identity);
            drop(recovered);
            artifact
                .discard()
                .expect("verified artifact discard 应撤销完整 cache pair");
            assert!(std::fs::read_dir(root.0.join("cache-v1"))
                .unwrap()
                .next()
                .is_none());
        });
    }

    #[cfg(windows)]
    #[test]
    fn downloaded_artifact_clones_share_one_locked_authority_until_discard() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let transport = Arc::new(MemoryTransport::new(vec![response(
                Some(9),
                [Ok(b"installer".to_vec())],
            )]));
            let artifact = downloader(&root, transport, 9)
                .run(
                    verified_plan(),
                    CancellationToken::new(),
                    &RecordingEvents::default(),
                )
                .await
                .unwrap();
            let clone = artifact.clone();
            let path = artifact.path().to_path_buf();
            assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());
            drop(artifact);
            assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());

            clone.discard().unwrap();
            assert!(!path.exists());
        });
    }

    #[test]
    fn missing_content_length_is_bounded_by_signed_size_and_runtime_counter() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let transport = Arc::new(MemoryTransport::new(vec![response(
                None,
                [Ok(b"installer".to_vec())],
            )]));
            downloader(&root, transport, 9)
                .run(
                    verified_plan(),
                    CancellationToken::new(),
                    &RecordingEvents::default(),
                )
                .await
                .expect("缺失 Content-Length 时仍应受签名大小约束并成功");

            let overflow_root = TestDirectory::new();
            let overflow_transport = Arc::new(MemoryTransport::new(vec![response(
                None,
                [Ok(b"installer!".to_vec())],
            )]));
            let error = downloader(&overflow_root, overflow_transport, 10)
                .run(
                    verified_plan(),
                    CancellationToken::new(),
                    &RecordingEvents::default(),
                )
                .await
                .expect_err("运行时超过签名大小必须失败");
            assert_eq!(error.code(), "UPDATE_INSTALLER_SIZE_MISMATCH");
            assert!(error.is_authenticity_failure());
            assert!(!overflow_root.0.join("cache-v1/installer.part").exists());
            assert!(!overflow_root.0.join("cache-v1/installer.exe").exists());
        });
    }

    #[test]
    fn retryable_stream_failure_restarts_from_zero_but_authenticity_failure_does_not_retry() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let transport = Arc::new(MemoryTransport::new(vec![
                response(
                    Some(9),
                    [
                        Ok(b"ins".to_vec()),
                        Err(InstallerTransportError::retryable()),
                    ],
                ),
                response(Some(9), [Ok(b"installer".to_vec())]),
            ]));
            downloader(&root, transport.clone(), 9)
                .run(
                    verified_plan(),
                    CancellationToken::new(),
                    &RecordingEvents::default(),
                )
                .await
                .expect("瞬态读取错误应从零重试");
            assert_eq!(transport.calls(), 2);
            assert_eq!(
                std::fs::read(root.0.join("cache-v1/installer.exe")).unwrap(),
                b"installer"
            );

            let tampered_root = TestDirectory::new();
            let tampered_transport = Arc::new(MemoryTransport::new(vec![response(
                Some(9),
                [Ok(b"installeX".to_vec())],
            )]));
            let error = downloader(&tampered_root, tampered_transport.clone(), 9)
                .run(
                    verified_plan(),
                    CancellationToken::new(),
                    &RecordingEvents::default(),
                )
                .await
                .expect_err("篡改安装包必须失败");
            assert!(error.is_authenticity_failure());
            let pending = error
                .pending_rejection()
                .expect("真实流式 authenticity failure 必须携带 durable journal authority");
            assert_eq!(
                pending.rejected().candidate_id,
                verified_plan().candidate_id().as_str()
            );
            assert_eq!(pending.rejected().version, "1.2.3");
            assert!(tampered_root.0.join("quarantine-pending-v1.json").is_file());
            assert_eq!(tampered_transport.calls(), 1);
            assert!(!tampered_root.0.join("cache-v1/installer.part").exists());
        });
    }

    #[test]
    fn insufficient_disk_space_fails_before_network() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let transport = Arc::new(MemoryTransport::new(vec![response(
                Some(9),
                [Ok(b"installer".to_vec())],
            )]));
            let error = downloader(&root, transport.clone(), 8)
                .run(
                    verified_plan(),
                    CancellationToken::new(),
                    &RecordingEvents::default(),
                )
                .await
                .expect_err("磁盘空间不足必须在网络请求前失败");
            assert_eq!(error.code(), "UPDATE_DOWNLOAD_DISK_FULL");
            assert_eq!(transport.calls(), 0);
        });
    }

    #[test]
    fn journal_failure_marks_rejected_part_and_restart_never_deletes_it_as_a_remnant() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let transport = Arc::new(MemoryTransport::new(vec![InstallerHttpResponse {
                status: 200,
                location: None,
                content_length: Some(9),
                body: Box::new(JournalConflictBody {
                    updater_directory: root.0.clone(),
                    emitted: false,
                }),
            }]));
            let error = downloader(&root, transport, 9)
                .run(
                    verified_plan(),
                    CancellationToken::new(),
                    &RecordingEvents::default(),
                )
                .await
                .expect_err("journal 冲突必须阻止认证失败事务");
            assert_eq!(error.code(), "UPDATE_QUARANTINE_JOURNAL_REJECTED");
            let marker = root.0.join("cache-v1").join(AUTH_REJECTED_PART_FILE_NAME);
            assert!(marker.is_file());
            assert!(!root.0.join("cache-v1/installer.part").exists());

            // 即使导致 journal 失败的外部冲突随后消失，marker 仍使启动恢复 fail closed。
            std::fs::remove_file(root.0.join("quarantine-pending-v1.json.tmp")).unwrap();
            let recovery = VerifiedCacheStore::new(&root.0, encoded_public_key()).unwrap();
            let outcome = recovery.recover("0.1.0").await;
            let CacheRecoveryOutcome::Blocked(fault) = outcome else {
                panic!("无 journal 的认证失败 marker 必须阻断普通残片清理: {outcome:?}");
            };
            assert_eq!(fault.code, "UPDATE_QUARANTINE_JOURNAL_REJECTED");
            assert!(marker.is_file());
        });
    }

    #[test]
    fn cancellation_interrupts_a_waiting_chunk_and_removes_the_part_file() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let entered = Arc::new(tokio::sync::Notify::new());
            let transport = Arc::new(MemoryTransport::new(vec![InstallerHttpResponse {
                status: 200,
                location: None,
                content_length: Some(9),
                body: Box::new(NotifyingPendingBody {
                    entered: entered.clone(),
                }),
            }]));
            let downloader = Arc::new(downloader(&root, transport, 9));
            let cancellation = CancellationToken::new();
            let task_cancellation = cancellation.clone();
            let events = Arc::new(RecordingEvents::default());
            let task_events = events.clone();
            let task_downloader = downloader.clone();
            let task = tauri::async_runtime::spawn(async move {
                task_downloader
                    .run(verified_plan(), task_cancellation, task_events.as_ref())
                    .await
            });

            tokio::time::timeout(Duration::from_secs(1), entered.notified())
                .await
                .expect("下载 body 应在时限内开始读取");
            cancellation.cancel();
            let error = task
                .await
                .unwrap()
                .expect_err("取消必须终止等待中的 stream");
            assert!(error.is_cancelled());
            assert!(!root.0.join("cache-v1/installer.part").exists());
            assert!(!root.0.join("cache-v1/installer.exe").exists());
        });
    }

    #[test]
    fn stalled_stream_flushes_the_latest_progress_within_the_public_interval() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let transport = Arc::new(MemoryTransport::new(vec![InstallerHttpResponse {
                status: 200,
                location: None,
                content_length: Some(9),
                body: Box::new(PendingBody),
            }]));
            let downloader = Arc::new(downloader(&root, transport, 9));
            let cancellation = CancellationToken::new();
            let task_cancellation = cancellation.clone();
            let events = Arc::new(RecordingEvents::default());
            let task_events = events.clone();
            let task_downloader = downloader.clone();
            let task = tauri::async_runtime::spawn(async move {
                task_downloader
                    .run(verified_plan(), task_cancellation, task_events.as_ref())
                    .await
            });

            // 有界轮询等待进度事件：固定 sleep 在并行测试负载下会被调度抖动
            // 击穿（任务尚未开始读取就已超时），这里放宽为最长 5s 的轮询窗口，
            // 语义不变——停滞流必须在其公开间隔内刷出最新进度。
            let deadline = tokio::time::Instant::now()
                + Duration::from_millis(PUBLIC_PROGRESS_INTERVAL_MS * 20);
            loop {
                if events.values.lock().unwrap().iter().any(|event| {
                    matches!(
                        event,
                        InstallerDownloadEvent::Progress {
                            received_bytes: 0,
                            total_bytes: Some(9),
                            ..
                        }
                    )
                }) {
                    break;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "停滞流未在公开间隔内刷出最新进度",
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }

            cancellation.cancel();
            assert!(task.await.unwrap().unwrap_err().is_cancelled());
            assert!(!root.0.join("cache-v1/installer.part").exists());
        });
    }

    #[test]
    fn aborting_the_download_future_releases_the_file_and_removes_the_part() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let entered = Arc::new(tokio::sync::Notify::new());
            let transport = Arc::new(MemoryTransport::new(vec![InstallerHttpResponse {
                status: 200,
                location: None,
                content_length: Some(9),
                body: Box::new(NotifyingPendingBody {
                    entered: entered.clone(),
                }),
            }]));
            let downloader = Arc::new(downloader(&root, transport, 9));
            let events = Arc::new(RecordingEvents::default());
            let task_downloader = downloader.clone();
            let task_events = events.clone();
            let task = tauri::async_runtime::spawn(async move {
                task_downloader
                    .run(
                        verified_plan(),
                        CancellationToken::new(),
                        task_events.as_ref(),
                    )
                    .await
            });

            tokio::time::timeout(Duration::from_secs(1), entered.notified())
                .await
                .expect("下载 body 应在时限内开始读取");
            assert!(root.0.join("cache-v1/installer.part").exists());
            task.abort();
            let _ = task.await;

            assert!(!root.0.join("cache-v1/installer.part").exists());
            assert!(!root.0.join("cache-v1/installer.exe").exists());
        });
    }

    #[test]
    fn existing_part_file_is_never_claimed_or_deleted() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let cache = root.0.join("cache-v1");
            std::fs::create_dir_all(&cache).unwrap();
            let part = cache.join("installer.part");
            std::fs::write(&part, b"foreign-part").unwrap();
            let transport = Arc::new(MemoryTransport::new(vec![response(
                Some(9),
                [Ok(b"installer".to_vec())],
            )]));

            let error = downloader(&root, transport, 9)
                .run(
                    verified_plan(),
                    CancellationToken::new(),
                    &RecordingEvents::default(),
                )
                .await
                .expect_err("既有 part 文件不得被当前 operation 接管");

            assert_eq!(error.code(), "UPDATE_DOWNLOAD_PART_EXISTS");
            assert_eq!(std::fs::read(part).unwrap(), b"foreign-part");
        });
    }

    #[test]
    fn accepted_background_write_cannot_block_identity_cleanup_or_a_fresh_part() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let store = UpdateArtifactStore::new(&root.0);
            let lease = store.prepare().await.unwrap();
            let (mut writer, cleanup_handle, cleanup_path) = store.create_part(&lease).unwrap();
            let part = root.0.join("cache-v1/installer.part");
            assert!(part.exists());
            writer.write_all(b"installer").await.unwrap();

            PartFileGuard::armed(store.clone(), lease.clone(), cleanup_handle, cleanup_path)
                .cleanup()
                .expect("owned part 应能按句柄标记删除");
            assert!(!part.exists());

            let (second_writer, second_cleanup_handle, second_cleanup_path) = store
                .create_part(&lease)
                .expect("下一次下载应能立即取得 fresh part");
            PartFileGuard::armed(store, lease, second_cleanup_handle, second_cleanup_path)
                .cleanup()
                .expect("fresh part 也应能按句柄清理");
            assert!(!part.exists());

            close_download_file(writer).await;
            close_download_file(second_writer).await;
            assert!(std::fs::read_dir(root.0.join("cache-v1"))
                .unwrap()
                .next()
                .is_none());
        });
    }

    #[test]
    fn declared_size_is_rejected_before_creating_a_part_file() {
        tauri::async_runtime::block_on(async {
            for (length, expected_code, authenticity) in [
                (MAX_INSTALLER_BYTES + 1, "UPDATE_DOWNLOAD_TOO_LARGE", false),
                (10, "UPDATE_INSTALLER_SIZE_MISMATCH", true),
            ] {
                let root = TestDirectory::new();
                let transport = Arc::new(MemoryTransport::new(vec![response(
                    Some(length),
                    [Ok(b"installer".to_vec())],
                )]));
                let error = downloader(&root, transport, 9)
                    .run(
                        verified_plan(),
                        CancellationToken::new(),
                        &RecordingEvents::default(),
                    )
                    .await
                    .expect_err("不可信 Content-Length 必须在写文件前失败");

                assert_eq!(error.code(), expected_code);
                assert_eq!(error.is_authenticity_failure(), authenticity);
                assert!(!root.0.join("cache-v1/installer.part").exists());
            }
        });
    }

    #[test]
    fn only_server_failures_retry_and_the_budget_is_bounded() {
        tauri::async_runtime::block_on(async {
            let retry_root = TestDirectory::new();
            let retry_transport = Arc::new(MemoryTransport::new(vec![
                status_response(503),
                status_response(503),
                status_response(503),
            ]));
            let retry_error = downloader(&retry_root, retry_transport.clone(), 9)
                .run(
                    verified_plan(),
                    CancellationToken::new(),
                    &RecordingEvents::default(),
                )
                .await
                .expect_err("5xx 超过重试预算后必须失败");
            assert_eq!(retry_error.code(), "UPDATE_DOWNLOAD_HTTP_STATUS");
            assert!(retry_error.retryable());
            assert_eq!(retry_transport.calls(), 3);

            let client_root = TestDirectory::new();
            let client_transport = Arc::new(MemoryTransport::new(vec![status_response(404)]));
            let client_error = downloader(&client_root, client_transport.clone(), 9)
                .run(
                    verified_plan(),
                    CancellationToken::new(),
                    &RecordingEvents::default(),
                )
                .await
                .expect_err("4xx 不得自动重试");
            assert_eq!(client_error.code(), "UPDATE_DOWNLOAD_HTTP_STATUS");
            assert!(!client_error.retryable());
            assert_eq!(client_transport.calls(), 1);
        });
    }

    #[test]
    fn cleanup_tombstone_blocks_a_new_download_before_network() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            std::fs::write(root.0.join("cache-delete-v1.json"), b"blocked").unwrap();
            let transport = Arc::new(MemoryTransport::new(vec![response(
                Some(9),
                [Ok(b"installer".to_vec())],
            )]));

            let error = downloader(&root, transport.clone(), 9)
                .run(
                    verified_plan(),
                    CancellationToken::new(),
                    &RecordingEvents::default(),
                )
                .await
                .expect_err("cleanup tombstone 存在时不得开始新下载");

            assert_eq!(error.code(), "UPDATE_CACHE_CLEANUP_BLOCKED");
            assert_eq!(transport.calls(), 0);
            assert!(!root.0.join("cache-v1/installer.part").exists());
        });
    }

    #[test]
    fn delete_remnant_writes_tombstone_and_blocks_network_until_startup_recovery() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let cache = root.0.join("cache-v1");
            std::fs::create_dir_all(&cache).unwrap();
            let remnant = cache.join(".installer.part.delete-0123456789abcdef0123456789abcdef");
            std::fs::write(&remnant, b"incomplete").unwrap();
            let transport = Arc::new(MemoryTransport::new(vec![response(
                Some(9),
                [Ok(b"installer".to_vec())],
            )]));

            let error = downloader(&root, transport.clone(), 9)
                .run(
                    verified_plan(),
                    CancellationToken::new(),
                    &RecordingEvents::default(),
                )
                .await
                .expect_err("delete remnant 必须交由下次启动恢复清理");

            assert_eq!(error.code(), "UPDATE_CACHE_CLEANUP_BLOCKED");
            assert_eq!(transport.calls(), 0);
            assert!(remnant.exists());
            assert!(root.0.join("cache-delete-v1.json").exists());
            assert!(!cache.join("installer.part").exists());
        });
    }
}
