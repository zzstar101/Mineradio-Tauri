use std::{
    error::Error,
    ffi::{OsStr, OsString},
    fmt,
    fs::File,
    io::{self, Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex, MutexGuard,
    },
};

use serde_json::Value;

use crate::runtime::updater::managed_fs::StableDirectory;

/// 上游 Mineradio v2.1 last-playback restore 的桌面侧持久化。
///
/// 文件直接位于 `{app_data_dir}\playback-session-checkpoint-v1.json`，与 updater
/// 静默事务的 `playback-exit-checkpoint-v1.json` 完全无关：后者只在更新事务期间由
/// quiescence authority 持有，本模块是 Web 启动恢复（startup-resume）的独立通道。
pub(crate) const PLAYBACK_SESSION_FILE_NAME: &str = "playback-session-checkpoint-v1.json";
pub(crate) const PLAYBACK_SESSION_SCHEMA: &str = "playback-session-persist-v1";

/// 与 `PlaybackExitCheckpointV1` 的 256 KiB 边界保持一致；上限作用于 canonical
/// 序列化结果（含结尾换行）。
const MAX_PLAYBACK_SESSION_BYTES: u64 = 256 * 1024;
const TEMPORARY_FILE_ATTEMPTS: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlaybackSessionError {
    code: &'static str,
    message: String,
}

