//! 本地音乐库运行时：移植上游 Electron `desktop/local-music-library.js` 的可观测语义。
//!
//! 职责：
//! - 索引持久化（`{app_data}/local-music-library.json`）与封面存储
//!   （`{app_data}/local-music-library/covers/`）
//! - 导入流水线（sidecar 歌词、lofty 元数据、封面预算、原子提交协议）
//! - `mineradio-local` 自定义协议的响应构造（Range / HEAD / CORS / nosniff），
//!   通过 seek + 固定 64KiB 块读取流式回放，绝不整文件载入内存。
//!
//! 并发约定：解析工作在锁外完成；提交阶段在互斥锁内完成，保证索引与内存状态
//! 原子切换。协议与命令层各自短暂取锁，绝不跨 await 持有 std 锁。

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use encoding_rs::GB18030;
use lofty::{
    prelude::*,
    tag::{ItemKey, Tag},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::http::{
    header::{
        ACCEPT_RANGES, ACCESS_CONTROL_ALLOW_ORIGIN, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE,
        CONTENT_TYPE, VARY, X_CONTENT_TYPE_OPTIONS,
    },
    Method, Request, Response, StatusCode,
};

pub const LOCAL_LIBRARY_VERSION: u32 = 1;
pub const LOCAL_LIBRARY_FILE_NAME: &str = "local-music-library.json";
pub const LOCAL_LIBRARY_DIRECTORY_NAME: &str = "local-music-library";
pub const LOCAL_COVER_DIRECTORY_NAME: &str = "covers";
pub const MAX_LIBRARY_INDEX_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_LYRIC_BYTES: usize = 512 * 1024;
pub const MAX_COVER_BYTES: usize = 6 * 1024 * 1024;
pub const MAX_UNKNOWN_DIMENSION_COVER_BYTES: usize = 1024 * 1024;
pub const MAX_COVER_DIMENSION: u64 = 4096;
pub const MAX_COVER_PIXELS: u64 = 12 * 1024 * 1024;
pub const MAX_IMPORT_FILES: usize = 50_000;
pub const METADATA_CONCURRENCY: usize = 3;
/// 协议流式读取的固定块大小（绝不整文件载入内存）。
const MEDIA_READ_CHUNK_BYTES: u64 = 64 * 1024;
/// Windows 下 WebView2 将自定义 scheme 映射为该主机形式。
pub const LOCAL_MEDIA_ORIGIN: &str = "http://mineradio-local.localhost";

const TEXT_MAX_LENGTH: usize = 1000;
const RELATIVE_PATH_MAX_LENGTH: usize = 2000;
const REVISION_MAX_LENGTH: usize = 100;

const AUDIO_MIME_BY_EXTENSION: [(&str, &str); 7] = [
    ("mp3", "audio/mpeg"),
    ("flac", "audio/flac"),
    ("wav", "audio/wav"),
    ("ogg", "audio/ogg"),
    ("m4a", "audio/mp4"),
    ("aac", "audio/aac"),
    ("opus", "audio/ogg"),
];

const COVER_MIME_BY_EXTENSION: [(&str, &str); 6] = [
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("png", "image/png"),
    ("webp", "image/webp"),
    ("gif", "image/gif"),
    ("bmp", "image/bmp"),
];

const COVER_EXTENSION_BY_MIME: [(&str, &str); 6] = [
    ("image/jpeg", ".jpg"),
    ("image/jpg", ".jpg"),
    ("image/png", ".png"),
    ("image/webp", ".webp"),
    ("image/gif", ".gif"),
    ("image/bmp", ".bmp"),
];

// ---------------------------------------------------------------------------
// 小工具函数
// ---------------------------------------------------------------------------

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn sha256_hex(data: &[u8]) -> String {
    hex_encode(&Sha256::digest(data))
}

fn to_base36(mut value: u64) -> String {
    if value == 0 {
        return "0".to_owned();
    }
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut buffer = [0u8; 13];
    let mut length = 0;
    while value > 0 {
        buffer[length] = DIGITS[(value % 36) as usize];
        value /= 36;
        length += 1;
    }
    buffer[..length]
        .iter()
        .rev()
        .map(|byte| *byte as char)
        .collect()
}

fn now_unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn is_lower_hex(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_valid_track_id(value: &str) -> bool {
    value.len() == 24 && is_lower_hex(value)
}

/// 移植 `cleanText`：剔除 NUL、trim、空则回退、按字符截断。
fn clean_text(value: &str, fallback: &str, max_length: usize) -> String {
    let cleaned = value.chars().filter(|ch| *ch != '\0').collect::<String>();
    let trimmed = cleaned.trim();
    let chosen = if trimmed.is_empty() {
        fallback
    } else {
        trimmed
    };
    truncate_char_bytes(chosen, max_length)
}

fn truncate_char_bytes(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn file_stem_lower(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| stem.to_lowercase())
        .unwrap_or_default()
}

/// 文件名干（保留大小写），对应 upstream `path.basename(audioPath, extname)`
/// 的标题回退语义；sidecar 匹配键另用小写版本。
fn file_stem_display(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default()
        .to_owned()
}

fn file_name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_owned()
}

fn extension_lower(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default()
}

fn audio_mime_for_extension(extension: &str) -> Option<&'static str> {
    AUDIO_MIME_BY_EXTENSION
        .iter()
        .find(|(ext, _)| *ext == extension)
        .map(|(_, mime)| *mime)
}

fn is_supported_audio_extension(extension: &str) -> bool {
    audio_mime_for_extension(extension).is_some()
}

/// 命令层目录遍历用：文件是否受支持音频扩展名。
pub fn is_supported_audio_file(path: &Path) -> bool {
    is_supported_audio_extension(&extension_lower(path))
}

/// 命令层防环用：目录的规范化身份键。
pub fn directory_identity(directory: &Path) -> String {
    normalized_absolute_file_path(&directory.to_string_lossy())
        .unwrap_or_else(|| directory.to_string_lossy().into_owned())
}

fn cover_mime_for_extension(extension: &str) -> Option<&'static str> {
    COVER_MIME_BY_EXTENSION
        .iter()
        .find(|(ext, _)| *ext == extension)
        .map(|(_, mime)| *mime)
}

// ---------------------------------------------------------------------------
// 身份与路径归一化
// ---------------------------------------------------------------------------

/// 去掉 Windows verbatim 前缀并拒绝 UNC / 双斜杠路径，Windows 下整体小写。
/// 返回值即参与哈希的身份字符串，同时也是落盘的 audioPath。
fn normalize_identity_path(path: &Path) -> Option<String> {
    let mut text = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        // \\?\UNC\server\share 与任何 UNC 形态都是网络路径，拒绝。
        if text.starts_with(r"\\?\UNC\") || text.starts_with("UNC\\") {
            return None;
        }
        if let Some(stripped) = text.strip_prefix(r"\\?\") {
            text = stripped.to_owned();
        }
    }
    if text.starts_with(r"\\") || text.starts_with("//") {
        return None;
    }
    if !Path::new(&text).is_absolute() {
        return None;
    }
    Some(if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    })
}

/// 输入路径 → 归一化绝对路径字符串。优先 canonicalize；canonicalize 失败时
/// （典型场景：索引重载校验已消失的文件）退化为词法路径，仍能复算同一身份。
fn normalized_absolute_file_path(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("//")
        || trimmed.starts_with(r"\\")
        || trimmed.starts_with(r"UNC\")
    {
        return None;
    }
    if !Path::new(trimmed).is_absolute() {
        return None;
    }
    let canonical =
        fs::canonicalize(PathBuf::from(trimmed)).unwrap_or_else(|_| PathBuf::from(trimmed));
    normalize_identity_path(&canonical)
}

fn local_file_id(identity: &str) -> String {
    sha256_hex(identity.as_bytes())[..24].to_owned()
}

/// 复算既有 audioPath 的身份：优先 canonicalize，失败时退化为词法归一化，
/// 保证已消失文件的记录在索引重载时仍能复算同一身份。
fn identity_of_stored_audio_path(stored: &str) -> Option<String> {
    normalized_absolute_file_path(stored)
}

/// 支持格式的音频输入 → 归一化路径。
fn supported_audio_path(input: &str) -> Option<String> {
    let resolved = normalized_absolute_file_path(input)?;
    let extension = extension_lower(Path::new(&resolved));
    if !is_supported_audio_extension(&extension) {
        return None;
    }
    Some(resolved)
}

/// `candidate` 是否严格位于 `root` 目录内部（Windows 忽略大小写）。
fn is_path_inside(root: &Path, candidate: &Path) -> bool {
    if let Ok(relative) = candidate.strip_prefix(root) {
        return !relative.as_os_str().is_empty();
    }
    #[cfg(windows)]
    {
        let root_parts: Vec<_> = root.components().collect();
        let candidate_parts: Vec<_> = candidate.components().collect();
        candidate_parts.len() > root_parts.len()
            && root_parts
                .iter()
                .zip(candidate_parts.iter())
                .all(|(a, b)| a.as_os_str().eq_ignore_ascii_case(b.as_os_str()))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

// ---------------------------------------------------------------------------
// 图片嗅探 / 尺寸解析 / 封面预算
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImageKind {
    Png,
    Jpeg,
    Gif,
    Bmp,
    Webp,
}

impl ImageKind {
    fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Bmp => "image/bmp",
            Self::Webp => "image/webp",
        }
    }

    /// 封面扩展名映射（未知 MIME 无条目时等价于上游的 unknown-extension 分支）。
    fn cover_extension(self) -> Option<&'static str> {
        COVER_EXTENSION_BY_MIME
            .iter()
            .find(|(mime, _)| *mime == self.mime())
            .map(|(_, ext)| *ext)
    }
}

fn sniff_image_kind(data: &[u8]) -> Option<ImageKind> {
    if data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some(ImageKind::Png);
    }
    if data.len() >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF {
        return Some(ImageKind::Jpeg);
    }
    if data.len() >= 6 && &data[..3] == b"GIF" && (data[3] == b'7' || data[3] == b'9') {
        return Some(ImageKind::Gif);
    }
    if data.len() >= 2 && data[0] == b'B' && data[1] == b'M' {
        return Some(ImageKind::Bmp);
    }
    if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some(ImageKind::Webp);
    }
    None
}

fn read_u16_le(data: &[u8], offset: usize) -> Option<u16> {
    let bytes = data.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u16_be(data: &[u8], offset: usize) -> Option<u16> {
    let bytes = data.get(offset..offset + 2)?;
    Some(u16::from_be_bytes([bytes[0], bytes[1]]))
}

fn read_u32_be(data: &[u8], offset: usize) -> Option<u32> {
    let bytes = data.get(offset..offset + 4)?;
    Some(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_u24_le(data: &[u8], offset: usize) -> Option<u32> {
    let bytes = data.get(offset..offset + 3)?;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], 0]))
}

