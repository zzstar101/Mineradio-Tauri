use std::{
    error::Error as _,
    future::Future,
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs},
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use reqwest::{
    dns::{Addrs, Name, Resolve, Resolving},
    header, redirect,
};
use semver::Version;
use serde::Deserialize;
use url::{Host, Url};

use super::{
    provenance::{is_lower_hex, ProvenanceVerificationInput, ProvenanceVerifier},
    CheckRequest, NormalizedRelease, UpdateSource, UpdateSourceError,
};

pub(crate) const OFFICIAL_REPOSITORY: &str = "zzstar101/Mineradio-Tauri";
pub(crate) const LATEST_MANIFEST_URL: &str =
    "https://github.com/zzstar101/Mineradio-Tauri/releases/latest/download/latest.json";
const RELEASE_TARGET: &str = "windows-x86_64-nsis";
pub(super) const MAX_REDIRECTS: usize = 4;
const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_COMMIT_BYTES: usize = 256 * 1024;
const MAX_PROVENANCE_BYTES: usize = 16 * 1024;
const MAX_SIGNATURE_BYTES: usize = 16 * 1024;
const MAX_NOTE_LINES: usize = 4;
const MAX_NOTE_LINE_CHARS: usize = 256;
const MAX_NOTE_TOTAL_CHARS: usize = 1024;
const RELEASE_ASSET_REDIRECT_HOSTS: &[&str] =
    &["github.com", "release-assets.githubusercontent.com"];