impl PlaybackSessionError {
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

impl fmt::Display for PlaybackSessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for PlaybackSessionError {}

/// 进程级 I/O 串行锁：command 可能来自任意 webview 线程，save/load 必须彼此串行，
/// 因此锁不能挂在按调用构造的实例上。损坏（poisoned）时恢复继续服务，避免一次
/// panic 让后续保存永久失败。
static SESSION_IO_LOCK: Mutex<()> = Mutex::new(());
static ACTIVE_IO_WRITERS: AtomicUsize = AtomicUsize::new(0);

/// 持有进程级串行锁直到 drop；字段本身只为生命周期服务，从不读取。
struct SessionIoGuard {
    _lock: MutexGuard<'static, ()>,
}

impl SessionIoGuard {
    fn begin() -> Self {
        let lock = match SESSION_IO_LOCK.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        ACTIVE_IO_WRITERS.fetch_add(1, Ordering::SeqCst);
        Self { _lock: lock }
    }
}

impl Drop for SessionIoGuard {
    fn drop(&mut self) {
        ACTIVE_IO_WRITERS.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
pub(crate) fn active_io_writers() -> usize {
    ACTIVE_IO_WRITERS.load(Ordering::SeqCst)
}

/// 从已解析的 app data 目录字符串构造受管 checkpoint 目录路径。
pub(crate) fn checkpoint_directory(app_data_dir: &str) -> std::path::PathBuf {
    Path::new(app_data_dir).to_path_buf()
}

/// 原子保存 envelope：staged temp + `fs::rename` 级 replace，任何一步失败都不触碰
/// 已有文件，且不留临时残留。仅做字节上限校验；深度校验属于 Web playback store。
pub(crate) fn save_checkpoint(
    directory: impl AsRef<Path>,
    payload: &Value,
) -> Result<(), PlaybackSessionError> {
    let canonical = canonical_document(payload)?;
    let _io_guard = SessionIoGuard::begin();
    let directory = StableDirectory::open_or_create(directory.as_ref()).map_err(|error| {
        PlaybackSessionError::new(
            "PLAYBACK_SESSION_DIRECTORY_FAILED",
            format!("创建播放会话目录失败：{error}"),
        )
    })?;
    save_canonical_bytes(&directory, PLAYBACK_SESSION_FILE_NAME, &canonical)
}

/// 读取会话 checkpoint。缺失、超过大小上限、BOM、非 canonical、非法 JSON 或
/// schema 不符一律视为不存在（fail closed），只有真实文件系统故障向上传播。
pub(crate) fn load_checkpoint(
    directory: impl AsRef<Path>,
) -> Result<Option<Value>, PlaybackSessionError> {
    let _io_guard = SessionIoGuard::begin();
    let Some(directory) = StableDirectory::open_existing(directory.as_ref()).map_err(|error| {
        PlaybackSessionError::new(
            "PLAYBACK_SESSION_DIRECTORY_FAILED",
            format!("打开播放会话目录失败：{error}"),
        )
    })?
    else {
        return Ok(None);
    };
    let Some(mut file) = directory
        .open_regular_read(OsStr::new(PLAYBACK_SESSION_FILE_NAME))
        .map_err(|error| {
            PlaybackSessionError::new(
                "PLAYBACK_SESSION_OPEN_FAILED",
                format!("打开播放会话文件失败：{error}"),
            )
        })?
    else {
        return Ok(None);
    };
    let metadata = file.metadata().map_err(|error| {
        PlaybackSessionError::new(
            "PLAYBACK_SESSION_READ_FAILED",
            format!("读取播放会话文件元数据失败：{error}"),
        )
    })?;
    if metadata.len() > MAX_PLAYBACK_SESSION_BYTES {
        return Ok(None);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_PLAYBACK_SESSION_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            PlaybackSessionError::new(
                "PLAYBACK_SESSION_READ_FAILED",
                format!("读取播放会话文件失败：{error}"),
            )
        })?;
    if bytes.len() as u64 > MAX_PLAYBACK_SESSION_BYTES || bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Ok(None);
    }
    let document: Value = match serde_json::from_slice(&bytes) {
        Ok(document) => document,
        Err(_) => return Ok(None),
    };
    if canonical_document(&document)? != bytes {
        return Ok(None);
    }
    if document.get("schema").and_then(Value::as_str) != Some(PLAYBACK_SESSION_SCHEMA) {
        return Ok(None);
    }
    Ok(Some(document))
}

fn canonical_document(payload: &Value) -> Result<Vec<u8>, PlaybackSessionError> {
    let mut bytes = serde_json::to_vec(payload).map_err(|error| {
        PlaybackSessionError::new(
            "PLAYBACK_SESSION_ENCODE_FAILED",
            format!("编码播放会话 checkpoint 失败：{error}"),
        )
    })?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_PLAYBACK_SESSION_BYTES {
        return Err(PlaybackSessionError::new(
            "PLAYBACK_SESSION_CHECKPOINT_TOO_LARGE",
            "播放会话 checkpoint 超过 256 KiB 固定上限",
        ));
    }
    Ok(bytes)
}

fn save_canonical_bytes(
    directory: &StableDirectory,
    file_name: &str,
    canonical: &[u8],
) -> Result<(), PlaybackSessionError> {
    let (temporary_name, mut temporary) = create_temporary_file(directory, file_name)?;
    if let Err(error) = temporary
        .write_all(canonical)
        .and_then(|()| temporary.sync_all())
    {
        drop(temporary);
        let _ = directory.remove_regular(&temporary_name);
        return Err(PlaybackSessionError::new(
            "PLAYBACK_SESSION_WRITE_FAILED",
            format!("写入并同步播放会话临时文件失败：{error}"),
        ));
    }
    if let Err(error) =
        directory.publish_replace(&temporary, &temporary_name, OsStr::new(file_name))
    {
        drop(temporary);
        let _ = directory.remove_regular(&temporary_name);
        return Err(PlaybackSessionError::new(
            "PLAYBACK_SESSION_REPLACE_FAILED",
            format!("发布播放会话文件失败：{error}"),
        ));
    }
    drop(temporary);
    sync_parent_directory(directory.path()).map_err(|error| {
        PlaybackSessionError::new(
            "PLAYBACK_SESSION_DIRECTORY_SYNC_FAILED",
            format!("同步播放会话目录失败：{error}"),
        )
    })
}

fn create_temporary_file(
    directory: &StableDirectory,
    destination_name: &str,
) -> Result<(OsString, File), PlaybackSessionError> {
    for _ in 0..TEMPORARY_FILE_ATTEMPTS {
        let suffix = random_lower_hex_128()?;
        let temporary_name = OsString::from(format!(".{destination_name}.tmp-{suffix}"));
        match directory.create_new_renameable(&temporary_name) {
            Ok(file) => return Ok((temporary_name, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(PlaybackSessionError::new(
                    "PLAYBACK_SESSION_TEMP_CREATE_FAILED",
                    format!("创建播放会话临时文件失败：{error}"),
                ));
            }
        }
    }
    Err(PlaybackSessionError::new(
        "PLAYBACK_SESSION_TEMP_COLLISION",
        "无法创建唯一的播放会话临时文件",
    ))
}

fn random_lower_hex_128() -> Result<String, PlaybackSessionError> {
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce).map_err(|error| {
        PlaybackSessionError::new(
            "PLAYBACK_SESSION_ENTROPY_FAILED",
            format!("生成播放会话随机后缀失败：{error}"),
        )
    })?;
    Ok(nonce.iter().map(|byte| format!("{byte:02x}")).collect())
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
    use std::{fs, io, path::PathBuf, sync::Arc};

    use super::*;
    use serde_json::json;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            for _ in 0..8 {
                let suffix = random_lower_hex_128().expect("测试目录应取得系统随机数");
                let path = std::env::temp_dir()
                    .join(format!("mineradio-playback-session-{label}-{suffix}"));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("应创建 playback session 测试目录：{error}"),
                }
            }
            panic!("无法创建唯一 playback session 测试目录");
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn envelope(saved_at: u64, position_ms: f64) -> Value {
        json!({
            "schema": PLAYBACK_SESSION_SCHEMA,
            "savedAtMs": saved_at,
            "autoplayOnStartup": false,
            "checkpoint": {
                "schema": "playback-exit-checkpoint-v1",
                "positionMs": position_ms,
                "queue": [],
            },
        })
    }