fn read_i32_le(data: &[u8], offset: usize) -> Option<i32> {
    let bytes = data.get(offset..offset + 4)?;
    Some(i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

/// 手工头解析图片尺寸（PNG IHDR / GIF / BMP / JPEG SOF 扫描 / WEBP VP8X|VP8L）。
fn image_dimensions(kind: ImageKind, data: &[u8]) -> Option<(u64, u64)> {
    match kind {
        ImageKind::Png => {
            // PNG 签名(8) + 长度(4) + "IHDR"(4)，宽高为 BE u32 @16/@20。
            if data.len() < 24 || &data[12..16] != b"IHDR" {
                return None;
            }
            let width = read_u32_be(data, 16)? as u64;
            let height = read_u32_be(data, 20)? as u64;
            Some((width, height))
        }
        ImageKind::Gif => {
            if data.len() < 10 {
                return None;
            }
            let width = read_u16_le(data, 6)? as u64;
            let height = read_u16_le(data, 8)? as u64;
            Some((width, height))
        }
        ImageKind::Bmp => {
            if data.len() < 26 {
                return None;
            }
            let width = read_i32_le(data, 18)?.unsigned_abs() as u64;
            let height = read_i32_le(data, 22)?.unsigned_abs() as u64;
            Some((width, height))
        }
        ImageKind::Jpeg => {
            const SOF_MARKERS: [u8; 13] = [
                0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
            ];
            let mut offset = 2usize;
            while offset + 9 < data.len() {
                if data[offset] != 0xFF {
                    offset += 1;
                    continue;
                }
                let marker = data[offset + 1];
                if marker == 0xD8 || marker == 0xD9 {
                    offset += 2;
                    continue;
                }
                let length = read_u16_be(data, offset + 2)? as usize;
                if length < 2 || offset + 2 + length > data.len() {
                    break;
                }
                if SOF_MARKERS.contains(&marker) {
                    let height = read_u16_be(data, offset + 5)? as u64;
                    let width = read_u16_be(data, offset + 7)? as u64;
                    return Some((width, height));
                }
                offset += 2 + length;
            }
            None
        }
        ImageKind::Webp => {
            if data.len() < 30 {
                return None;
            }
            let chunk = &data[12..16];
            if chunk == b"VP8X" {
                let width = read_u24_le(data, 24)? as u64 + 1;
                let height = read_u24_le(data, 27)? as u64 + 1;
                return Some((width, height));
            }
            if chunk == b"VP8L" && data.get(20) == Some(&0x2F) {
                let bytes = data.get(21..25)?;
                let bits = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
                let width = (bits & 0x3FFF) as u64 + 1;
                let height = ((bits >> 14) & 0x3FFF) as u64 + 1;
                return Some((width, height));
            }
            None
        }
    }
}

fn cover_within_budget(data: &[u8]) -> bool {
    if data.is_empty() || data.len() > MAX_COVER_BYTES {
        return false;
    }
    let Some(dimensions) = sniff_image_kind(data).and_then(|kind| image_dimensions(kind, data))
    else {
        return data.len() <= MAX_UNKNOWN_DIMENSION_COVER_BYTES;
    };
    let (width, height) = dimensions;
    width > 0
        && height > 0
        && width <= MAX_COVER_DIMENSION
        && height <= MAX_COVER_DIMENSION
        && width * height <= MAX_COVER_PIXELS
}

// ---------------------------------------------------------------------------
// 歌词解码
// ---------------------------------------------------------------------------

fn strip_nuls_and_trim(text: String) -> String {
    text.chars()
        .filter(|ch| *ch != '\0')
        .collect::<String>()
        .trim()
        .to_owned()
}

/// 移植 `decodeLyricBuffer`：UTF-8 BOM / UTF-16LE BOM / FE-FF 字节交换 /
/// 严格 UTF-8 失败 → GB18030 → 有损 UTF-8 兜底。
pub(crate) fn decode_lyric_buffer(buffer: &[u8]) -> String {
    if buffer.is_empty() {
        return String::new();
    }
    if buffer.len() >= 3 && buffer[0] == 0xEF && buffer[1] == 0xBB && buffer[2] == 0xBF {
        return strip_nuls_and_trim(String::from_utf8_lossy(&buffer[3..]).into_owned());
    }
    if buffer.len() >= 2 && buffer[0] == 0xFF && buffer[1] == 0xFE {
        let units: Vec<u16> = buffer[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        return strip_nuls_and_trim(String::from_utf16_lossy(&units));
    }
    if buffer.len() >= 2 && buffer[0] == 0xFE && buffer[1] == 0xFF {
        // FE-FF：按字节对交换后按 UTF-16LE 解码（等价于按大端解释）。
        let units: Vec<u16> = buffer[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[1], pair[0]]))
            .collect();
        return strip_nuls_and_trim(String::from_utf16_lossy(&units));
    }
    if let Ok(text) = std::str::from_utf8(buffer) {
        return strip_nuls_and_trim(text.to_owned());
    }
    let (decoded, _, had_errors) = GB18030.decode(buffer);
    if had_errors {
        return strip_nuls_and_trim(String::from_utf8_lossy(buffer).into_owned());
    }
    strip_nuls_and_trim(decoded.into_owned())
}

// ---------------------------------------------------------------------------
// 持久化结构
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct LocalTrackRecord {
    pub id: String,
    pub audio_path: String,
    pub relative_path: String,
    pub name: String,
    pub artist: String,
    pub album: String,
    pub duration: f64,
    pub size: u64,
    pub mtime_ms: u64,
    pub revision: String,
    pub cover_path: String,
    pub cover_mime: String,
    pub lyric: String,
    pub lyric_source: String,
    pub imported_at: u64,
}

impl Default for LocalTrackRecord {
    fn default() -> Self {
        Self {
            id: String::new(),
            audio_path: String::new(),
            relative_path: String::new(),
            name: String::new(),
            artist: String::new(),
            album: String::new(),
            duration: 0.0,
            size: 0,
            mtime_ms: 0,
            revision: String::new(),
            cover_path: String::new(),
            cover_mime: String::new(),
            lyric: String::new(),
            lyric_source: String::new(),
            imported_at: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryIndexFile {
    version: u32,
    updated_at: u64,
    media_token: String,
    records: Vec<LocalTrackRecord>,
}

/// 序列化给前端的本地曲目 DTO。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrackDto {
    #[serde(rename = "type")]
    pub track_type: String,
    pub source: String,
    pub provider: String,
    pub id: String,
    pub local_file_id: String,
    pub local_key: String,
    pub local_url: String,
    pub local_path: String,
    pub local_missing: bool,
    pub name: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: f64,
    pub cover: String,
    pub has_lyric: bool,
    pub lyric_source: String,
}

/// 列表 / 移除命令返回的库快照。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshotOutcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub tracks: Vec<LocalTrackDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl LibrarySnapshotOutcome {
    pub fn unavailable() -> Self {
        Self {
            ok: false,
            version: None,
            count: None,
            tracks: Vec::new(),
            error: Some("LOCAL_LIBRARY_UNAVAILABLE".to_owned()),
        }
    }
}

/// 导入命令返回结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub tracks: Vec<LocalTrackDto>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub failures: Vec<ImportFailure>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub metadata_warnings: Vec<MetadataWarning>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ImportOutcome {
    pub fn code(code: &str) -> Self {
        Self {
            ok: false,
            version: None,
            count: Some(0),
            tracks: Vec::new(),
            failures: Vec::new(),
            metadata_warnings: Vec::new(),
            error: Some(code.to_owned()),
        }
    }

    pub fn dialog_dismissed() -> Self {
        Self::code("IMPORT_DIALOG_DISMISSED")
    }

    pub fn no_supported_audio(failures: Vec<ImportFailure>) -> Self {
        Self {
            ok: false,
            version: None,
            count: Some(0),
            tracks: Vec::new(),
            failures,
            metadata_warnings: Vec::new(),
            error: Some("NO_SUPPORTED_LOCAL_AUDIO".to_owned()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub name: String,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataWarning {
    pub name: String,
    pub error: String,
}

/// 歌词查询结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricOutcome {
    pub ok: bool,
    pub local_file_id: String,
    pub lyric: String,
    pub lyric_source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// 元数据解析（lofty 默认实现 + 可注入测试替身）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ParsedPicture {
    pub mime: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ParsedAudioMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_secs: Option<f64>,
    pub lyric_text: Option<String>,
    pub picture: Option<ParsedPicture>,
}

pub(crate) type MetadataParser =
    Arc<dyn Fn(&Path) -> Result<ParsedAudioMetadata, String> + Send + Sync>;

/// lofty 默认解析器：标签、时长、歌词（USLT/©lyr/LYRICS）与首张内嵌图片。
fn default_metadata_parser() -> MetadataParser {
    Arc::new(|path: &Path| {
        let tagged = lofty::read_from_path(path)
            .map_err(|error| format!("METADATA_PARSE_FAILED: {error}"))?;
        let duration_secs = tagged.properties().duration().as_secs_f64();
        let tag: Option<&Tag> = tagged.primary_tag().or_else(|| tagged.first_tag());
        let Some(tag) = tag else {
            return Ok(ParsedAudioMetadata {
                duration_secs: Some(duration_secs),
                ..ParsedAudioMetadata::default()
            });
        };
        let artist = tag.artist().map(|value| value.into_owned()).or_else(|| {
            let artists: Vec<&str> = tag.get_strings(&ItemKey::TrackArtists).collect();
            (!artists.is_empty()).then(|| artists.join(" / "))
        });
        let lyric_text = tag
            .get_string(&ItemKey::Lyrics)
            .map(str::to_owned)
            .or_else(|| tag.get_strings(&ItemKey::Lyrics).next().map(str::to_owned));
        let picture = tag.pictures().first().map(|picture| ParsedPicture {
            mime: sniff_image_kind(picture.data())
                .map(|kind| kind.mime())
                .unwrap_or_default()
                .to_owned(),
            data: picture.data().to_vec(),
        });
        Ok(ParsedAudioMetadata {
            title: tag.title().map(|value| value.into_owned()),
            artist,
            album: tag.album().map(|value| value.into_owned()),
            duration_secs: Some(duration_secs),
            lyric_text,
            picture,
        })
    })
}

fn random_media_token() -> String {
    let mut bytes = [0u8; 24];
    if getrandom::fill(&mut bytes).is_err() {
        // 极端环境下的确定性兜底，仍保证 48 位 hex 形态。
        return sha256_hex(
            format!(
                "mineradio-local-{}-{}",
                std::process::id(),
                now_unix_millis()
            )
            .as_bytes(),
        )[..48]
            .to_owned();
    }
    hex_encode(&bytes)
}

// ---------------------------------------------------------------------------
// 运行时
// ---------------------------------------------------------------------------

pub struct LocalMusicLibraryRuntime {
    index_path: PathBuf,
    covers_dir: PathBuf,
    media_token: String,
    records: HashMap<String, LocalTrackRecord>,
    order: Vec<String>,
    metadata_parser: MetadataParser,
}

impl LocalMusicLibraryRuntime {
    /// 打开（或惰性创建）本地音乐库。索引缺失 / 损坏 / 版本不符 / 超限时
    /// 静默以空库 + 全新 mediaToken 启动。
    pub fn open(app_data_dir: &Path) -> Self {
        let mut runtime = Self {
            index_path: app_data_dir.join(LOCAL_LIBRARY_FILE_NAME),
            covers_dir: app_data_dir
                .join(LOCAL_LIBRARY_DIRECTORY_NAME)
                .join(LOCAL_COVER_DIRECTORY_NAME),
            media_token: random_media_token(),
            records: HashMap::new(),
            order: Vec::new(),
            metadata_parser: default_metadata_parser(),
        };
        runtime.load_index();
        runtime
    }

    #[cfg(test)]
    fn with_metadata_parser(app_data_dir: &Path, parser: MetadataParser) -> Self {
        let mut runtime = Self::open(app_data_dir);
        runtime.metadata_parser = parser;
        runtime
    }

    pub fn covers_dir(&self) -> &Path {
        &self.covers_dir
    }

    pub fn media_token(&self) -> &str {
        &self.media_token
    }

    fn load_index(&mut self) {
        let Ok(metadata) = fs::metadata(&self.index_path) else {
            return;
        };
        if !metadata.is_file()
            || metadata.len() == 0
            || metadata.len() > MAX_LIBRARY_INDEX_BYTES as u64
        {
            return;
        }
        let Ok(text) = fs::read_to_string(&self.index_path) else {
            return;
        };
        let Ok(parsed) = serde_json::from_str::<LocalLibraryIndexFile>(&text) else {
            return;
        };
        if parsed.version != LOCAL_LIBRARY_VERSION {
            return;
        }
        let token = parsed.media_token.trim().to_lowercase();
        if token.len() == 48 && is_lower_hex(&token) {
            self.media_token = token;
        }
        let mut records = HashMap::new();
        let mut order = Vec::new();
        for source in parsed.records.into_iter().take(MAX_IMPORT_FILES) {
            let Some(audio_path) = supported_audio_path(&source.audio_path) else {
                continue;
            };
            let Some(identity) = identity_of_stored_audio_path(&source.audio_path) else {
                continue;
            };
            let id = clean_text(&source.id, "", 64).to_lowercase();
            if !is_valid_track_id(&id)
                || id != local_file_id(&identity)
                || records.contains_key(&id)
            {
                continue;
            }
            let mut cover_path =
                normalized_absolute_file_path(&source.cover_path).unwrap_or_default();
            if cover_path.is_empty() || !is_path_inside(&self.covers_dir, Path::new(&cover_path)) {
                cover_path.clear();
            }
            let lyric_source = match source.lyric_source.as_str() {
                "sidecar" => "sidecar".to_owned(),
                "embedded" => "embedded".to_owned(),
                _ => String::new(),
            };
            let record = LocalTrackRecord {
                id: id.clone(),
                audio_path,
                relative_path: clean_text(
                    &source.relative_path,
                    &file_name_of(&source.audio_path),
                    RELATIVE_PATH_MAX_LENGTH,
                ),
                name: clean_text(
                    &source.name,
                    &file_stem_display(&source.audio_path),
                    TEXT_MAX_LENGTH,
                ),
                artist: clean_text(&source.artist, "本地文件", TEXT_MAX_LENGTH),
                album: clean_text(&source.album, "", TEXT_MAX_LENGTH),
                duration: source.duration.max(0.0),
                size: source.size,
                mtime_ms: source.mtime_ms,
                revision: clean_text(&source.revision, "", REVISION_MAX_LENGTH),
                cover_path,
                cover_mime: clean_text(&source.cover_mime, "", REVISION_MAX_LENGTH),
                lyric: clean_text(&source.lyric, "", MAX_LYRIC_BYTES),
                lyric_source,
                imported_at: source.imported_at,
            };
            records.insert(id.clone(), record);
            order.push(id);
        }
        self.records = records;
        self.order = order;
    }

    fn serialize_record(&self, record: &LocalTrackRecord) -> LocalTrackDto {
        let local_url = format!(
            "{}/audio/{}?v={}&cap={}",
            LOCAL_MEDIA_ORIGIN,
            record.id,
            urlencode_component(&record.revision),
            urlencode_component(&self.media_token)
        );
        let cover = if record.cover_path.is_empty() {
            String::new()
        } else {
            format!(
                "{}/cover/{}?v={}&cap={}",
                LOCAL_MEDIA_ORIGIN,
                record.id,
                urlencode_component(&record.revision),
                urlencode_component(&self.media_token)
            )
        };
        LocalTrackDto {
            track_type: "local".to_owned(),
            source: "local".to_owned(),
            provider: "local".to_owned(),
            id: format!("local:{}", record.id),
            local_file_id: record.id.clone(),
            local_key: record.id.clone(),
            local_url,
            local_path: if record.relative_path.is_empty() {
                file_name_of(&record.audio_path)
            } else {
                record.relative_path.clone()
            },
            local_missing: false,
            name: record.name.clone(),
            title: record.name.clone(),
            artist: if record.artist.is_empty() {
                "本地文件".to_owned()
            } else {
                record.artist.clone()
            },
            album: record.album.clone(),
            duration: record.duration.max(0.0),
            cover,
            has_lyric: !record.lyric.is_empty(),
            lyric_source: record.lyric_source.clone(),
        }
    }

    pub fn snapshot(&self) -> LibrarySnapshotOutcome {
        let tracks: Vec<LocalTrackDto> = self
            .order
            .iter()
            .filter_map(|id| self.records.get(id))
            .map(|record| self.serialize_record(record))
            .collect();
        LibrarySnapshotOutcome {
            ok: true,
            version: Some(LOCAL_LIBRARY_VERSION),
            count: Some(tracks.len()),
            tracks,
            error: None,
        }
    }

    pub fn lyric_for_track(&self, value: &str) -> LyricOutcome {
        let id = clean_text(value, "", 64)
            .strip_prefix("local:")
            .unwrap_or(clean_text(value, "", 64).as_str())
            .to_lowercase();
        if !is_valid_track_id(&id) {
            return LyricOutcome {
                ok: false,
                local_file_id: String::new(),
                lyric: String::new(),
                lyric_source: String::new(),
                missing: None,
                error: Some("LOCAL_TRACK_INVALID".to_owned()),
            };
        }
        let Some(record) = self.records.get(&id) else {
            return LyricOutcome {
                ok: false,
                local_file_id: id,
                lyric: String::new(),
                lyric_source: String::new(),
                missing: Some(true),
                error: Some("LOCAL_TRACK_MISSING".to_owned()),
            };
        };
        LyricOutcome {
            ok: true,
            local_file_id: id,
            lyric: record.lyric.clone(),
            lyric_source: record.lyric_source.clone(),
            missing: None,
            error: None,
        }
    }

    /// 协议解析：kind / id / cap 校验 + 文件路径与 Content-Type 决议。
    /// 文件存在性由响应构造器 stat 检查。
    pub fn resolve_media(&self, kind: &str, id: &str, cap: &str) -> Option<(String, &'static str)> {
        if cap != self.media_token || !is_valid_track_id(id) {
            return None;
        }
        let record = self.records.get(id)?;
        match kind {
            "audio" => {
                let extension = extension_lower(Path::new(&record.audio_path));
                let mime = audio_mime_for_extension(&extension)?;
                Some((record.audio_path.clone(), mime))
            }
            "cover" => {
                let cover_path = record.cover_path.as_str();
                if cover_path.is_empty() {
                    return None;
                }
                let path = Path::new(cover_path);
                if !is_path_inside(&self.covers_dir, path) {
                    return None;
                }
                let extension = extension_lower(path);
                let mime = cover_mime_for_extension(&extension)?;
                let mime = if record.cover_mime.is_empty() {
                    mime
                } else {
                    // coverMime 由导入阶段嗅探写入；协议侧仍按扩展名兜底。
                    cover_mime_for_extension(&extension).unwrap_or(mime)
                };
                Some((cover_path.to_owned(), mime))
            }
            _ => None,
        }
    }

    /// 移除指定曲目并持久化。返回移除后的完整快照；无有效 id 时直接返回当前快照。
    pub fn remove_tracks(&mut self, ids: &[String]) -> Result<LibrarySnapshotOutcome, String> {
        let requested: HashSet<String> = ids
            .iter()
            .filter_map(|value| {
                let cleaned = clean_text(value, "", 64).to_lowercase();
                let stripped = cleaned.strip_prefix("local:").unwrap_or(&cleaned);
                is_valid_track_id(stripped).then(|| stripped.to_owned())
            })
            .collect();
        if requested.is_empty() {
            return Ok(self.snapshot());
        }
        let mut next_records = self.records.clone();
        let mut removed_covers = Vec::new();
        for id in &requested {
            if let Some(record) = next_records.remove(id) {
                if !record.cover_path.is_empty() {
                    removed_covers.push(record.cover_path);
                }
            }
        }
        let next_order: Vec<String> = self
            .order
            .iter()
            .filter(|id| next_records.contains_key(*id))
            .cloned()
            .collect();
        self.persist_snapshot(&next_order, &next_records)?;
        self.records = next_records;
        self.order = next_order;
        for cover in removed_covers {
            safe_unlink(Path::new(&cover));
        }
        Ok(self.snapshot())
    }

    /// stage 索引临时文件 → 原子 rename 替换最终索引。
    fn persist_snapshot(
        &self,
        order: &[String],
        records: &HashMap<String, LocalTrackRecord>,
    ) -> Result<PathBuf, String> {
        let staged = self.stage_snapshot(order, records)?;
        if let Err(error) = fs::rename(&staged, &self.index_path) {
            safe_unlink(&staged);
            return Err(format!("LOCAL_LIBRARY_PERSIST_FAILED: {error}"));
        }
        Ok(staged)
    }

    fn stage_snapshot(
        &self,
        order: &[String],
        records: &HashMap<String, LocalTrackRecord>,
    ) -> Result<PathBuf, String> {
        if let Some(parent) = self.index_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("LOCAL_LIBRARY_PERSIST_FAILED: {error}"))?;
        }
        let payload = LocalLibraryIndexFile {
            version: LOCAL_LIBRARY_VERSION,
            updated_at: now_unix_millis(),
            media_token: self.media_token.clone(),
            records: order
                .iter()
                .filter_map(|id| records.get(id).cloned())
                .collect(),
        };
        let text = serde_json::to_string(&payload)
            .map_err(|error| format!("LOCAL_LIBRARY_SERIALIZE_FAILED: {error}"))?;
        if text.len() > MAX_LIBRARY_INDEX_BYTES {
            return Err("LOCAL_LIBRARY_INDEX_TOO_LARGE".to_owned());
        }
        let temp_path = self
            .index_path
            .parent()
            .unwrap_or(Path::new("."))
            .join(format!(
                "{}.{}.{}.tmp",
                LOCAL_LIBRARY_FILE_NAME,
                std::process::id(),
                now_unix_millis()
            ));
        if let Err(error) = fs::write(&temp_path, text.as_bytes()) {
            safe_unlink(&temp_path);
            return Err(format!("LOCAL_LIBRARY_PERSIST_FAILED: {error}"));
        }
        Ok(temp_path)
    }
}

fn urlencode_component(value: &str) -> String {
    // revision / mediaToken 仅含 [0-9a-z-]，无需转义；防御性过滤保留字符。
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn safe_unlink(path: &Path) {
    if path.as_os_str().is_empty() {
        return;
    }
    let _ = fs::remove_file(path);
}

// ---------------------------------------------------------------------------
// 导入流水线
// ---------------------------------------------------------------------------

/// 导入输入项：绝对路径 + 可选 relativePath。
#[derive(Debug, Clone, PartialEq)]
pub struct ImportInput {
    pub path: String,
    pub relative_path: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ImportEntry {
    path: String,
    relative_path: String,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct EntryOutcome {
    record: LocalTrackRecord,
    metadata_error: String,
    cover_warning: String,
    staged_cover_path: Option<PathBuf>,
}

/// 移植 `normalizeImportEntries`：先截断到上限，再按身份去重并净化 relativePath。
pub(crate) fn normalize_import_entries(inputs: Vec<ImportInput>) -> Vec<ImportEntry> {
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for input in inputs.into_iter().take(MAX_IMPORT_FILES) {
        let Some(resolved) = supported_audio_path(&input.path) else {
            continue;
        };
        let identity = identity_of_stored_audio_path(&resolved).unwrap_or_else(|| resolved.clone());
        if !seen.insert(identity) {
            continue;
        }
        let default_relative = file_name_of(&resolved);
        let relative_path = clean_text(
            input.relative_path.as_deref().unwrap_or(""),
            &default_relative,
            RELATIVE_PATH_MAX_LENGTH,
        );
        entries.push(ImportEntry {
            path: resolved,
            relative_path,
        });
    }
    entries
}

fn audio_revision(mtime_ms: u64, size: u64) -> String {
    format!("{}-{}", to_base36(mtime_ms), to_base36(size))
}

fn stat_revision(metadata: &fs::Metadata) -> (u64, u64, String) {
    let size = metadata.len();
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    (mtime_ms, size, audio_revision(mtime_ms, size))
}

struct StageCoverResult {
    cover_path: String,
    cover_mime: String,
    rejected: bool,
    staged_path: Option<PathBuf>,
}

impl StageCoverResult {
    fn empty() -> Self {
        Self {
            cover_path: String::new(),
            cover_mime: String::new(),
            rejected: false,
            staged_path: None,
        }
    }

    fn retained(previous: Option<&LocalTrackRecord>) -> Self {
        Self {
            cover_path: previous
                .map(|record| record.cover_path.clone())
                .unwrap_or_default(),
            cover_mime: previous
                .map(|record| record.cover_mime.clone())
                .unwrap_or_default(),
            rejected: false,
            staged_path: None,
        }
    }
}

/// 移植 `stageCover`：预算校验 → 内容哈希命名 → `.stage` 临时落盘（最终
/// rename 由提交协议统一执行）。
fn stage_cover(
    id: &str,
    picture: Option<&ParsedPicture>,
    previous: Option<&LocalTrackRecord>,
    covers_dir: &Path,
) -> Result<StageCoverResult, String> {
    let Some(picture) = picture else {
        return Ok(StageCoverResult::empty());
    };
    if picture.data.is_empty() {
        return Ok(StageCoverResult::empty());
    }
    let mime: String = sniff_image_kind(&picture.data)
        .map(|kind| kind.mime().to_owned())
        .unwrap_or_else(|| picture.mime.to_lowercase());
    let extension = sniff_image_kind(&picture.data).and_then(ImageKind::cover_extension);
    let Some(extension) = extension else {
        // 未知扩展名：等价上游 unknown-extension 分支，保留旧封面且不计告警。
        return Ok(StageCoverResult::retained(previous));
    };
    if !cover_within_budget(&picture.data) {
        return Ok(StageCoverResult {
            cover_path: previous
                .map(|record| record.cover_path.clone())
                .unwrap_or_default(),
            cover_mime: previous
                .map(|record| record.cover_mime.clone())
                .unwrap_or_default(),
            rejected: true,
            staged_path: None,
        });
    }
    fs::create_dir_all(covers_dir).map_err(|error| format!("LOCAL_COVER_WRITE_FAILED: {error}"))?;
    let digest = sha256_hex(&picture.data)[..16].to_owned();
    let target = covers_dir.join(format!("{id}-{digest}{extension}"));
    if target.exists() {
        return Ok(StageCoverResult {
            cover_path: target.to_string_lossy().into_owned(),
            cover_mime: mime.to_owned(),
            rejected: false,
            staged_path: None,
        });
    }
    let staged = covers_dir.join(format!(
        ".{id}-{digest}.{}.{}.stage",
        std::process::id(),
        now_unix_millis()
    ));
    fs::write(&staged, &picture.data)
        .map_err(|error| format!("LOCAL_COVER_WRITE_FAILED: {error}"))?;
    Ok(StageCoverResult {
        cover_path: target.to_string_lossy().into_owned(),
        cover_mime: mime.to_owned(),
        rejected: false,
        staged_path: Some(staged),
    })
}

type SidecarMaps = HashMap<String, HashMap<String, String>>;

fn sidecar_map_key(directory: &str) -> Option<String> {
    normalized_absolute_file_path(directory)
}

/// 单目录 `.lrc` sidecar 索引：去扩展名小写词干 → lrc 路径。
fn build_sidecar_map_for_directory(directory: &Path) -> HashMap<String, String> {
    let mut lookup = HashMap::new();
    let Ok(read_dir) = fs::read_dir(directory) else {
        return lookup;
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let extension = extension_lower(&path);
        if extension != "lrc" {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
            lookup.insert(stem.to_lowercase(), path.to_string_lossy().into_owned());
        }
    }
    lookup
}

#[allow(clippy::too_many_arguments)]
fn parse_entry_sync(
    entry: &ImportEntry,
    sidecars: &SidecarMaps,
    previous: Option<&LocalTrackRecord>,
    parser: &MetadataParser,
    covers_dir: &Path,
    now_ms: u64,
) -> Result<EntryOutcome, ImportFailure> {
    let metadata_result = fs::metadata(&entry.path);
    let metadata = match metadata_result {
        Ok(value) => value,
        Err(error) => {
            return Err(ImportFailure {
                name: file_name_of(&entry.path),
                error: format!("LOCAL_IMPORT_STAT_FAILED: {}", io_error_label(&error)),
            })
        }
    };
    if !metadata.is_file() {
        return Err(ImportFailure {
            name: file_name_of(&entry.path),
            error: "LOCAL_AUDIO_NOT_FILE".to_owned(),
        });
    }
    let Some(identity) = identity_of_stored_audio_path(&entry.path) else {
        return Err(ImportFailure {
            name: file_name_of(&entry.path),
            error: "LOCAL_IMPORT_PATH_INVALID".to_owned(),
        });
    };
    let id = local_file_id(&identity);
    let parsed = match parser(Path::new(&entry.path)) {
        Ok(value) => (value, String::new()),
        Err(message) => (
            ParsedAudioMetadata::default(),
            truncate_char_bytes(&message, 500),
        ),
    };
    let (parsed_metadata, metadata_error) = parsed;
    let had_error = !metadata_error.is_empty();
    let fallback_title = file_stem_lower(&entry.path);
    let display_fallback_title = file_stem_display(&entry.path);
    let title_fallback = if had_error {
        previous
            .map(|record| record.name.clone())
            .unwrap_or(display_fallback_title.clone())
    } else {
        display_fallback_title
    };
    let artist_fallback = if had_error {
        previous
            .map(|record| record.artist.clone())
            .unwrap_or_default()
    } else {
        "本地文件".to_owned()
    };
    let album_fallback = if had_error {
        previous
            .map(|record| record.album.clone())
            .unwrap_or_default()
    } else {
        fallback_album_from_relative(&entry.relative_path)
    };

    let cover = if had_error {
        StageCoverResult::retained(previous)
    } else {
        match stage_cover(&id, parsed_metadata.picture.as_ref(), previous, covers_dir) {
            Ok(result) => result,
            Err(error) => {
                return Err(ImportFailure {
                    name: file_name_of(&entry.path),
                    error,
                })
            }
        }
    };

    let mut lyric = String::new();
    let mut lyric_source = String::new();
    let directory_key = sidecar_map_key(
        Path::new(&entry.path)
            .parent()
            .and_then(Path::to_str)
            .unwrap_or(""),
    );
    let directory_lookup = directory_key.as_deref().and_then(|key| sidecars.get(key));
    let sidecar_path = directory_lookup.and_then(|lookup| lookup.get(&fallback_title));
    if let Some(sidecar_path) = sidecar_path {
        if let Ok(sidecar_metadata) = fs::metadata(sidecar_path) {
            if sidecar_metadata.is_file()
                && sidecar_metadata.len() > 0
                && sidecar_metadata.len() <= MAX_LYRIC_BYTES as u64
            {
                if let Ok(bytes) = fs::read(sidecar_path) {
                    let decoded =
                        truncate_char_bytes(&decode_lyric_buffer(&bytes), MAX_LYRIC_BYTES);
                    if !decoded.is_empty() {
                        lyric = decoded;
                        lyric_source = "sidecar".to_owned();
                    }
                }
            }
        }
    }
    if lyric.is_empty() {
        if let Some(embedded) = parsed_metadata.lyric_text.as_deref() {
            let cleaned = clean_text(embedded, "", MAX_LYRIC_BYTES);
            if !cleaned.is_empty() {
                lyric = truncate_char_bytes(&cleaned, MAX_LYRIC_BYTES);
                lyric_source = "embedded".to_owned();
            }
        }
    }
    if lyric.is_empty() && had_error {
        if let Some(previous_record) = previous {
            if !previous_record.lyric.is_empty() {
                lyric = previous_record.lyric.clone();
                lyric_source = previous_record.lyric_source.clone();
            }
        }
    }

    let (mtime_ms, size, revision) = stat_revision(&metadata);
    let duration = parsed_metadata
        .duration_secs
        .filter(|value| *value >= 0.0)
        .or_else(|| {
            had_error.then(|| {
                previous
                    .map(|record| record.duration)
                    .filter(|value| *value >= 0.0)
            })?
        })
        .unwrap_or(0.0);

    Ok(EntryOutcome {
        record: LocalTrackRecord {
            id,
            audio_path: entry.path.clone(),
            relative_path: entry.relative_path.clone(),
            name: clean_text(
                parsed_metadata.title.as_deref().unwrap_or(""),
                &title_fallback,
                TEXT_MAX_LENGTH,
            ),
            artist: clean_text(
                parsed_metadata.artist.as_deref().unwrap_or(""),
                &artist_fallback,
                TEXT_MAX_LENGTH,
            ),
            album: clean_text(
                parsed_metadata.album.as_deref().unwrap_or(""),
                &album_fallback,
                TEXT_MAX_LENGTH,
            ),
            duration,
            size,
            mtime_ms,
            revision,
            cover_path: cover.cover_path,
            cover_mime: cover.cover_mime,
            lyric,
            lyric_source,
            imported_at: now_ms,
        },
        metadata_error,
        cover_warning: if cover.rejected {
            "LOCAL_COVER_REJECTED_BY_BUDGET".to_owned()
        } else {
            String::new()
        },
        staged_cover_path: cover.staged_path,
    })
}

fn fallback_album_from_relative(relative_path: &str) -> String {
    let parent = Path::new(relative_path).parent();
    match parent {
        Some(parent) if !parent.as_os_str().is_empty() && parent.as_os_str() != "." => parent
            .components()
            .filter_map(|component| component.as_os_str().to_str())
            .collect::<Vec<_>>()
            .join(" / "),
        _ => String::new(),
    }
}

fn io_error_label(error: &std::io::Error) -> String {
    format!("{:?}", error.kind())
}

struct CommitOutput {
    snapshot: LibrarySnapshotOutcome,
    error: Option<String>,
}

/// 提交协议（锁内执行）：stage 索引 → rename 封面 stage → 最后 rename 索引 →
/// 切换内存映射 → 回收被替换的旧封面。任何失败都会清理临时产物并保持既有状态。
fn commit_import_locked(
    runtime: &mut LocalMusicLibraryRuntime,
    outcomes: Vec<EntryOutcome>,
) -> CommitOutput {
    let mut next_records = runtime.records.clone();
    let mut next_order = runtime.order.clone();
    let mut staged_covers: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut cleanup_after_commit: HashSet<String> = HashSet::new();

    for outcome in outcomes {
        let record = outcome.record;
        if let Some(previous) = next_records.get(&record.id) {
            let previous_cover = previous.cover_path.clone();
            if !previous_cover.is_empty() && previous_cover != record.cover_path {
                cleanup_after_commit.insert(previous_cover);
            }
        }
        next_records.insert(record.id.clone(), record.clone());
        if let Some(position) = next_order.iter().position(|id| id == &record.id) {
            next_order.remove(position);
        }
        next_order.push(record.id.clone());
        if let Some(staged) = outcome.staged_cover_path {
            staged_covers.push((staged, PathBuf::from(&record.cover_path)));
        }
    }

    if next_order.is_empty() {
        for (staged, _) in &staged_covers {
            safe_unlink(staged);
        }
        return CommitOutput {
            snapshot: LibrarySnapshotOutcome::unavailable_inner(),
            error: Some("LOCAL_IMPORT_FAILED".to_owned()),
        };
    }

    let index_temporary: PathBuf = match runtime.stage_snapshot(&next_order, &next_records) {
        Ok(temporary) => temporary,
        Err(code) => {
            for (staged, _) in &staged_covers {
                safe_unlink(staged);
            }
            return CommitOutput {
                snapshot: LibrarySnapshotOutcome::unavailable_inner(),
                error: Some(code),
            };
        }
    };
    let mut created_cover_targets: Vec<PathBuf> = Vec::new();

    for (staged, target) in &staged_covers {
        if target.exists() {
            safe_unlink(staged);
            continue;
        }
        if let Err(error) = fs::rename(staged, target) {
            safe_unlink(&index_temporary);
            for (staged, _) in &staged_covers {
                safe_unlink(staged);
            }
            for target in &created_cover_targets {
                safe_unlink(target);
            }
            return CommitOutput {
                snapshot: LibrarySnapshotOutcome::unavailable_inner(),
                error: Some(format!("LOCAL_LIBRARY_COMMIT_FAILED: {error}")),
            };
        }
        created_cover_targets.push(target.clone());
    }

    if let Err(error) = fs::rename(&index_temporary, &runtime.index_path) {
        safe_unlink(&index_temporary);
        for (staged, _) in &staged_covers {
            safe_unlink(staged);
        }
        for target in &created_cover_targets {
            safe_unlink(target);
        }
        return CommitOutput {
            snapshot: LibrarySnapshotOutcome::unavailable_inner(),
            error: Some(format!("LOCAL_LIBRARY_COMMIT_FAILED: {error}")),
        };
    }

    runtime.records = next_records;
    runtime.order = next_order;
    for cover in cleanup_after_commit {
        safe_unlink(Path::new(&cover));
    }
    CommitOutput {
        snapshot: runtime.snapshot(),
        error: None,
    }
}

impl LibrarySnapshotOutcome {
    fn unavailable_inner() -> Self {
        Self {
            ok: false,
            version: None,
            count: None,
            tracks: Vec::new(),
            error: None,
        }
    }
}

async fn run_bounded<T: Send + 'static>(
    jobs: Vec<Box<dyn FnOnce() -> T + Send>>,
    limit: usize,
) -> Vec<Option<T>> {
    let total = jobs.len();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(limit.max(1)));
    let mut handles = Vec::with_capacity(total);
    for job in jobs {
        let Ok(permit) = semaphore.clone().acquire_owned().await else {
            break;
        };
        handles.push(tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            job()
        }));
    }
    let mut results: Vec<Option<T>> = Vec::with_capacity(total);
    for handle in handles {
        match handle.await {
            Ok(value) => results.push(Some(value)),
            Err(_) => results.push(None),
        }
    }
    while results.len() < total {
        results.push(None);
    }
    results
}

type SidecarJob = Box<dyn FnOnce() -> (String, HashMap<String, String>) + Send>;
type ParseJob = Box<dyn FnOnce() -> (usize, Result<EntryOutcome, ImportFailure>) + Send>;

/// 导入编排：锁外解析（并发 3）→ 锁内原子提交。返回完整库快照与失败明细。
pub async fn import_entries(
    library: &Arc<std::sync::Mutex<LocalMusicLibraryRuntime>>,
    inputs: Vec<ImportInput>,
) -> ImportOutcome {
    let entries = normalize_import_entries(inputs);
    if entries.is_empty() {
        return ImportOutcome::no_supported_audio(Vec::new());
    }

    let context = {
        let guard = match library.lock() {
            Ok(value) => value,
            Err(_) => return ImportOutcome::code("LOCAL_LIBRARY_LOCK_POISONED"),
        };
        ImportContext {
            previous_records: guard.records.clone(),
            parser: Arc::clone(&guard.metadata_parser),
            covers_dir: guard.covers_dir.clone(),
        }
    };

    // 每个不同父目录构建一次 .lrc 索引（并发 3）。
    let mut seen_directories = HashSet::new();
    let mut directory_jobs: Vec<SidecarJob> = Vec::new();
    for entry in &entries {
        let Some(parent) = Path::new(&entry.path).parent() else {
            continue;
        };
        let Some(key) = sidecar_map_key(&parent.to_string_lossy()) else {
            continue;
        };
        if !seen_directories.insert(key.clone()) {
            continue;
        }
        let parent = parent.to_path_buf();
        directory_jobs.push(Box::new(move || {
            let map = build_sidecar_map_for_directory(&parent);
            (key, map)
        }));
    }
    let built_maps = run_bounded(directory_jobs, METADATA_CONCURRENCY).await;
    let sidecars: Arc<SidecarMaps> = Arc::new(
        built_maps
            .into_iter()
            .flatten()
            .collect::<HashMap<String, HashMap<String, String>>>(),
    );

    // 逐文件解析（信号量限流并发 3，阻塞解析放入专用线程池）。
    let now_ms = now_unix_millis();
    let mut parse_jobs: Vec<ParseJob> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let previous = entry.identity().and_then(|identity| {
            context
                .previous_records
                .get(&local_file_id(&identity))
                .cloned()
        });
        let entry = entry.clone();
        let parser = Arc::clone(&context.parser);
        let covers_dir = context.covers_dir.clone();
        let sidecars = Arc::clone(&sidecars);
        parse_jobs.push(Box::new(move || {
            (
                index,
                parse_entry_sync(
                    &entry,
                    &sidecars,
                    previous.as_ref(),
                    &parser,
                    &covers_dir,
                    now_ms,
                ),
            )
        }));
    }
    let parsed_results = run_bounded(parse_jobs, METADATA_CONCURRENCY).await;
    drop(sidecars);
    let mut slots: Vec<Option<Result<EntryOutcome, ImportFailure>>> =
        (0..entries.len()).map(|_| None).collect();
    for (index, result) in parsed_results.into_iter().flatten() {
        slots[index] = Some(result);
    }

    let mut outcomes: Vec<EntryOutcome> = Vec::new();
    let mut failures: Vec<ImportFailure> = Vec::new();
    let mut warnings: Vec<MetadataWarning> = Vec::new();
    for slot in slots {
        match slot {
            Some(Ok(outcome)) => {
                let track_name = file_name_of(&outcome.record.audio_path);
                if !outcome.metadata_error.is_empty() {
                    warnings.push(MetadataWarning {
                        name: track_name.clone(),
                        error: outcome.metadata_error.clone(),
                    });
                }
                if !outcome.cover_warning.is_empty() {
                    warnings.push(MetadataWarning {
                        name: track_name,
                        error: outcome.cover_warning.clone(),
                    });
                }
                outcomes.push(outcome);
            }
            Some(Err(failure)) => failures.push(failure),
            None => {}
        }
    }

    // 提交阶段在锁内完成（阻塞 IO 放入专用线程池）。
    let commit_library = Arc::clone(library);
    let commit = tauri::async_runtime::spawn_blocking(move || {
        let mut guard = match commit_library.lock() {
            Ok(value) => value,
            Err(_) => {
                return CommitOutput {
                    snapshot: LibrarySnapshotOutcome::unavailable_inner(),
                    error: Some("LOCAL_LIBRARY_LOCK_POISONED".to_owned()),
                }
            }
        };
        commit_import_locked(&mut guard, outcomes)
    });
    let output = match commit.await {
        Ok(output) => output,
        Err(_) => CommitOutput {
            snapshot: LibrarySnapshotOutcome::unavailable_inner(),
            error: Some("LOCAL_LIBRARY_COMMIT_FAILED".to_owned()),
        },
    };

    if output.error.is_none() {
        return ImportOutcome {
            ok: true,
            version: output.snapshot.version,
            count: output.snapshot.count,
            tracks: output.snapshot.tracks,
            failures,
            metadata_warnings: warnings,
            error: None,
        };
    }
    if output.error.as_deref() == Some("LOCAL_IMPORT_FAILED") {
        // 全部条目失败且库为空：保留失败与告警明细。
        return ImportOutcome {
            ok: false,
            version: None,
            count: Some(0),
            tracks: Vec::new(),
            failures,
            metadata_warnings: warnings,
            error: Some("LOCAL_IMPORT_FAILED".to_owned()),
        };
    }
    ImportOutcome::code(output.error.as_deref().unwrap_or("LOCAL_IMPORT_FAILED"))
}