const NETWORK_HOST_ALLOWLIST: &[&str] = &[
    "github.com",
    "api.github.com",
    "release-assets.githubusercontent.com",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReleaseHttpResourceKind {
    Manifest,
    Commit,
    InstallerSignature,
    Provenance,
    ProvenanceSignature,
}

impl ReleaseHttpResourceKind {
    fn initial_host(self) -> &'static str {
        match self {
            Self::Commit => "api.github.com",
            Self::Manifest
            | Self::InstallerSignature
            | Self::Provenance
            | Self::ProvenanceSignature => "github.com",
        }
    }

    fn allows_redirect(self) -> bool {
        self != Self::Commit
    }

    fn allows_transport_host(self, host: &str) -> bool {
        if self == Self::Commit {
            host == "api.github.com"
        } else {
            RELEASE_ASSET_REDIRECT_HOSTS.contains(&host)
        }
    }

    fn maximum_response_bytes(self) -> usize {
        match self {
            Self::Manifest => MAX_MANIFEST_BYTES,
            Self::Commit => MAX_COMMIT_BYTES,
            Self::InstallerSignature | Self::ProvenanceSignature => MAX_SIGNATURE_BYTES,
            Self::Provenance => MAX_PROVENANCE_BYTES,
        }
    }

    fn accept(self) -> &'static str {
        if self == Self::Commit {
            "application/vnd.github+json"
        } else {
            "application/octet-stream"
        }
    }

    fn uses_github_api(self) -> bool {
        self == Self::Commit
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReleaseHttpRequest {
    pub url: String,
    pub kind: ReleaseHttpResourceKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReleaseHttpResponse {
    pub status: u16,
    pub location: Option<String>,
    pub body: Vec<u8>,
}

pub(crate) trait ReleaseHttpTransport: Send + Sync {
    fn get(
        &self,
        request: ReleaseHttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ReleaseHttpResponse, UpdateSourceError>> + Send + '_>>;
}

pub(crate) struct GitHubReleaseSource {
    transport: Arc<dyn ReleaseHttpTransport>,
    verifier: ProvenanceVerifier,
}

impl GitHubReleaseSource {
    pub(crate) fn new(encoded_public_key: &str) -> Result<Self, UpdateSourceError> {
        let transport = Arc::new(ReqwestReleaseHttpTransport::new()?);
        Self::with_transport(encoded_public_key, transport)
    }

    pub(crate) fn with_transport(
        encoded_public_key: &str,
        transport: Arc<dyn ReleaseHttpTransport>,
    ) -> Result<Self, UpdateSourceError> {
        let verifier = ProvenanceVerifier::from_tauri_pubkey(encoded_public_key)
            .map_err(|_| rejected("UPDATE_PROVENANCE_KEY_REJECTED", "配置的 updater 公钥无效"))?;
        Ok(Self {
            transport,
            verifier,
        })
    }

    async fn check_candidate(
        &self,
        request: CheckRequest,
    ) -> Result<Option<NormalizedRelease>, UpdateSourceError> {
        let current_version =
            parse_stable_version(&request.current_version, "UPDATE_CURRENT_VERSION_REJECTED")?;
        let manifest_bytes = self
            .fetch(LATEST_MANIFEST_URL, ReleaseHttpResourceKind::Manifest)
            .await?;
        let manifest: ReleaseManifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|_| rejected("UPDATE_MANIFEST_REJECTED", "latest.json 格式无效"))?;
        let candidate = validate_manifest(manifest, &current_version)?;
        let Some(candidate) = candidate else {
            return Ok(None);
        };

        let installer_signature_url = format!("{}.sig", candidate.installer_url);
        let installer_signature = String::from_utf8(
            self.fetch(
                &installer_signature_url,
                ReleaseHttpResourceKind::InstallerSignature,
            )
            .await?,
        )
        .map_err(|_| {
            rejected(
                "UPDATE_INSTALLER_SIGNATURE_REJECTED",
                "安装包签名资产不是有效 UTF-8",
            )
        })?;
        if installer_signature != candidate.installer_signature {
            return Err(rejected(
                "UPDATE_INSTALLER_SIGNATURE_REJECTED",
                "安装包签名资产与 latest.json 不一致",
            ));
        }

        let commit_url = format!(
            "https://api.github.com/repos/{OFFICIAL_REPOSITORY}/commits/{}",
            candidate.tag
        );
        let commit_bytes = self
            .fetch(&commit_url, ReleaseHttpResourceKind::Commit)
            .await?;
        let commit: GitHubCommit = serde_json::from_slice(&commit_bytes)
            .map_err(|_| rejected("UPDATE_GITHUB_COMMIT_REJECTED", "GitHub commit 响应无效"))?;
        if !is_lower_hex(&commit.sha, 40) {
            return Err(rejected(
                "UPDATE_GITHUB_COMMIT_REJECTED",
                "GitHub commit SHA 必须是 40 位小写十六进制",
            ));
        }

        let provenance_url = format!(
            "https://github.com/{OFFICIAL_REPOSITORY}/releases/download/{}/release-provenance.json",
            candidate.tag
        );
        let provenance_signature_url = format!("{provenance_url}.sig");
        let raw_provenance = self
            .fetch(&provenance_url, ReleaseHttpResourceKind::Provenance)
            .await?;
        let provenance_signature = String::from_utf8(
            self.fetch(
                &provenance_signature_url,
                ReleaseHttpResourceKind::ProvenanceSignature,
            )
            .await?,
        )
        .map_err(|_| rejected("UPDATE_PROVENANCE_REJECTED", "provenance 签名不是 UTF-8"))?;

        let evidence = self
            .verifier
            .verify(ProvenanceVerificationInput {
                raw_provenance: &raw_provenance,
                provenance_signature: &provenance_signature,
                installer_signature: &candidate.installer_signature,
                expected_repository: OFFICIAL_REPOSITORY,
                expected_tag: &candidate.tag,
                expected_version: &candidate.version,
                expected_commit_sha: &commit.sha,
                expected_target: RELEASE_TARGET,
            })
            .map_err(|_| rejected("UPDATE_PROVENANCE_REJECTED", "release provenance 验证失败"))?;

        Ok(Some(NormalizedRelease::from_verified(
            evidence,
            candidate.notes,
            candidate.published_at.as_deref(),
        )))
    }

    async fn fetch(
        &self,
        url: &str,
        kind: ReleaseHttpResourceKind,
    ) -> Result<Vec<u8>, UpdateSourceError> {
        let mut current_url = validate_initial_request_url(url, kind)?;
        let mut redirect_count = 0usize;

        loop {
            let response = self
                .transport
                .get(ReleaseHttpRequest {
                    url: current_url.to_string(),
                    kind,
                })
                .await?;

            if (300..400).contains(&response.status) {
                if !kind.allows_redirect() || redirect_count >= MAX_REDIRECTS {
                    return Err(rejected(
                        "UPDATE_REDIRECT_REJECTED",
                        "GitHub 更新元数据 redirect 次数或类型不受允许",
                    ));
                }
                let location = response.location.ok_or_else(|| {
                    rejected("UPDATE_REDIRECT_REJECTED", "redirect 缺少 Location")
                })?;
                let next_url = current_url.join(&location).map_err(|_| {
                    rejected("UPDATE_REDIRECT_REJECTED", "redirect Location 无法解析")
                })?;
                current_url = validate_release_redirect_url(next_url.as_str())?;
                redirect_count += 1;
                continue;
            }

            if response.status != 200 {
                return Err(UpdateSourceError {
                    code: "UPDATE_SOURCE_HTTP_STATUS".into(),
                    retryable: is_retryable_http_status(response.status),
                    message: format!("GitHub 更新元数据请求返回 HTTP {}", response.status),
                });
            }
            let maximum_bytes = kind.maximum_response_bytes();
            if response.body.len() > maximum_bytes {
                return Err(rejected(
                    "UPDATE_SOURCE_RESPONSE_TOO_LARGE",
                    format!("GitHub 更新元数据超过 {maximum_bytes} 字节上限"),
                ));
            }

            return Ok(response.body);
        }
    }
}

fn is_retryable_http_status(status: u16) -> bool {
    matches!(status, 500..=599)
}

pub(super) fn is_retryable_reqwest_error(error: &reqwest::Error) -> bool {
    if error.is_timeout() {
        return true;
    }

    let mut source = error.source();
    while let Some(current) = source {
        if let Some(io_error) = current.downcast_ref::<io::Error>() {
            if is_retryable_io_error_kind(io_error.kind()) {
                return true;
            }
        }
        source = current.source();
    }
    false
}

fn is_retryable_io_error_kind(kind: io::ErrorKind) -> bool {
    matches!(
        kind,
        io::ErrorKind::TimedOut | io::ErrorKind::ConnectionReset
    )
}

impl UpdateSource for GitHubReleaseSource {
    fn check(
        &self,
        request: CheckRequest,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<NormalizedRelease>, UpdateSourceError>> + Send + '_>,
    > {
        Box::pin(async move { self.check_candidate(request).await })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseManifest {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    pub_date: Option<String>,
    platforms: ManifestPlatforms,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestPlatforms {
    #[serde(rename = "windows-x86_64-nsis")]
    nsis: ManifestPlatform,
    #[serde(rename = "windows-x86_64")]
    windows_compatibility: ManifestPlatform,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestPlatform {
    signature: String,
    url: String,
}

#[derive(Debug, Deserialize)]
struct GitHubCommit {
    sha: String,
}

struct ManifestCandidate {
    version: String,
    tag: String,
    notes: Vec<String>,
    published_at: Option<String>,
    installer_signature: String,
    installer_url: String,
}

fn validate_manifest(
    manifest: ReleaseManifest,
    current_version: &Version,
) -> Result<Option<ManifestCandidate>, UpdateSourceError> {
    let version = parse_stable_version(&manifest.version, "UPDATE_MANIFEST_REJECTED")?;
    if version <= *current_version {
        return Ok(None);
    }
    if manifest.platforms.nsis != manifest.platforms.windows_compatibility {
        return Err(rejected(
            "UPDATE_MANIFEST_REJECTED",
            "latest.json 的 Windows x64 platform entries 必须完全一致",
        ));
    }
    if manifest.platforms.nsis.signature.trim().is_empty() {
        return Err(rejected(
            "UPDATE_MANIFEST_REJECTED",
            "latest.json 的 Windows x64 签名不能为空",
        ));
    }

    let version_text = version.to_string();
    let tag = format!("v{version_text}");
    let installer_name = format!("MineRadio-Tauri_{version_text}_x64-setup.exe");
    let expected_installer_url = format!(
        "https://github.com/{OFFICIAL_REPOSITORY}/releases/download/{tag}/{installer_name}"
    );
    if manifest.platforms.nsis.url != expected_installer_url {
        return Err(rejected(
            "UPDATE_ASSET_POLICY_REJECTED",
            "latest.json 安装包 URL 不是官方 canonical GitHub Release asset",
        ));
    }
    validate_initial_request_url(
        &manifest.platforms.nsis.url,
        ReleaseHttpResourceKind::InstallerSignature,
    )?;

    Ok(Some(ManifestCandidate {
        version: version_text,
        tag,
        notes: sanitize_release_notes(manifest.notes.as_deref().unwrap_or_default()),
        published_at: sanitize_published_at(manifest.pub_date),
        installer_signature: manifest.platforms.nsis.signature,
        installer_url: expected_installer_url,
    }))
}

fn parse_stable_version(raw: &str, code: &'static str) -> Result<Version, UpdateSourceError> {
    let version = Version::parse(raw).map_err(|_| rejected(code, "版本不是严格稳定 SemVer"))?;
    if !version.pre.is_empty() || !version.build.is_empty() || version.to_string() != raw {
        return Err(rejected(code, "版本必须是 canonical 稳定 SemVer"));
    }
    Ok(version)
}

fn sanitize_release_notes(raw: &str) -> Vec<String> {
    let mut total_chars = 0usize;
    let mut lines = Vec::new();

    for source_line in raw.split(is_note_line_separator) {
        if lines.len() >= MAX_NOTE_LINES || total_chars >= MAX_NOTE_TOTAL_CHARS {
            break;
        }
        let remaining = MAX_NOTE_TOTAL_CHARS - total_chars;
        let line_limit = remaining.min(MAX_NOTE_LINE_CHARS);
        let line = source_line
            .chars()
            .filter(|character| !is_disallowed_note_character(*character))
            .take(line_limit)
            .collect::<String>()
            .trim()
            .to_owned();
        if line.is_empty() {
            continue;
        }
        total_chars += line.chars().count();
        lines.push(line);
    }

    lines
}

fn is_note_line_separator(character: char) -> bool {
    matches!(character, '\r' | '\n' | '\u{2028}' | '\u{2029}')
}

fn is_disallowed_note_character(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '\u{061c}'
                | '\u{200e}'
                | '\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2066}'..='\u{2069}'
        )
}

fn sanitize_published_at(value: Option<String>) -> Option<String> {
    value.filter(|candidate| {
        candidate.chars().count() <= 64
            && time::OffsetDateTime::parse(
                candidate,
                &time::format_description::well_known::Rfc3339,
            )
            .is_ok()
    })
}

fn rejected(code: &'static str, message: impl Into<String>) -> UpdateSourceError {
    UpdateSourceError {
        code: code.into(),
        retryable: false,
        message: message.into(),
    }
}

fn validate_initial_request_url(
    raw: &str,
    kind: ReleaseHttpResourceKind,
) -> Result<Url, UpdateSourceError> {
    let url = parse_secure_url(raw, "UPDATE_ASSET_POLICY_REJECTED")?;
    if url.query().is_some() || url.fragment().is_some() {
        return Err(rejected(
            "UPDATE_ASSET_POLICY_REJECTED",
            "GitHub 更新初始 URL 不允许 query 或 fragment",
        ));
    }
    let expected_host = kind.initial_host();
    if url.host_str() != Some(expected_host) {
        return Err(rejected(
            "UPDATE_ASSET_POLICY_REJECTED",
            format!("GitHub 更新初始 URL host 必须为 {expected_host}"),
        ));
    }
    Ok(url)
}

pub(super) fn validate_release_redirect_url(raw: &str) -> Result<Url, UpdateSourceError> {
    let url = parse_secure_url(raw, "UPDATE_REDIRECT_REJECTED")?;
    if url.fragment().is_some()
        || !url
            .host_str()
            .is_some_and(|host| RELEASE_ASSET_REDIRECT_HOSTS.contains(&host))
    {
        return Err(rejected(
            "UPDATE_REDIRECT_REJECTED",
            "redirect host 不在 GitHub Release asset allowlist",
        ));
    }
    Ok(url)
}

fn parse_secure_url(raw: &str, code: &'static str) -> Result<Url, UpdateSourceError> {
    let url = Url::parse(raw).map_err(|_| rejected(code, "URL 无效"))?;
    let host = match url.host() {
        Some(Host::Domain(host)) => host,
        Some(Host::Ipv4(_)) | Some(Host::Ipv6(_)) => {
            return Err(rejected(code, "URL 不允许 IP literal"));
        }
        None => return Err(rejected(code, "URL 缺少 host")),
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || host.eq_ignore_ascii_case("localhost")
    {
        return Err(rejected(
            code,
            "URL 必须是无凭据、无显式端口、非 localhost/IP literal 的 HTTPS URL",
        ));
    }
    Ok(url)
}

fn validate_transport_request_url(
    raw: &str,
    kind: ReleaseHttpResourceKind,
) -> Result<Url, UpdateSourceError> {
    let url = parse_secure_url(raw, "UPDATE_ASSET_POLICY_REJECTED")?;
    let host = url
        .host_str()
        .ok_or_else(|| rejected("UPDATE_ASSET_POLICY_REJECTED", "URL 缺少 host"))?;
    if !kind.allows_transport_host(host) {
        return Err(rejected(
            "UPDATE_ASSET_POLICY_REJECTED",
            "GitHub 更新请求 host 不在固定 allowlist",
        ));
    }
    Ok(url)
}

pub(super) fn validate_installer_request_url(raw: &str) -> Result<Url, UpdateSourceError> {
    let url = parse_secure_url(raw, "UPDATE_ASSET_POLICY_REJECTED")?;
    let host = url
        .host_str()
        .ok_or_else(|| rejected("UPDATE_ASSET_POLICY_REJECTED", "URL 缺少 host"))?;
    if !RELEASE_ASSET_REDIRECT_HOSTS.contains(&host) {
        return Err(rejected(
            "UPDATE_ASSET_POLICY_REJECTED",
            "GitHub 安装包请求 host 不在固定 allowlist",
        ));
    }
    Ok(url)
}

struct ReqwestReleaseHttpTransport {
    client: reqwest::Client,
}

impl ReqwestReleaseHttpTransport {
    fn new() -> Result<Self, UpdateSourceError> {
        let client =
            build_hardened_github_client(Some(Duration::from_secs(20)), Duration::from_secs(20))?;
        Ok(Self { client })
    }

    async fn execute(
        &self,
        request: ReleaseHttpRequest,
    ) -> Result<ReleaseHttpResponse, UpdateSourceError> {
        let url = validate_transport_request_url(&request.url, request.kind)?;
        let mut request_builder = self
            .client
            .get(url)
            .header(header::ACCEPT, request.kind.accept());
        if request.kind.uses_github_api() {
            request_builder = request_builder.header("X-GitHub-Api-Version", "2022-11-28");
        }
        let mut response = request_builder
            .send()
            .await
            .map_err(|error| UpdateSourceError {
                code: "UPDATE_SOURCE_NETWORK".into(),
                retryable: is_retryable_reqwest_error(&error),
                message: "GitHub 更新元数据网络请求失败".into(),
            })?;
        let status = response.status().as_u16();
        let location = if response.status().is_redirection() {
            Some(
                response
                    .headers()
                    .get(header::LOCATION)
                    .ok_or_else(|| rejected("UPDATE_REDIRECT_REJECTED", "redirect 缺少 Location"))?
                    .to_str()
                    .map_err(|_| {
                        rejected(
                            "UPDATE_REDIRECT_REJECTED",
                            "redirect Location 不是有效 header",
                        )
                    })?
                    .to_owned(),
            )
        } else {
            None
        };
        if status != 200 {
            return Ok(ReleaseHttpResponse {
                status,
                location,
                body: Vec::new(),
            });
        }

        let maximum_bytes = request.kind.maximum_response_bytes();
        if response
            .content_length()
            .is_some_and(|length| length > maximum_bytes as u64)
        {
            return Err(rejected(
                "UPDATE_SOURCE_RESPONSE_TOO_LARGE",
                format!("GitHub 更新元数据超过 {maximum_bytes} 字节上限"),
            ));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|error| UpdateSourceError {
            code: "UPDATE_SOURCE_NETWORK".into(),
            retryable: is_retryable_reqwest_error(&error),
            message: "读取 GitHub 更新元数据失败".into(),
        })? {
            if body.len().saturating_add(chunk.len()) > maximum_bytes {
                return Err(rejected(
                    "UPDATE_SOURCE_RESPONSE_TOO_LARGE",
                    format!("GitHub 更新元数据超过 {maximum_bytes} 字节上限"),
                ));
            }
            body.extend_from_slice(&chunk);
        }

        Ok(ReleaseHttpResponse {
            status,
            location,
            body,
        })
    }
}

pub(super) fn build_hardened_github_client(
    total_timeout: Option<Duration>,
    read_timeout: Duration,
) -> Result<reqwest::Client, UpdateSourceError> {
    crate::install_tls_crypto_provider();
    let mut builder = reqwest::Client::builder()
        .https_only(true)
        .redirect(redirect::Policy::none())
        .retry(reqwest::retry::never())
        .referer(false)
        .no_proxy()
        .dns_resolver(PublicGitHubDnsResolver)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(read_timeout)
        .user_agent("MineRadio-Tauri updater");
    if let Some(timeout) = total_timeout {
        builder = builder.timeout(timeout);
    }
    builder.build().map_err(|_| UpdateSourceError {
        code: "UPDATE_SOURCE_INIT_FAILED".into(),
        retryable: false,
        message: "GitHub Update Source 初始化失败".into(),
    })
}

#[derive(Clone, Copy)]
struct PublicGitHubDnsResolver;

impl Resolve for PublicGitHubDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_ascii_lowercase();
        Box::pin(async move {
            if !NETWORK_HOST_ALLOWLIST.contains(&host.as_str()) {
                return Err(Box::new(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "DNS host 不在 GitHub allowlist",
                ))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            let lookup_host = host.clone();
            let addresses = tauri::async_runtime::spawn_blocking(move || {
                (lookup_host.as_str(), 0)
                    .to_socket_addrs()
                    .map(|values| values.collect::<Vec<_>>())
            })
            .await
            .map_err(|_| {
                Box::new(io::Error::other("DNS resolver worker 失败"))
                    as Box<dyn std::error::Error + Send + Sync>
            })??;
            if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
                return Err(Box::new(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "DNS 结果包含非公网地址",
                ))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    !(octets[0] == 0
        || octets[0] == 10
        || octets[0] == 127
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 169 && octets[1] == 254)
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
        || octets == [192, 88, 99, 2]
        || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
        || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
        || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
        || octets[0] >= 224)
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(embedded) = address.to_ipv4() {
        return is_public_ipv4(embedded);
    }

    let well_known_nat64 = Ipv6Addr::new(0x0064, 0xff9b, 0, 0, 0, 0, 0, 0);
    if is_ipv6_in_prefix(address, well_known_nat64, 96) {
        let octets = address.octets();
        return is_public_ipv4(Ipv4Addr::new(
            octets[12], octets[13], octets[14], octets[15],
        ));
    }

    let global_unicast = Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0);
    if !is_ipv6_in_prefix(address, global_unicast, 3) {
        return false;
    }

    !is_ipv6_in_prefix(address, Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23)
        && !is_ipv6_in_prefix(address, Ipv6Addr::new(0x2001, 0x0db8, 0, 0, 0, 0, 0, 0), 32)
        && !is_ipv6_in_prefix(address, Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16)
        && !is_ipv6_in_prefix(address, Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20)
}

fn is_ipv6_in_prefix(address: Ipv6Addr, network: Ipv6Addr, prefix_length: u32) -> bool {
    let mask = u128::MAX << (128 - prefix_length);
    u128::from(address) & mask == u128::from(network) & mask
}

impl ReleaseHttpTransport for ReqwestReleaseHttpTransport {
    fn get(
        &self,
        request: ReleaseHttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ReleaseHttpResponse, UpdateSourceError>> + Send + '_>>
    {
        Box::pin(async move { self.execute(request).await })
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{HashMap, VecDeque},
        sync::Mutex,
    };

    use serde::Deserialize;

    use super::*;
    use crate::runtime::updater::{
        MemoryUpdateSource, UpdateDispatchRequest, UpdateFaultStage, UpdateIntent, UpdatePhase,
        UpdateReceipt, UpdateRuntime, UpdateSnapshot, UpdateSource,
    };

    const RAW_PROVENANCE: &[u8] = include_bytes!("fixtures/provenance-v2.json");
    const CONTRACT_JSON: &str = include_str!("fixtures/provenance-v2-contract.json");
    const VERSION: &str = "1.2.3";
    const TAG: &str = "v1.2.3";
    const COMMIT_SHA: &str = "0123456789abcdef0123456789abcdef01234567";
    const INSTALLER_NAME: &str = "MineRadio-Tauri_1.2.3_x64-setup.exe";

    #[derive(Debug, Deserialize)]
    struct ContractFixture {
        encoded_public_key: String,
        provenance_signature: String,
        installer_signature: String,
        expected_candidate_id: String,
    }

    #[derive(Default)]
    struct FakeTransport {
        responses: Mutex<HashMap<String, VecDeque<Result<ReleaseHttpResponse, UpdateSourceError>>>>,
        requests: Mutex<Vec<ReleaseHttpRequest>>,
    }

    impl FakeTransport {
        fn respond(&self, request_url: &str, response: ReleaseHttpResponse) {
            self.responses
                .lock()
                .expect("fake transport responses poisoned")
                .entry(request_url.to_owned())
                .or_default()
                .push_back(Ok(response));
        }

        fn requested_urls(&self) -> Vec<String> {
            self.requests
                .lock()
                .expect("fake transport requests poisoned")
                .iter()
                .map(|request| request.url.clone())
                .collect()
        }
    }

    impl ReleaseHttpTransport for FakeTransport {
        fn get(
            &self,
            request: ReleaseHttpRequest,
        ) -> Pin<Box<dyn Future<Output = Result<ReleaseHttpResponse, UpdateSourceError>> + Send + '_>>
        {
            self.requests
                .lock()
                .expect("fake transport requests poisoned")
                .push(request.clone());
            let response = self
                .responses
                .lock()
                .expect("fake transport responses poisoned")
                .get_mut(&request.url)
                .and_then(VecDeque::pop_front)
                .unwrap_or_else(|| {
                    Err(UpdateSourceError {
                        code: "TEST_RESPONSE_MISSING".into(),
                        retryable: false,
                        message: format!("未配置 fake response: {}", request.url),
                    })
                });
            Box::pin(async move { response })
        }
    }

    fn contract() -> ContractFixture {
        serde_json::from_str(CONTRACT_JSON).expect("共享 provenance contract 应有效")
    }

    fn installer_url() -> String {
        format!("https://github.com/{OFFICIAL_REPOSITORY}/releases/download/{TAG}/{INSTALLER_NAME}")
    }

    fn provenance_url() -> String {
        format!(
            "https://github.com/{OFFICIAL_REPOSITORY}/releases/download/{TAG}/release-provenance.json"
        )
    }

    fn provenance_signature_url() -> String {
        format!("{}.sig", provenance_url())
    }

    fn commit_url() -> String {
        format!("https://api.github.com/repos/{OFFICIAL_REPOSITORY}/commits/{TAG}")
    }

    fn manifest_bytes(contract: &ContractFixture, version: &str, url: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "version": version,
            "notes": "修复\u{0}播放链路\n[完整说明](https://evil.example)\n第三行",
            "pub_date": "2026-07-31T00:00:00Z",
            "platforms": {
                "windows-x86_64-nsis": {
                    "signature": contract.installer_signature,
                    "url": url,
                },
                "windows-x86_64": {
                    "signature": contract.installer_signature,
                    "url": url,
                }
            }
        }))
        .expect("manifest fixture 应可序列化")
    }

    fn final_asset_url(name: &str) -> String {
        format!(
            "https://release-assets.githubusercontent.com/github-production-release-asset/{name}?token=test"
        )
    }

    fn respond_release_asset(
        transport: &FakeTransport,
        request_url: &str,
        name: &str,
        body: Vec<u8>,
    ) {
        let final_url = final_asset_url(name);
        transport.respond(
            request_url,
            ReleaseHttpResponse {
                status: 302,
                location: Some(final_url.clone()),
                body: Vec::new(),
            },
        );
        transport.respond(
            &final_url,
            ReleaseHttpResponse {
                status: 200,
                location: None,
                body,
            },
        );
    }

    fn success_transport(contract: &ContractFixture) -> Arc<FakeTransport> {
        let transport = Arc::new(FakeTransport::default());
        respond_release_asset(
            &transport,
            LATEST_MANIFEST_URL,
            "latest.json",
            manifest_bytes(contract, VERSION, &installer_url()),
        );
        respond_release_asset(
            &transport,
            &format!("{}.sig", installer_url()),
            "installer.sig",
            contract.installer_signature.as_bytes().to_vec(),
        );
        transport.respond(
            &commit_url(),
            ReleaseHttpResponse {
                status: 200,
                location: None,
                body: serde_json::to_vec(&serde_json::json!({ "sha": COMMIT_SHA }))
                    .expect("commit fixture 应可序列化"),
            },
        );
        respond_release_asset(
            &transport,
            &provenance_url(),
            "provenance.json",
            RAW_PROVENANCE.to_vec(),
        );
        respond_release_asset(
            &transport,
            &provenance_signature_url(),
            "provenance.json.sig",
            contract.provenance_signature.as_bytes().to_vec(),
        );
        transport
    }

    fn check(
        source: &dyn UpdateSource,
        current_version: &str,
    ) -> Result<Option<NormalizedRelease>, UpdateSourceError> {
        tauri::async_runtime::block_on(source.check(CheckRequest {
            current_version: current_version.to_owned(),
        }))
    }

    fn independently_normalized_release(contract: &ContractFixture) -> NormalizedRelease {
        let verifier = ProvenanceVerifier::from_tauri_pubkey(&contract.encoded_public_key)
            .expect("fixture 公钥应有效");
        let evidence = verifier
            .verify(ProvenanceVerificationInput {
                raw_provenance: RAW_PROVENANCE,
                provenance_signature: &contract.provenance_signature,
                installer_signature: &contract.installer_signature,
                expected_repository: OFFICIAL_REPOSITORY,
                expected_tag: TAG,
                expected_version: VERSION,
                expected_commit_sha: COMMIT_SHA,
                expected_target: RELEASE_TARGET,
            })
            .expect("fixture provenance 应有效");
        NormalizedRelease::from_verified(
            evidence,
            ["修复播放链路", "[完整说明](https://evil.example)", "第三行"],
            Some("2026-07-31T00:00:00Z"),
        )
    }

    #[derive(Debug, Clone, Copy)]
    enum SourceContractCase {
        Current,
        Available,
        TypedFault,
    }

    fn run_source_contract(
        mut build_source: impl FnMut(SourceContractCase) -> Arc<dyn UpdateSource>,
    ) -> Vec<UpdateSnapshot> {
        [
            SourceContractCase::Current,
            SourceContractCase::Available,
            SourceContractCase::TypedFault,
        ]
        .into_iter()
        .map(|case| {
            let current_version = match case {
                SourceContractCase::Current => VERSION,
                SourceContractCase::Available | SourceContractCase::TypedFault => "1.2.2",
            };
            let runtime = UpdateRuntime::with_noop_sink(current_version, build_source(case));
            assert_eq!(
                runtime.dispatch(UpdateDispatchRequest {
                    expected_revision: 0,
                    intent: UpdateIntent::CheckNow,
                }),
                UpdateReceipt::Accepted,
                "case={case:?}"
            );
            tauri::async_runtime::block_on(runtime.run_pending_check());
            runtime.snapshot()
        })
        .collect()
    }

    #[test]
    fn fixed_source_returns_only_a_fully_verified_candidate() {
        let contract = contract();
        let transport = success_transport(&contract);
        let source =
            GitHubReleaseSource::with_transport(&contract.encoded_public_key, transport.clone())
                .expect("fixture source 应可创建");

        let release = check(&source, "1.2.2")
            .expect("可信 candidate 检查应成功")
            .expect("更高版本应可用");

        assert_eq!(
            release.candidate_id.as_str(),
            contract.expected_candidate_id
        );
        assert_eq!(release.version, VERSION);
        assert_eq!(
            release.notes,
            vec![
                "修复播放链路".to_owned(),
                "[完整说明](https://evil.example)".to_owned(),
                "第三行".to_owned(),
            ]
        );
        assert_eq!(release.verified_asset_url(), Some(installer_url()));
        assert_eq!(
            release.release_page_url(),
            Some("https://github.com/zzstar101/Mineradio-Tauri/releases/tag/v1.2.3".into())
        );
        assert_eq!(
            transport.requested_urls(),
            vec![
                LATEST_MANIFEST_URL.to_owned(),
                final_asset_url("latest.json"),
                format!("{}.sig", installer_url()),
                final_asset_url("installer.sig"),
                commit_url(),
                provenance_url(),
                final_asset_url("provenance.json"),
                provenance_signature_url(),
                final_asset_url("provenance.json.sig"),
            ]
        );
    }

    #[test]
    fn same_or_older_versions_never_become_candidates() {
        for current_version in ["1.2.3", "1.2.4"] {
            let contract = contract();
            let transport = success_transport(&contract);
            let source = GitHubReleaseSource::with_transport(
                &contract.encoded_public_key,
                transport.clone(),
            )
            .expect("fixture source 应可创建");

            assert!(check(&source, current_version)
                .expect("同版或降级应安全收敛")
                .is_none());
            assert_eq!(
                transport.requested_urls(),
                vec![
                    LATEST_MANIFEST_URL.to_owned(),
                    final_asset_url("latest.json")
                ]
            );
        }
    }

    #[test]
    fn unstable_version_wrong_target_or_untrusted_final_host_fail_closed() {
        let contract = contract();

        for (version, url, expected_code) in [
            ("1.2.3-rc.1", installer_url(), "UPDATE_MANIFEST_REJECTED"),
            (
                VERSION,
                format!("https://evil.example/{INSTALLER_NAME}"),
                "UPDATE_ASSET_POLICY_REJECTED",
            ),
        ] {
            let transport = Arc::new(FakeTransport::default());
            transport.respond(
                LATEST_MANIFEST_URL,
                ReleaseHttpResponse {
                    status: 200,
                    location: None,
                    body: manifest_bytes(&contract, version, &url),
                },
            );
            let source =
                GitHubReleaseSource::with_transport(&contract.encoded_public_key, transport)
                    .expect("fixture source 应可创建");
            assert_eq!(
                check(&source, "1.2.2")
                    .expect_err("不可信 manifest 必须失败")
                    .code,
                expected_code
            );
        }

        let transport = success_transport(&contract);
        transport
            .responses
            .lock()
            .expect("fake responses poisoned")
            .get_mut(LATEST_MANIFEST_URL)
            .expect("manifest response 应存在")
            .front_mut()
            .expect("manifest response queue 应非空")
            .as_mut()
            .expect("manifest response 应成功")
            .location = Some("https://evil.example/latest.json".into());
        let source = GitHubReleaseSource::with_transport(&contract.encoded_public_key, transport)
            .expect("fixture source 应可创建");
        assert_eq!(
            check(&source, "1.2.2")
                .expect_err("错误 final redirect host 必须失败")
                .code,
            "UPDATE_REDIRECT_REJECTED"
        );
    }

    #[test]
    fn rejected_remote_version_is_not_reflected_in_the_public_fault() {
        let contract = contract();
        let remote_marker = "https://evil.example/?token=remote-secret\u{202e}";
        let transport = Arc::new(FakeTransport::default());
        transport.respond(
            LATEST_MANIFEST_URL,
            ReleaseHttpResponse {
                status: 200,
                location: None,
                body: manifest_bytes(&contract, remote_marker, &installer_url()),
            },
        );
        let source = GitHubReleaseSource::with_transport(&contract.encoded_public_key, transport)
            .expect("fixture source 应可创建");

        let error = check(&source, "1.2.2").expect_err("非法远端版本必须失败");

        assert_eq!(error.code, "UPDATE_MANIFEST_REJECTED");
        assert!(!error.retryable);
        assert!(!error.message.contains(remote_marker));
        assert!(!error.message.contains("remote-secret"));
        assert!(!error.message.contains('\u{202e}'));
    }

    #[test]
    fn rejected_remote_json_is_not_reflected_in_the_public_fault() {
        let contract = contract();
        let remote_marker = "REMOTE_SECRET_MARKER";
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&manifest_bytes(&contract, VERSION, &installer_url()))
                .expect("manifest fixture 应有效");
        manifest
            .as_object_mut()
            .expect("manifest fixture 应为 object")
            .insert(remote_marker.into(), serde_json::Value::Bool(true));
        let transport = Arc::new(FakeTransport::default());
        transport.respond(
            LATEST_MANIFEST_URL,
            ReleaseHttpResponse {
                status: 200,
                location: None,
                body: serde_json::to_vec(&manifest).expect("manifest fixture 应可序列化"),
            },
        );
        let source = GitHubReleaseSource::with_transport(&contract.encoded_public_key, transport)
            .expect("fixture source 应可创建");

        let error = check(&source, "1.2.2").expect_err("含未知字段的 manifest 必须失败");

        assert_eq!(error.code, "UPDATE_MANIFEST_REJECTED");
        assert!(!error.retryable);
        assert!(!error.message.contains(remote_marker));
    }

    #[test]
    fn rejected_remote_provenance_is_not_reflected_in_the_public_fault() {
        let contract = contract();
        let remote_marker = "REMOTE_PROVENANCE_SECRET";
        let transport = success_transport(&contract);
        let mut provenance: serde_json::Value =
            serde_json::from_slice(RAW_PROVENANCE).expect("provenance fixture 应有效");
        provenance
            .as_object_mut()
            .expect("provenance fixture 应为 object")
            .insert(remote_marker.into(), serde_json::Value::Bool(true));
        transport
            .responses
            .lock()
            .expect("fake responses poisoned")
            .get_mut(&final_asset_url("provenance.json"))
            .expect("provenance response 应存在")
            .front_mut()
            .expect("provenance response queue 应非空")
            .as_mut()
            .expect("provenance response 应成功")
            .body = serde_json::to_vec(&provenance).expect("provenance fixture 应可序列化");
        let source = GitHubReleaseSource::with_transport(&contract.encoded_public_key, transport)
            .expect("fixture source 应可创建");

        let error = check(&source, "1.2.2").expect_err("畸形远端 provenance 必须失败");

        assert_eq!(error.code, "UPDATE_PROVENANCE_REJECTED");
        assert!(!error.message.contains(remote_marker));
    }

    #[test]
    fn provenance_signature_or_commit_mismatch_fail_closed() {
        let mut malformed_installer_contract = contract();
        malformed_installer_contract.installer_signature = "%%%".into();
        let malformed_installer_transport = success_transport(&malformed_installer_contract);
        let source = GitHubReleaseSource::with_transport(
            &malformed_installer_contract.encoded_public_key,
            malformed_installer_transport,
        )
        .expect("fixture source 应可创建");
        assert_eq!(
            check(&source, "1.2.2")
                .expect_err("manifest 与 .sig 同为畸形签名时必须失败")
                .code,
            "UPDATE_PROVENANCE_REJECTED"
        );

        let contract = contract();
        let bad_installer_signature_transport = success_transport(&contract);
        bad_installer_signature_transport
            .responses
            .lock()
            .expect("fake responses poisoned")
            .get_mut(&final_asset_url("installer.sig"))
            .expect("installer signature response 应存在")
            .front_mut()
            .expect("installer signature response queue 应非空")
            .as_mut()
            .expect("installer signature response 应成功")
            .body = contract.provenance_signature.as_bytes().to_vec();
        let source = GitHubReleaseSource::with_transport(
            &contract.encoded_public_key,
            bad_installer_signature_transport,
        )
        .expect("fixture source 应可创建");
        assert_eq!(
            check(&source, "1.2.2")
                .expect_err("安装包签名资产不一致必须失败")
                .code,
            "UPDATE_INSTALLER_SIGNATURE_REJECTED"
        );

        let bad_signature_transport = success_transport(&contract);
        bad_signature_transport
            .responses
            .lock()
            .expect("fake responses poisoned")
            .get_mut(&final_asset_url("provenance.json.sig"))
            .expect("signature response 应存在")
            .front_mut()
            .expect("signature response queue 应非空")
            .as_mut()
            .expect("signature response 应成功")
            .body = contract.installer_signature.as_bytes().to_vec();
        let source = GitHubReleaseSource::with_transport(
            &contract.encoded_public_key,
            bad_signature_transport,
        )
        .expect("fixture source 应可创建");
        assert_eq!(
            check(&source, "1.2.2")
                .expect_err("错误 provenance 签名必须失败")
                .code,
            "UPDATE_PROVENANCE_REJECTED"
        );

        let bad_commit_transport = success_transport(&contract);
        bad_commit_transport
            .responses
            .lock()
            .expect("fake responses poisoned")
            .get_mut(&commit_url())
            .expect("commit response 应存在")
            .front_mut()
            .expect("commit response queue 应非空")
            .as_mut()
            .expect("commit response 应成功")
            .body = serde_json::to_vec(&serde_json::json!({
            "sha": "fedcba9876543210fedcba9876543210fedcba98"
        }))
        .expect("commit fixture 应可序列化");
        let source =
            GitHubReleaseSource::with_transport(&contract.encoded_public_key, bad_commit_transport)
                .expect("fixture source 应可创建");
        assert_eq!(
            check(&source, "1.2.2")
                .expect_err("GitHub commit 与 provenance 不一致必须失败")
                .code,
            "UPDATE_PROVENANCE_REJECTED"
        );
    }

    #[test]
    fn url_policy_rejects_http_ip_local_private_and_non_github_hosts() {
        for url in [
            "http://github.com/zzstar101/Mineradio-Tauri/releases/latest/download/latest.json",
            "https://127.0.0.1/latest.json",
            "https://[::1]/latest.json",
            "https://localhost/latest.json",
            "https://10.0.0.1/latest.json",
            "https://github.com.evil.example/latest.json",
            "https://cdn.example/latest.json",
        ] {
            assert!(
                validate_initial_request_url(url, ReleaseHttpResourceKind::Manifest).is_err(),
                "不可信 URL 必须被拒绝: {url}"
            );
        }

        for url in [
            "https://release-assets.githubusercontent.com/file?token=test",
            "https://github.com/zzstar101/Mineradio-Tauri/releases/download/v1.2.3/file",
        ] {
            assert!(
                validate_release_redirect_url(url).is_ok(),
                "显式 GitHub Release host 应通过: {url}"
            );
        }
        assert!(validate_release_redirect_url("https://objects.example/file").is_err());

        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.1.1",
            "192.168.1.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
        ] {
            assert!(!is_public_ip(address.parse().expect("测试 IP 应有效")));
        }
        for address in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(is_public_ip(address.parse().expect("测试 IP 应有效")));
        }
    }

    #[test]
    fn public_ip_policy_uses_exact_special_use_ranges() {
        for address in [
            "192.0.1.1",
            "192.88.99.1",
            "192.88.99.3",
            "198.51.0.1",
            "198.51.99.1",
            "198.51.101.1",
            "64:ff9b::808:808",
        ] {
            assert!(
                is_public_ip(address.parse().expect("测试 IP 应有效")),
                "文档网段之外的公网地址不应被整个 /16 误拒绝: {address}"
            );
        }
        for address in [
            "192.0.0.1",
            "192.0.2.1",
            "192.88.99.2",
            "198.51.100.1",
            "::10.0.0.1",
            "::192.168.1.1",
            "64:ff9b:1::7f00:1",
            "100::1",
            "100:0:0:1::1",
            "2001:2::1",
            "3fff::1",
            "5f00::1",
            "4000::1",
        ] {
            assert!(
                !is_public_ip(address.parse().expect("测试 IP 应有效")),
                "特殊用途或 IPv4-compatible 私网地址必须被拒绝: {address}"
            );
        }
    }

    #[test]
    fn source_drives_relative_redirects_and_rejects_api_or_excess_redirects() {
        let contract = contract();
        let relative_url =
            format!("https://github.com/{OFFICIAL_REPOSITORY}/releases/download/{TAG}/latest.json");
        let final_url = final_asset_url("relative-latest.json");
        let relative = Arc::new(FakeTransport::default());
        relative.respond(
            LATEST_MANIFEST_URL,
            ReleaseHttpResponse {
                status: 302,
                location: Some(format!(
                    "/{OFFICIAL_REPOSITORY}/releases/download/{TAG}/latest.json"
                )),
                body: Vec::new(),
            },
        );
        relative.respond(
            &relative_url,
            ReleaseHttpResponse {
                status: 302,
                location: Some(final_url.clone()),
                body: Vec::new(),
            },
        );
        relative.respond(
            &final_url,
            ReleaseHttpResponse {
                status: 200,
                location: None,
                body: manifest_bytes(&contract, "1.2.3-rc.1", &installer_url()),
            },
        );
        let source =
            GitHubReleaseSource::with_transport(&contract.encoded_public_key, relative.clone())
                .expect("fixture source 应可创建");
        assert_eq!(
            check(&source, "1.2.2")
                .expect_err("prerelease manifest 必须失败")
                .code,
            "UPDATE_MANIFEST_REJECTED"
        );
        assert_eq!(
            relative.requested_urls(),
            vec![LATEST_MANIFEST_URL.to_owned(), relative_url, final_url]
        );

        let api_redirect = success_transport(&contract);
        api_redirect
            .responses
            .lock()
            .expect("fake responses poisoned")
            .get_mut(&commit_url())
            .expect("commit response 应存在")
            .front_mut()
            .expect("commit response queue 应非空")
            .as_mut()
            .expect("commit response 应成功")
            .status = 302;
        api_redirect
            .responses
            .lock()
            .expect("fake responses poisoned")
            .get_mut(&commit_url())
            .expect("commit response 应存在")
            .front_mut()
            .expect("commit response queue 应非空")
            .as_mut()
            .expect("commit response 应成功")
            .location = Some("https://api.github.com/other".into());
        let source =
            GitHubReleaseSource::with_transport(&contract.encoded_public_key, api_redirect)
                .expect("fixture source 应可创建");
        assert_eq!(
            check(&source, "1.2.2")
                .expect_err("GitHub API redirect 必须失败")
                .code,
            "UPDATE_REDIRECT_REJECTED"
        );

        let excessive = Arc::new(FakeTransport::default());
        let mut current = LATEST_MANIFEST_URL.to_owned();
        for index in 0..=MAX_REDIRECTS {
            let next = format!(
                "https://github.com/{OFFICIAL_REPOSITORY}/releases/download/{TAG}/redirect-{index}"
            );
            excessive.respond(
                &current,
                ReleaseHttpResponse {
                    status: 302,
                    location: Some(next.clone()),
                    body: Vec::new(),
                },
            );
            current = next;
        }
        let source = GitHubReleaseSource::with_transport(&contract.encoded_public_key, excessive)
            .expect("fixture source 应可创建");
        assert_eq!(
            check(&source, "1.2.2")
                .expect_err("超限 redirect 必须失败")
                .code,
            "UPDATE_REDIRECT_REJECTED"
        );
    }

    #[test]
    fn response_limits_and_http_retryability_are_typed() {
        let contract = contract();
        let oversized = Arc::new(FakeTransport::default());
        oversized.respond(
            LATEST_MANIFEST_URL,
            ReleaseHttpResponse {
                status: 200,
                location: None,
                body: vec![b'x'; MAX_MANIFEST_BYTES + 1],
            },
        );
        let source = GitHubReleaseSource::with_transport(&contract.encoded_public_key, oversized)
            .expect("fixture source 应可创建");
        assert_eq!(
            check(&source, "1.2.2")
                .expect_err("超限 manifest 必须失败")
                .code,
            "UPDATE_SOURCE_RESPONSE_TOO_LARGE"
        );

        for (status, retryable) in [
            (404, false),
            (408, false),
            (425, false),
            (429, false),
            (503, true),
        ] {
            let transport = Arc::new(FakeTransport::default());
            transport.respond(
                LATEST_MANIFEST_URL,
                ReleaseHttpResponse {
                    status,
                    location: None,
                    body: Vec::new(),
                },
            );
            let source =
                GitHubReleaseSource::with_transport(&contract.encoded_public_key, transport)
                    .expect("fixture source 应可创建");
            let error = check(&source, "1.2.2").expect_err("非 200 必须失败");
            assert_eq!(error.code, "UPDATE_SOURCE_HTTP_STATUS");
            assert_eq!(error.retryable, retryable);
        }
    }

    #[test]
    fn network_retryability_only_allows_timeout_and_connection_reset() {
        for kind in [io::ErrorKind::TimedOut, io::ErrorKind::ConnectionReset] {
            assert!(is_retryable_io_error_kind(kind));
        }
        for kind in [
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::ConnectionRefused,
            io::ErrorKind::InvalidData,
            io::ErrorKind::NotFound,
        ] {
            assert!(!is_retryable_io_error_kind(kind));
        }
    }

    #[test]
    fn notes_and_published_time_are_bounded_plain_text() {
        let long_line = "歌".repeat(MAX_NOTE_LINE_CHARS + 20);
        let raw = format!("  第一行\u{0}\u{202e}  \n{long_line}\n第三行\n第四行\n第五行\n第六行");
        let notes = sanitize_release_notes(&raw);

        assert_eq!(notes.len(), MAX_NOTE_LINES);
        assert_eq!(notes[0], "第一行");
        assert_eq!(notes[1].chars().count(), MAX_NOTE_LINE_CHARS);
        assert!(notes
            .iter()
            .flat_map(|line| line.chars())
            .all(|character| !is_disallowed_note_character(character)));
        assert!(
            notes.iter().map(|line| line.chars().count()).sum::<usize>() <= MAX_NOTE_TOTAL_CHARS
        );

        assert_eq!(
            sanitize_published_at(Some("2026-07-31T00:00:00Z".into())),
            Some("2026-07-31T00:00:00Z".into())
        );
        assert_eq!(sanitize_published_at(Some("not-a-time".into())), None);
    }

    #[test]
    fn unicode_line_separators_cannot_bypass_the_note_line_budget() {
        let notes = sanitize_release_notes("一\u{2028}二\u{2029}三\n四\n五");

        assert_eq!(notes, vec!["一", "二", "三", "四"]);
        assert!(notes
            .iter()
            .flat_map(|line| line.chars())
            .all(|character| !matches!(character, '\u{2028}' | '\u{2029}')));
    }

    #[test]
    fn github_and_memory_sources_share_the_normalized_release_contract() {
        let contract = contract();
        let mut github_snapshots = run_source_contract(|case| {
            let transport = match case {
                SourceContractCase::Current | SourceContractCase::Available => {
                    success_transport(&contract)
                }
                SourceContractCase::TypedFault => {
                    let transport = Arc::new(FakeTransport::default());
                    transport.respond(
                        LATEST_MANIFEST_URL,
                        ReleaseHttpResponse {
                            status: 503,
                            location: None,
                            body: Vec::new(),
                        },
                    );
                    transport
                }
            };
            Arc::new(
                GitHubReleaseSource::with_transport(&contract.encoded_public_key, transport)
                    .expect("fixture source 应可创建"),
            )
        });
        let mut memory_snapshots = run_source_contract(|case| {
            let outcome = match case {
                SourceContractCase::Current => Ok(None),
                SourceContractCase::Available => {
                    Ok(Some(independently_normalized_release(&contract)))
                }
                SourceContractCase::TypedFault => Err(UpdateSourceError {
                    code: "UPDATE_SOURCE_HTTP_STATUS".into(),
                    retryable: true,
                    message: "GitHub 更新元数据请求返回 HTTP 503".into(),
                }),
            };
            Arc::new(MemoryUpdateSource::with_outcomes([outcome]))
        });

        assert!(github_snapshots[0].checked_at.is_some());
        assert!(github_snapshots[1].checked_at.is_some());
        assert!(github_snapshots[2].checked_at.is_none());
        assert!(memory_snapshots[0].checked_at.is_some());
        assert!(memory_snapshots[1].checked_at.is_some());
        assert!(memory_snapshots[2].checked_at.is_none());
        // 成功检查时间来自 wall clock；契约只要求两种 Source 都持久化成功事实。
        for snapshot in github_snapshots.iter_mut().chain(&mut memory_snapshots) {
            snapshot.checked_at = snapshot.checked_at.map(|_| 1);
        }
        assert_eq!(memory_snapshots, github_snapshots);
        assert_eq!(github_snapshots[0].phase, UpdatePhase::Current);
        assert_eq!(github_snapshots[0].candidate, None);
        assert_eq!(github_snapshots[1].phase, UpdatePhase::Available);
        assert_eq!(
            github_snapshots[1]
                .candidate
                .as_ref()
                .map(|candidate| candidate.id.as_str()),
            Some(contract.expected_candidate_id.as_str())
        );
        assert_eq!(github_snapshots[2].phase, UpdatePhase::Idle);
        assert_eq!(
            github_snapshots[2]
                .fault
                .as_ref()
                .map(|fault| (fault.code.as_str(), fault.retryable)),
            Some(("UPDATE_SOURCE_HTTP_STATUS", true))
        );
    }

    #[test]
    fn real_transport_client_initializes_without_external_tls_setup() {
        ReqwestReleaseHttpTransport::new()
            .expect("真实 GitHub transport 应自行完成 TLS provider 初始化");
    }

    #[test]
    #[ignore = "需要人工联网执行，不属于普通 PR 测试"]
    fn live_github_source_probe_uses_the_dormant_runtime() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../../tauri.conf.json"))
                .expect("tauri.conf.json 应有效");
        let public_key = config
            .pointer("/plugins/updater/pubkey")
            .and_then(serde_json::Value::as_str)
            .expect("Tauri 配置应包含 updater 公钥");
        let source =
            Arc::new(GitHubReleaseSource::new(public_key).expect("live GitHub Source 应能初始化"));
        let runtime = UpdateRuntime::with_noop_sink(env!("CARGO_PKG_VERSION"), source);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 0,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        tauri::async_runtime::block_on(runtime.run_pending_check());
        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.operation, None);
        match snapshot.phase {
            UpdatePhase::Current => {
                assert_eq!(snapshot.candidate, None);
                assert_eq!(snapshot.fault, None);
            }
            UpdatePhase::Available => {
                assert!(snapshot.candidate.is_some());
                assert_eq!(snapshot.fault, None);
            }
            UpdatePhase::Idle => {
                assert_eq!(snapshot.candidate, None);
                assert_eq!(
                    snapshot.fault.as_ref().map(|fault| fault.stage),
                    Some(UpdateFaultStage::Check)
                );
            }
            phase => panic!("live GitHub probe 返回了非稳定 phase: {phase:?}"),
        }
        println!(
            "{}",
            serde_json::to_string_pretty(&snapshot).expect("snapshot 应可序列化")
        );
    }
}