    #[test]
    fn save_then_load_roundtrips_the_canonical_envelope() {
        let root = TestDirectory::new("roundtrip");
        let payload = envelope(1_724_000_000_000, 42_500.0);

        save_checkpoint(&root.0, &payload).expect("应保存 checkpoint");
        let loaded = load_checkpoint(&root.0).expect("读取不应失败");
        assert_eq!(loaded.as_ref(), Some(&payload));

        // 覆盖写入同一目标必须原子替换成功。
        let next = envelope(1_724_000_000_001, 61_000.0);
        save_checkpoint(&root.0, &next).expect("覆盖保存应成功");
        assert_eq!(
            load_checkpoint(&root.0).expect("二次读取不应失败").as_ref(),
            Some(&next)
        );
    }

    #[test]
    fn oversize_payload_is_rejected_without_touching_disk() {
        let root = TestDirectory::new("oversize");
        save_checkpoint(&root.0, &envelope(1, 0.0)).expect("先写入合法基线");

        let mut large = envelope(2, 0.0);
        large["checkpoint"]["queue"] = json!(vec!["填充".repeat(512); 8_000]);
        let error = save_checkpoint(&root.0, &large).unwrap_err();
        assert_eq!(error.code(), "PLAYBACK_SESSION_CHECKPOINT_TOO_LARGE");
        // 基线文件必须原样保留。
        assert_eq!(
            load_checkpoint(&root.0).expect("读取不应失败").as_ref(),
            Some(&envelope(1, 0.0))
        );
    }