struct ImportContext {
    previous_records: HashMap<String, LocalTrackRecord>,
    parser: MetadataParser,
    covers_dir: PathBuf,
}

impl ImportEntry {
    fn identity(&self) -> Option<String> {
        identity_of_stored_audio_path(&self.path)
    }
}

// ---------------------------------------------------------------------------
// mineradio-local 自定义协议响应构造
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ByteRange {
    start: u64,
    end: u64,
}

enum RangeParse {
    NoRange,
    Valid(ByteRange),
    Invalid,
}

/// 移植上游 `parseByteRange`（含 `bytes=-N` 后缀语义；size<=0 时任何 Range 均无效）。
fn parse_byte_range(value: Option<&str>, size: u64) -> RangeParse {
    let Some(text) = value.map(str::trim).filter(|text| !text.is_empty()) else {
        return RangeParse::NoRange;
    };
    let lowered = text.to_ascii_lowercase();
    let Some(spec) = lowered.strip_prefix("bytes=").map(|_| &text[6..]) else {
        return RangeParse::Invalid;
    };
    if size == 0 {
        return RangeParse::Invalid;
    }
    let Some((start_text, end_text)) = spec.split_once('-') else {
        return RangeParse::Invalid;
    };
    if start_text.is_empty() && end_text.is_empty() {
        return RangeParse::Invalid;
    }
    if start_text.is_empty() {
        let Ok(suffix) = end_text.parse::<u64>() else {
            return RangeParse::Invalid;
        };
        if suffix == 0 {
            return RangeParse::Invalid;
        }
        let start = size.saturating_sub(suffix.min(size));
        return RangeParse::Valid(ByteRange {
            start,
            end: size - 1,
        });
    }
    let Ok(start) = start_text.parse::<u64>() else {
        return RangeParse::Invalid;
    };
    let end = match end_text.parse::<u64>() {
        Ok(value) => value.min(size - 1),
        Err(_) if end_text.is_empty() => size - 1,
        Err(_) => return RangeParse::Invalid,
    };
    if end < start || start >= size {
        return RangeParse::Invalid;
    }
    RangeParse::Valid(ByteRange { start, end })
}