    #[test]
    fn corrupt_bom_noncanonical_and_schema_mismatch_are_treated_as_absent() {
        let root = TestDirectory::new("corrupt");

        // 目录/文件缺失。
        assert_eq!(load_checkpoint(&root.0).expect("缺目录应为 None"), None);

        save_checkpoint(&root.0, &envelope(3, 5.0)).expect("写入合法基线");
        let target = root.0.join(PLAYBACK_SESSION_FILE_NAME);

        // 非 JSON 字节。
        fs::write(&target, b"not-json-at-all\n").unwrap();
        assert_eq!(
            load_checkpoint(&root.0).expect("坏 JSON 应为 None"),
            None,
            "corrupt json"
        );

        // UTF-8 BOM 前缀的 canonical 文档。
        let canonical = canonical_document(&envelope(3, 5.0)).unwrap();
        let mut with_bom = Vec::from(&b"\xEF\xBB\xBF"[..]);
        with_bom.extend_from_slice(&canonical);
        fs::write(&target, &with_bom).unwrap();
        assert_eq!(
            load_checkpoint(&root.0).expect("BOM 应为 None"),
            None,
            "bom"
        );

        // Pretty-printed（非 canonical）JSON。
        let pretty = serde_json::to_vec_pretty(&envelope(3, 5.0)).unwrap();
        fs::write(&target, pretty).unwrap();
        assert_eq!(
            load_checkpoint(&root.0).expect("非 canonical 应为 None"),
            None,
            "non-canonical"
        );

        // schema 不符。
        let mut wrong_schema = envelope(3, 5.0);
        wrong_schema["schema"] = json!("playback-session-persist-v9");
        save_checkpoint(&root.0, &wrong_schema).expect("保存错误 schema 应成功（仅大小校验）");
        assert_eq!(
            load_checkpoint(&root.0).expect("schema 不符应为 None"),
            None,
            "wrong schema"
        );
    }

    #[test]
    fn atomic_replace_leaves_no_temporary_files_behind() {
        let root = TestDirectory::new("atomicity");
        for round in 0..6_u64 {
            save_checkpoint(&root.0, &envelope(round, round as f64 * 1_000.0))
                .expect("每轮保存都应成功");
        }

        let entries = fs::read_dir(&root.0)
            .expect("应枚举测试目录")
            .map(|entry| entry.expect("条目可读").file_name())
            .collect::<Vec<_>>();
        assert_eq!(entries.len(), 1, "只允许留下最终文件：{entries:?}");
        assert_eq!(entries[0], PLAYBACK_SESSION_FILE_NAME);
        assert_eq!(
            load_checkpoint(&root.0).expect("最终读取不应失败").as_ref(),
            Some(&envelope(5, 5_000.0))
        );
    }

    #[test]
    fn concurrent_saves_are_serialized_and_never_torn() {
        let root = Arc::new(TestDirectory::new("concurrent"));
        const WRITERS: usize = 6;
        const SAVES_PER_WRITER: u64 = 40;

        let payloads = (0_u64..(WRITERS as u64) * SAVES_PER_WRITER)
            .map(|index| envelope(index + 10, index as f64 * 100.0))
            .collect::<Vec<_>>();

        let first = payloads[0].clone();
        save_checkpoint(&*root.0, &first).expect("种子写入应成功");

        let handles = payloads
            .chunks(SAVES_PER_WRITER as usize)
            .enumerate()
            .map(|(writer_index, chunk)| {
                let root = Arc::clone(&root);
                let chunk = chunk.to_vec();
                std::thread::spawn(move || {
                    for payload in chunk {
                        save_checkpoint(&*root.0, &payload).expect("并发保存应全部成功");
                        // 并发读永远只能看到完整 payload，绝不出现半写状态。
                        let loaded = load_checkpoint(&*root.0)
                            .expect("并发读取不应产生 IO 错误")
                            .expect("至少存在种子文件");
                        assert!(
                            loaded.get("savedAtMs").is_some(),
                            "并发读到的必须是完整文档"
                        );
                    }
                    writer_index
                })
            })
            .collect::<Vec<_>>();

        let mut max_observed_writers = 0_usize;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !handles.is_empty() {
            max_observed_writers = max_observed_writers.max(active_io_writers());
            if std::time::Instant::now() > deadline {
                panic!("并发保存超时");
            }
            let still_running = handles
                .iter()
                .filter(|handle| !handle.is_finished())
                .count();
            if still_running == 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        for handle in handles {
            handle.join().expect("写线程不应 panic");
        }
        assert!(
            max_observed_writers <= 1,
            "I/O 锁必须把保存完全串行化：观测到同时 {max_observed_writers} 个 writer"
        );

        let final_payload = load_checkpoint(&*root.0)
            .expect("最终读取不应失败")
            .expect("最终文件必须存在");
        assert!(
            payloads.contains(&final_payload),
            "最终内容必须是某个完整 payload"
        );
    }
}