/// CORS 白名单：http://127.0.0.1:* / http://tauri.localhost / https://tauri.localhost。
fn cors_allowed_origin(origin: &str) -> bool {
    let origin = origin.trim();
    if let Some(port) = origin.strip_prefix("http://127.0.0.1:") {
        return !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit());
    }
    origin.eq_ignore_ascii_case("http://tauri.localhost")
        || origin.eq_ignore_ascii_case("https://tauri.localhost")
}

/// 路由：/{kind}/{id}，查询串取 cap。id 大写 hex 归一为小写。
fn parse_local_route(path: &str, query: Option<&str>) -> Option<(&'static str, String, String)> {
    let mut segments = path.trim_matches('/').split('/');
    let kind = match segments.next()? {
        "audio" => "audio",
        "cover" => "cover",
        _ => return None,
    };
    let raw_id = segments.next()?;
    segments.next().is_none().then_some(())?;
    let id = raw_id.to_lowercase();
    if !is_valid_track_id(&id) {
        return None;
    }
    let mut cap = String::new();
    for pair in query.unwrap_or_default().split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key == "cap" {
            cap = value.to_owned();
        }
    }
    Some((kind, id, cap))
}

fn error_response(status: StatusCode, code: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(code.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 协议入口：方法校验 → cap/路由校验 → stat → Range → 头部 → 分块读取。
/// `runtime` 为 None（状态缺失）时一律 404。
pub fn build_local_media_response(
    request: Request<Vec<u8>>,
    runtime: Option<&LocalMusicLibraryRuntime>,
) -> Response<Vec<u8>> {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header("Allow", "GET, HEAD")
            .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
            .body(b"Method not allowed".to_vec())
            .unwrap_or_else(|_| Response::new(Vec::new()));
    }
    let Some((kind, id, cap)) = parse_local_route(request.uri().path(), request.uri().query())
    else {
        return error_response(StatusCode::NOT_FOUND, "Not found");
    };
    let Some(runtime) = runtime else {
        return error_response(StatusCode::NOT_FOUND, "Not found");
    };
    let Some((file_path, content_type)) = runtime.resolve_media(kind, &id, &cap) else {
        return error_response(StatusCode::NOT_FOUND, "Not found");
    };
    let metadata = match fs::metadata(&file_path) {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return error_response(StatusCode::NOT_FOUND, "Not found"),
    };
    let size = metadata.len();
    let range_header = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok());
    let range = match parse_byte_range(range_header, size) {
        RangeParse::NoRange => None,
        RangeParse::Valid(range) => Some(range),
        RangeParse::Invalid => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(CONTENT_RANGE, format!("bytes */{size}"))
                .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
                .body(Vec::new())
                .unwrap_or_else(|_| Response::new(Vec::new()));
        }
    };
    let (start, end) = range
        .map(|range| (range.start, range.end))
        .unwrap_or((0, size.saturating_sub(1)));
    let content_length = if size == 0 { 0 } else { end - start + 1 };
    let mut builder = Response::builder()
        .status(if range.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(CONTENT_TYPE, content_type)
        .header(CONTENT_LENGTH, content_length.to_string())
        .header(ACCEPT_RANGES, "bytes")
        .header(CACHE_CONTROL, "private, max-age=300")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff");
    if let Some(origin) = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .filter(|origin| cors_allowed_origin(origin))
    {
        builder = builder
            .header(ACCESS_CONTROL_ALLOW_ORIGIN, origin)
            .header(VARY, "Origin");
    }
    if let Some(range) = range {
        builder = builder.header(
            CONTENT_RANGE,
            format!("bytes {}-{}/{}", range.start, range.end, size),
        );
    }
    let body = if request.method() == Method::HEAD || size == 0 {
        Vec::new()
    } else {
        match read_file_chunked(Path::new(&file_path), start, content_length) {
            Ok(bytes) => bytes,
            Err(_) => {
                return error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "LOCAL_MEDIA_READ_FAILED",
                );
            }
        }
    };
    builder
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// seek + 定长块循环读取，绝不整文件载入内存。
fn read_file_chunked(path: &Path, start: u64, length: u64) -> std::io::Result<Vec<u8>> {
    let mut file = fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut buffer = Vec::with_capacity(length.min(u64::from(u32::MAX)) as usize);
    let mut remaining = length;
    while remaining > 0 {
        let chunk = remaining.min(MEDIA_READ_CHUNK_BYTES) as usize;
        let mut block = vec![0u8; chunk];
        file.read_exact(&mut block)?;
        buffer.extend_from_slice(&block);
        remaining -= chunk as u64;
    }
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        sync::atomic::{AtomicU64, Ordering},
        time::{Duration, SystemTime},
    };

    const PNG_1X1_BYTES: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8,
        0xCF, 0xC0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D, 0xB0, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    fn unique_test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "mineradio-local-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("系统时间应有效")
                .as_nanos()
        ))
    }

    fn write_fixture(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("应创建 fixture 目录");
        }
        let mut file = fs::File::create(path).expect("应创建 fixture 文件");
        file.write_all(contents).expect("应写入 fixture 内容");
    }

    // -----------------------------------------------------------------------
    // 身份与修订号
    // -----------------------------------------------------------------------

    #[test]
    fn identity_is_canonical_lowercased_sha256_prefix_and_rejects_unc_paths() {
        let root = unique_test_root("identity");
        let song = root.join("MuSiC").join("SoNg.MP3");
        write_fixture(&song, b"audio");

        let identity =
            supported_audio_path(song.to_string_lossy().as_ref()).expect("受支持的音频应产生身份");
        #[cfg(windows)]
        assert_eq!(identity, identity.to_lowercase());
        assert!(identity.ends_with("music\\song.mp3") || identity.ends_with("music/song.mp3"));

        let id = local_file_id(&identity);
        assert_eq!(id.len(), 24);
        assert!(is_valid_track_id(&id));
        let expected = sha256_hex(identity.as_bytes())[..24].to_owned();
        assert_eq!(id, expected);

        let again = supported_audio_path(song.to_string_lossy().as_ref()).expect("幂等身份");
        assert_eq!(again, identity);

        assert!(supported_audio_path(r"\\server\share\song.mp3").is_none());
        assert!(supported_audio_path("//server/share/song.mp3").is_none());
        assert!(supported_audio_path("").is_none());
        assert!(supported_audio_path("relative/song.mp3").is_none());
        assert!(supported_audio_path("C:\\not\\supported.txt").is_none());

        fs::remove_dir_all(root).expect("应清理测试目录");
    }

    #[test]
    fn revision_uses_base36_of_mtime_and_size() {
        assert_eq!(to_base36(0), "0");
        assert_eq!(to_base36(35), "z");
        assert_eq!(to_base36(36), "10");
        assert_eq!(audio_revision(0, 0), "0-0");
        assert_eq!(audio_revision(35, 36), "z-10");

        let root = unique_test_root("revision");
        let song = root.join("song.mp3");
        write_fixture(&song, b"0123456789");
        let modified = UNIX_EPOCH + Duration::from_millis(1_700_000_001_234);
        let handle = fs::OpenOptions::new()
            .write(true)
            .open(&song)
            .expect("打开 fixture");
        handle
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .expect("设置 mtime");
        drop(handle);

        let metadata = fs::metadata(&song).expect("stat fixture");
        let (mtime_ms, size, revision) = stat_revision(&metadata);
        assert_eq!(mtime_ms, 1_700_000_001_234);
        assert_eq!(size, 10);
        assert_eq!(
            revision,
            format!("{}-{}", to_base36(1_700_000_001_234), to_base36(10))
        );

        fs::remove_dir_all(root).expect("应清理测试目录");
    }

    // -----------------------------------------------------------------------
    // 歌词解码
    // -----------------------------------------------------------------------

    #[test]
    fn lrc_decode_handles_utf8_bom_utf16le_swapped_be_and_gb18030() {
        assert_eq!(
            decode_lyric_buffer(b"\xEF\xBB\xBF[00:01.000]\xE6\xAD\x8C"),
            "[00:01.000]歌"
        );

        let utf16le: Vec<u8> = std::iter::once(0xFFu8)
            .chain(std::iter::once(0xFEu8))
            .chain("[00:12.500]你好".encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        assert_eq!(decode_lyric_buffer(&utf16le), "[00:12.500]你好");

        let swapped: Vec<u8> = std::iter::once(0xFEu8)
            .chain(std::iter::once(0xFFu8))
            .chain("世界".encode_utf16().flat_map(|unit| {
                let [low, high] = unit.to_le_bytes();
                [high, low]
            }))
            .collect();
        assert_eq!(decode_lyric_buffer(&swapped), "世界");

        let (gb_bytes, _, had_errors) = encoding_rs::GB18030.encode("歌测试GB");
        assert!(!had_errors);
        assert_eq!(decode_lyric_buffer(gb_bytes.as_ref()), "歌测试GB");

        assert_eq!(decode_lyric_buffer(b"\x00ab\x00c\x00"), "abc");
        assert_eq!(decode_lyric_buffer(b""), "");
    }

    // -----------------------------------------------------------------------
    // 封面预算与图片尺寸
    // -----------------------------------------------------------------------

    #[test]
    fn cover_budget_accepts_small_png_and_rejects_oversized_or_unknown_large_data() {
        assert!(cover_within_budget(PNG_1X1_BYTES));

        // 宽高超 4096 的 PNG（IHDR 中宽高写为 5000）。
        let mut oversized = PNG_1X1_BYTES.to_vec();
        oversized[16..20].copy_from_slice(&5000u32.to_be_bytes());
        oversized[20..24].copy_from_slice(&5000u32.to_be_bytes());
        assert!(!cover_within_budget(&oversized));

        // 4096 x 4096 = 16M 像素 > 12M 上限。
        let mut too_many_pixels = PNG_1X1_BYTES.to_vec();
        too_many_pixels[16..20].copy_from_slice(&4096u32.to_be_bytes());
        too_many_pixels[20..24].copy_from_slice(&4096u32.to_be_bytes());
        assert!(!cover_within_budget(&too_many_pixels));

        // 无法解析尺寸：>1MiB 拒绝，<=1MiB 接受。
        let junk: Vec<u8> =
            std::iter::repeat_n(0xA5u8, MAX_UNKNOWN_DIMENSION_COVER_BYTES + 1).collect();
        assert!(!cover_within_budget(&junk));
        let small_junk = vec![0xA5u8; 1024];
        assert!(cover_within_budget(&small_junk));

        assert!(!cover_within_budget(&[]));
        assert!(!cover_within_budget(&vec![0xFFu8; MAX_COVER_BYTES + 1]));
    }

    #[test]
    fn image_dimensions_parses_gif_bmp_jpeg_and_webp_headers() {
        let gif = [b'G', b'I', b'F', b'8', b'9', b'a', 0x64, 0x00, 0x32, 0x00];
        assert_eq!(image_dimensions(ImageKind::Gif, &gif), Some((100, 50)));

        let mut bmp = vec![0u8; 26];
        bmp[0] = b'B';
        bmp[1] = b'M';
        bmp[18..22].copy_from_slice(&(-300i32).to_le_bytes());
        bmp[22..26].copy_from_slice(&(200i32).to_le_bytes());
        assert_eq!(image_dimensions(ImageKind::Bmp, &bmp), Some((300, 200)));

        let jpeg = [
            0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x22,
            0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xDA,
        ];
        assert_eq!(image_dimensions(ImageKind::Jpeg, &jpeg), Some((3, 2)));

        let mut webp = vec![0u8; 30];
        webp[0..4].copy_from_slice(b"RIFF");
        webp[8..12].copy_from_slice(b"WEBP");
        webp[12..16].copy_from_slice(b"VP8X");
        webp[24..27].copy_from_slice(&99u32.to_le_bytes()[..3]);
        webp[27..30].copy_from_slice(&49u32.to_le_bytes()[..3]);
        assert_eq!(image_dimensions(ImageKind::Webp, &webp), Some((100, 50)));
    }

    // -----------------------------------------------------------------------
    // Range 解析
    // -----------------------------------------------------------------------

    #[test]
    fn range_parser_supports_open_suffix_and_rejects_invalid_specs() {
        fn valid(value: &str, size: u64) -> Option<(u64, u64)> {
            match parse_byte_range(Some(value), size) {
                RangeParse::Valid(range) => Some((range.start, range.end)),
                _ => None,
            }
        }
        assert_eq!(valid("bytes=2-5", 10), Some((2, 5)));
        assert_eq!(valid("bytes=6-", 10), Some((6, 9)));
        assert_eq!(valid("bytes=-4", 10), Some((6, 9)));
        assert_eq!(valid("bytes=-999", 10), Some((0, 9)));
        assert_eq!(valid("BYTES=0-9", 10), Some((0, 9)));
        assert_eq!(valid("", 10), None);
        assert_eq!(valid("bytes=", 10), None);
        assert_eq!(valid("bytes=-0", 10), None);
        assert_eq!(valid("bytes=0-1,4-5", 10), None);
        assert_eq!(valid("bytes=10-", 10), None);
        assert_eq!(valid("bytes=5-2", 10), None);
        assert_eq!(valid("bytes=x-y", 10), None);
        assert_eq!(valid("bytes=-", 10), None);
        assert!(matches!(
            parse_byte_range(Some("bytes=0-"), 0),
            RangeParse::Invalid
        ));
        assert!(matches!(parse_byte_range(None, 10), RangeParse::NoRange));
    }

    // -----------------------------------------------------------------------
    // 导入 → 持久化 → 重载
    // -----------------------------------------------------------------------

    fn counting_parser(counter: Arc<AtomicU64>, picture: Option<ParsedPicture>) -> MetadataParser {
        Arc::new(move |_path| {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(ParsedAudioMetadata {
                title: Some("标题".to_owned()),
                artist: Some("歌手".to_owned()),
                album: Some("专辑".to_owned()),
                duration_secs: Some(12.5),
                lyric_text: Some("[00:01.000]歌词".to_owned()),
                picture: picture.clone(),
            })
        })
    }

    fn failing_parser() -> MetadataParser {
        Arc::new(|_path| Err("SHOULD_NOT_PARSE".to_owned()))
    }

    #[test]
    fn import_persists_index_and_reload_does_not_reparse_metadata() {
        let root = unique_test_root("reload");
        let song = root.join("music").join("song.mp3");
        write_fixture(&song, b"fake mp3 bytes");

        let counter = Arc::new(AtomicU64::new(0));
        let parser = counting_parser(Arc::clone(&counter), None);
        let runtime = Arc::new(std::sync::Mutex::new(
            LocalMusicLibraryRuntime::with_metadata_parser(&root, parser),
        ));

        let outcome = tauri::async_runtime::block_on(async {
            import_entries(
                &runtime,
                vec![ImportInput {
                    path: song.to_string_lossy().into_owned(),
                    relative_path: Some("music/song.mp3".to_owned()),
                }],
            )
            .await
        });
        assert!(outcome.ok, "导入应成功: {outcome:?}");
        assert_eq!(outcome.version, Some(LOCAL_LIBRARY_VERSION));
        assert_eq!(outcome.count, Some(1));
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        assert!(outcome.failures.is_empty());
        assert!(outcome.metadata_warnings.is_empty());

        let track = &outcome.tracks[0];
        assert_eq!(track.name, "标题");
        assert_eq!(track.title, "标题");
        assert_eq!(track.artist, "歌手");
        assert_eq!(track.album, "专辑");
        assert!((track.duration - 12.5).abs() < f64::EPSILON);
        assert_eq!(track.local_path, "music/song.mp3");
        assert!(track.has_lyric);
        assert_eq!(track.lyric_source, "embedded");
        assert!(track.cover.is_empty());
        assert_eq!(track.track_type, "local");
        assert_eq!(track.source, "local");
        assert_eq!(track.provider, "local");
        assert!(track.id.starts_with("local:"));
        let raw_id = track.local_file_id.clone();
        assert!(track.local_url.contains(&format!("/audio/{raw_id}?")));
        assert!(track.local_url.contains("cap="));
        assert!(!track.local_missing);

        let snapshot_before = runtime.lock().expect("runtime").snapshot();
        let index_bytes = fs::read(root.join(LOCAL_LIBRARY_FILE_NAME)).expect("索引应存在");
        let index_text = String::from_utf8(index_bytes).expect("索引应为 UTF-8 JSON");
        let parsed_index: serde_json::Value =
            serde_json::from_str(&index_text).expect("索引应为合法 JSON");
        assert_eq!(parsed_index["version"], 1);
        assert!(parsed_index["mediaToken"].as_str().unwrap_or("").len() == 48);
        assert!(parsed_index["records"].as_array().is_some());

        // 重载实例：解析器一旦被调用即失败，证明重载不重新解析元数据。
        let reloaded = LocalMusicLibraryRuntime::with_metadata_parser(&root, failing_parser());
        let snapshot_after = reloaded.snapshot();
        let before = serde_json::to_value(&snapshot_before).expect("序列化快照");
        let after = serde_json::to_value(&snapshot_after).expect("序列化快照");
        assert_eq!(before, after);
        assert_eq!(counter.load(Ordering::SeqCst), 1);

        fs::remove_dir_all(root).expect("应清理测试目录");
    }

    #[test]
    fn corrupt_or_version_mismatched_indexes_start_empty_with_fresh_token() {
        let root = unique_test_root("corrupt");
        fs::create_dir_all(&root).expect("创建根目录");

        let first = LocalMusicLibraryRuntime::open(&root);
        let baseline_token = first.media_token().to_owned();
        drop(first);

        let index_path = root.join(LOCAL_LIBRARY_FILE_NAME);
        fs::write(&index_path, "{not json").expect("写入损坏索引");
        let corrupted = LocalMusicLibraryRuntime::open(&root);
        assert_eq!(corrupted.snapshot().count, Some(0), "损坏索引应回退为空库");
        assert_ne!(corrupted.media_token(), baseline_token);
        drop(corrupted);

        fs::write(
            &index_path,
            r#"{"version":2,"updatedAt":1,"mediaToken":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","records":[]}"#,
        )
        .expect("写入错误版本索引");
        let wrong_version = LocalMusicLibraryRuntime::open(&root);
        assert_eq!(wrong_version.snapshot().count, Some(0));

        // id 与路径哈希不匹配的记录必须被丢弃。
        let song = root.join("song.mp3");
        write_fixture(&song, b"x");
        let identity = supported_audio_path(song.to_string_lossy().as_ref()).expect("身份");
        let real_id = local_file_id(&identity);
        let bogus_record = format!(
            r#"{{"id":"{}","audioPath":"{}","relativePath":"song.mp3","name":"n","artist":"a","album":"","duration":1,"size":1,"mtimeMs":1,"revision":"1-1","coverPath":"","coverMime":"","lyric":"","lyricSource":"","importedAt":1}}"#,
            "f".repeat(24),
            identity.replace('\\', "\\\\")
        );
        let good_record = format!(
            r#"{{"id":"{real_id}","audioPath":"{}","relativePath":"song.mp3","name":"保留","artist":"本地文件","album":"","duration":3,"size":1,"mtimeMs":1,"revision":"1-1","coverPath":"","coverMime":"","lyric":"","lyricSource":"","importedAt":1}}"#,
            identity.replace('\\', "\\\\")
        );
        fs::write(
            &index_path,
            format!(
                r#"{{"version":1,"updatedAt":5,"mediaToken":"{}","records":[{bogus_record},{good_record}]}}"#,
                "b".repeat(48)
            ),
        )
        .expect("写入混合索引");
        let mixed = LocalMusicLibraryRuntime::open(&root);
        assert_eq!(mixed.snapshot().count, Some(1));
        assert_eq!(mixed.snapshot().tracks[0].name, "保留");
        // 采用持久化 token。
        assert_eq!(mixed.media_token(), &"b".repeat(48));

        fs::remove_dir_all(root).expect("应清理测试目录");
    }

    #[test]
    fn remove_tracks_persists_and_unlinks_covers() {
        let root = unique_test_root("remove");
        let song = root.join("song.mp3");
        write_fixture(&song, b"with cover");
        let counter = Arc::new(AtomicU64::new(0));
        let parser = counting_parser(
            Arc::clone(&counter),
            Some(ParsedPicture {
                mime: "image/png".to_owned(),
                data: PNG_1X1_BYTES.to_vec(),
            }),
        );
        let runtime = Arc::new(std::sync::Mutex::new(
            LocalMusicLibraryRuntime::with_metadata_parser(&root, parser),
        ));
        let outcome = tauri::async_runtime::block_on(async {
            import_entries(
                &runtime,
                vec![ImportInput {
                    path: song.to_string_lossy().into_owned(),
                    relative_path: None,
                }],
            )
            .await
        });
        assert!(outcome.ok, "导入应成功: {outcome:?}");
        let track = outcome.tracks[0].clone();
        assert!(track.cover.contains("/cover/"));

        let covers_dir = root
            .join(LOCAL_LIBRARY_DIRECTORY_NAME)
            .join(LOCAL_COVER_DIRECTORY_NAME);
        let cover_files: Vec<_> = fs::read_dir(&covers_dir)
            .expect("covers 目录应存在")
            .flatten()
            .collect();
        assert_eq!(cover_files.len(), 1, "封面应已提交落盘");

        // local: 前缀 + 大写输入都应被归一。
        let uppercase = format!("local:{}", track.local_file_id.to_uppercase());
        let removed = {
            let mut guard = runtime.lock().expect("runtime");
            guard.remove_tracks(std::slice::from_ref(&uppercase))
        }
        .expect("移除应成功");
        assert_eq!(removed.count, Some(0));
        let remaining: Vec<_> = fs::read_dir(&covers_dir)
            .expect("covers 目录仍应存在")
            .flatten()
            .collect();
        assert!(remaining.is_empty(), "封面应在提交后回收");

        // 无有效 id 时返回当前快照而不持久化。
        let noop = {
            let mut guard = runtime.lock().expect("runtime");
            guard.remove_tracks(&["bad-id".to_owned()])
        }
        .expect("无效 id 应直接返回快照");
        assert_eq!(noop.count, Some(0));
        assert!(noop.ok);

        fs::remove_dir_all(root).expect("应清理测试目录");
    }

    // -----------------------------------------------------------------------
    // 协议响应构造
    // -----------------------------------------------------------------------

    fn protocol_fixture() -> (
        PathBuf,
        Arc<std::sync::Mutex<LocalMusicLibraryRuntime>>,
        String,
        String,
    ) {
        let root = unique_test_root("protocol");
        let song = root.join("audio").join("track.mp3");
        write_fixture(&song, b"0123456789");
        let counter = Arc::new(AtomicU64::new(0));
        let runtime = Arc::new(std::sync::Mutex::new(
            LocalMusicLibraryRuntime::with_metadata_parser(&root, counting_parser(counter, None)),
        ));
        let outcome = tauri::async_runtime::block_on(async {
            import_entries(
                &runtime,
                vec![ImportInput {
                    path: song.to_string_lossy().into_owned(),
                    relative_path: None,
                }],
            )
            .await
        });
        assert!(outcome.ok, "协议 fixture 导入应成功");
        let id = outcome.tracks[0].local_file_id.clone();
        let token = runtime.lock().expect("runtime").media_token().to_owned();
        (root, runtime, id, token)
    }

    fn build_request(method: Method, uri: &str, origin: Option<&str>) -> Request<Vec<u8>> {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(origin) = origin {
            builder = builder.header("origin", origin);
        }
        builder.body(Vec::new()).expect("请求应有效")
    }

    fn audio_uri(id: &str, token: &str) -> String {
        format!("http://mineradio-local.localhost/audio/{id}?v=1-3&cap={token}")
    }

    fn request_with_range(
        method: Method,
        uri: &str,
        range: &str,
        origin: Option<&str>,
    ) -> Request<Vec<u8>> {
        let mut builder = Request::builder().method(method).uri(uri);
        if !range.is_empty() {
            builder = builder.header("range", range);
        }
        if let Some(origin) = origin {
            builder = builder.header("origin", origin);
        }
        builder.body(Vec::new()).expect("请求应有效")
    }

    #[test]
    fn protocol_serves_full_and_partial_audio_responses() {
        let (root, runtime, id, token) = protocol_fixture();
        let guard = runtime.lock().expect("runtime");

        let full = build_local_media_response(
            build_request(Method::GET, &audio_uri(&id, &token), None),
            Some(&guard),
        );
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.body().as_slice(), b"0123456789");
        assert_eq!(full.headers()["content-type"], "audio/mpeg");
        assert_eq!(full.headers()["content-length"], "10");
        assert_eq!(full.headers()["accept-ranges"], "bytes");
        assert_eq!(full.headers()["cache-control"], "private, max-age=300");
        assert_eq!(
            full.headers()["cross-origin-resource-policy"],
            "cross-origin"
        );
        assert_eq!(full.headers()["x-content-type-options"], "nosniff");

        let partial = build_local_media_response(
            request_with_range(Method::GET, &audio_uri(&id, &token), "bytes=2-5", None),
            Some(&guard),
        );
        assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(partial.body().as_slice(), b"2345");
        assert_eq!(partial.headers()["content-range"], "bytes 2-5/10");

        let suffix = build_local_media_response(
            request_with_range(Method::GET, &audio_uri(&id, &token), "bytes=-4", None),
            Some(&guard),
        );
        assert_eq!(suffix.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(suffix.body().as_slice(), b"6789");
        assert_eq!(suffix.headers()["content-range"], "bytes 6-9/10");

        fs::remove_dir_all(root).expect("应清理测试目录");
    }

    #[test]
    fn protocol_rejects_bad_methods_tokens_routes_and_ranges() {
        let (root, runtime, id, token) = protocol_fixture();
        let guard = runtime.lock().expect("runtime");

        let post = build_local_media_response(
            build_request(Method::POST, &audio_uri(&id, &token), None),
            Some(&guard),
        );
        assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(post.headers()["allow"], "GET, HEAD");
        assert_eq!(post.headers()["x-content-type-options"], "nosniff");

        let wrong_cap = build_local_media_response(
            build_request(
                Method::GET,
                &audio_uri(&id, "000000000000000000000000000000000000000000000000"),
                None,
            ),
            Some(&guard),
        );
        assert_eq!(wrong_cap.status(), StatusCode::NOT_FOUND);
        assert_eq!(wrong_cap.headers()["x-content-type-options"], "nosniff");

        let unknown_id = build_local_media_response(
            build_request(Method::GET, &audio_uri(&"c".repeat(24), &token), None),
            Some(&guard),
        );
        assert_eq!(unknown_id.status(), StatusCode::NOT_FOUND);

        let bad_route = build_local_media_response(
            build_request(
                Method::GET,
                &format!("http://mineradio-local.localhost/other/{id}?cap={token}"),
                None,
            ),
            Some(&guard),
        );
        assert_eq!(bad_route.status(), StatusCode::NOT_FOUND);

        let unsatisfiable = build_local_media_response(
            request_with_range(Method::GET, &audio_uri(&id, &token), "bytes=99-", None),
            Some(&guard),
        );
        assert_eq!(unsatisfiable.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(unsatisfiable.headers()["content-range"], "bytes */10");

        let head = build_local_media_response(
            build_request(Method::HEAD, &audio_uri(&id, &token), None),
            Some(&guard),
        );
        assert_eq!(head.status(), StatusCode::OK);
        assert!(head.body().is_empty());
        assert_eq!(head.headers()["content-length"], "10");

        // 状态缺失（None）一律 404。
        let missing_state = build_local_media_response(
            build_request(Method::GET, &audio_uri(&id, &token), None),
            None,
        );
        assert_eq!(missing_state.status(), StatusCode::NOT_FOUND);

        fs::remove_dir_all(root).expect("应清理测试目录");
    }

    #[test]
    fn protocol_reflects_only_allowlisted_cors_origins() {
        let (root, runtime, id, token) = protocol_fixture();
        let guard = runtime.lock().expect("runtime");

        for allowed in [
            "http://127.0.0.1:5173",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ] {
            let response = build_local_media_response(
                request_with_range(Method::GET, &audio_uri(&id, &token), "", Some(allowed)),
                Some(&guard),
            );
            assert_eq!(
                response.headers()["access-control-allow-origin"],
                allowed,
                "白名单 Origin 应被回显"
            );
            assert_eq!(response.headers()["vary"], "Origin");
        }

        for denied in ["http://evil.example", "http://127.0.0.1.evil.com"] {
            let response = build_local_media_response(
                request_with_range(Method::GET, &audio_uri(&id, &token), "", Some(denied)),
                Some(&guard),
            );
            assert!(response
                .headers()
                .get("access-control-allow-origin")
                .is_none());
            assert!(response.headers().get("vary").is_none());
        }

        fs::remove_dir_all(root).expect("应清理测试目录");
    }

    #[test]
    fn protocol_serves_cover_files_inside_covers_directory() {
        let root = unique_test_root("protocol-cover");
        let song = root.join("song.mp3");
        write_fixture(&song, b"cover carrier");
        let counter = Arc::new(AtomicU64::new(0));
        let runtime = Arc::new(std::sync::Mutex::new(
            LocalMusicLibraryRuntime::with_metadata_parser(
                &root,
                counting_parser(
                    counter,
                    Some(ParsedPicture {
                        mime: "image/png".to_owned(),
                        data: PNG_1X1_BYTES.to_vec(),
                    }),
                ),
            ),
        ));
        let outcome = tauri::async_runtime::block_on(async {
            import_entries(
                &runtime,
                vec![ImportInput {
                    path: song.to_string_lossy().into_owned(),
                    relative_path: None,
                }],
            )
            .await
        });
        assert!(outcome.ok);
        let id = outcome.tracks[0].local_file_id.clone();
        let token = runtime.lock().expect("runtime").media_token().to_owned();
        let guard = runtime.lock().expect("runtime");

        let cover = build_local_media_response(
            build_request(
                Method::GET,
                &format!("http://mineradio-local.localhost/cover/{id}?cap={token}"),
                None,
            ),
            Some(&guard),
        );
        assert_eq!(cover.status(), StatusCode::OK);
        assert_eq!(cover.body().as_slice(), PNG_1X1_BYTES);
        assert_eq!(cover.headers()["content-type"], "image/png");

        fs::remove_dir_all(root).expect("应清理测试目录");
    }
}
