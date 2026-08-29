//! SQLite本地存储模块
//! 提供数据库初始化、模式迁移和基本读/写

use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 解析数据库路径
fn resolve_db_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("mineradio.db")
}

fn open_connection(db_path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(conn)
}

fn run_migrations(conn: &Connection) -> rusqlite::Result<()> {
    // 确保 _migrations 表本身存在
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            name    TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )?;

    // 查出已执行过的最大 version
    let latest: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM _migrations",
        [],
        |row| row.get(0),
    )?;

    // 从 latest+1 开始,逐个执行未应用的迁移
    apply_migration(conn, 1, "create_kv_store", latest < 1)?;
    apply_migration(conn, 2, "create_listen_history", latest < 2)?;
    apply_migration(conn, 3, "create_preferences_store", latest < 3)?;

    Ok(())
}

fn apply_migration(
    conn: &Connection,
    version: i64,
    name: &str,
    should_apply: bool,
) -> rusqlite::Result<()> {
    if !should_apply {
        return Ok(());
    }
    let sql = match version {
        1 => MIGRATION_V1_SQL,
        2 => MIGRATION_V2_SQL,
        3 => MIGRATION_V3_SQL,
        _ => {
            return Err(rusqlite::Error::ToSqlConversionFailure(
                format!("unknown migration version: {version}").into(),
            ))
        }
    };
    let tx = conn.unchecked_transaction()?;
    let claimed = tx.execute(
        "INSERT OR IGNORE INTO _migrations (version, name) VALUES (?1, ?2)",
        rusqlite::params![version, name],
    )?;
    if claimed == 0 {
        tx.commit()?;
        return Ok(());
    }
    tx.execute_batch(sql)?;
    tx.commit()?;
    Ok(())
}

const MIGRATION_V1_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS kv_store (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
"#;

const MIGRATION_V2_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS listen_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        song_key TEXT NOT NULL,
        name TEXT NOT NULL,
        artist TEXT NOT NULL,
        cover TEXT,
        source TEXT,
        played_at TEXT NOT NULL DEFAULT (datetime('now')),
        listen_ms INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_listen_history_song ON listen_history(song_key);
    CREATE INDEX IF NOT EXISTS idx_listen_history_played ON listen_history(played_at);
"#;

const MIGRATION_V3_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL DEFAULT (
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        )
    );
    CREATE TABLE IF NOT EXISTS preference_quarantine (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        value_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        quarantined_at_ms INTEGER NOT NULL DEFAULT (
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        )
    );
    CREATE TABLE IF NOT EXISTS preference_migration_journal (
        legacy_key TEXT PRIMARY KEY,
        preference_key TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('copied', 'verified', 'committed')),
        diagnostic TEXT,
        updated_at_ms INTEGER NOT NULL DEFAULT (
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        )
    );
"#;

pub const MAX_PREFERENCE_OPERATIONS: usize = 40;
pub const MAX_PREFERENCE_VALUE_BYTES: usize = 256 * 1024;
pub const MAX_PREFERENCE_TRANSACTION_BYTES: usize = 512 * 1024;
pub const MAX_PREFERENCE_SNAPSHOT_BYTES: usize = 1024 * 1024;
pub const MAX_PREFERENCE_MIGRATION_ENTRIES: usize = 16;
const MAX_PREFERENCE_QUARANTINE_ENTRIES: usize = 32;

const ALLOWED_PREFERENCE_KEYS: &[(&str, u32)] = &[
    ("playback.quality", 1),
    ("playback.audio.v2", 2),
    ("shell.capsuleAutoHide", 1),
    ("shell.playlistPanelPinned", 1),
    ("shell.diyMode", 1),
    ("shell.visualGuideSeen", 1),
    ("visual.shelf", 1),
    ("visual.fx", 1),
    ("visual.workshop.v1", 1),
    ("settings.fabAutoHide", 1),
    ("desktop.wallpaperSelection", 1),
    ("home.listenLedger.v2", 2),
    ("search.history", 1),
    ("accounts.providerOrder.v1", 1),
    ("lyrics.timingOffsets", 1),
    ("player.controlsAutoHide", 1),
    ("player.immersiveMode", 1),
];

const ALLOWED_LEGACY_PREFERENCE_MIGRATIONS: &[(&str, &str)] = &[
    ("mineradio-playback-audio-v2", "playback.audio.v2"),
    ("mineradio-playback-quality-v1", "playback.quality"),
    (
        "mineradio-user-capsule-auto-hide-v1",
        "shell.capsuleAutoHide",
    ),
    (
        "mineradio-playlist-panel-pinned-v1",
        "shell.playlistPanelPinned",
    ),
    ("mineradio-diy-player-mode-v1", "shell.diyMode"),
    ("mineradio-visual-guide-seen-v2", "shell.visualGuideSeen"),
    ("mineradio-tauri-shelf-settings-v1", "visual.shelf"),
    ("mineradio-tauri-visual-settings-v1", "visual.fx"),
    ("mineradio-tauri-workshop-settings-v1", "visual.workshop.v1"),
    ("mineradio-fx-fab-auto-hide-v1", "settings.fabAutoHide"),
    (
        "mineradio.wallpaper-engine.selection.v1",
        "desktop.wallpaperSelection",
    ),
    ("mineradio-listen-stats-v1", "home.listenLedger.v2"),
    ("mineradio-search-history", "search.history"),
];

fn allowed_preference_schema(key: &str) -> Option<u32> {
    ALLOWED_PREFERENCE_KEYS
        .iter()
        .find_map(|(candidate, version)| (*candidate == key).then_some(*version))
}

#[derive(Debug)]
pub struct PreferenceStoreError {
    code: &'static str,
    detail: String,
}

impl PreferenceStoreError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }

    #[cfg(test)]
    fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Display for PreferenceStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}:{}", self.code, self.detail)
    }
}

impl std::error::Error for PreferenceStoreError {}

impl From<rusqlite::Error> for PreferenceStoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new("PREFERENCES_DATABASE_FAILED", error.to_string())
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(
    rename_all = "camelCase",
    tag = "kind",
    rename_all_fields = "camelCase"
)]
pub enum PreferenceMutation {
    Set {
        key: String,
        schema_version: u32,
        value: serde_json::Value,
    },
    Remove {
        key: String,
    },
    Quarantine {
        key: String,
        reason: String,
    },
}

impl PreferenceMutation {
    fn key(&self) -> &str {
        match self {
            Self::Set { key, .. } | Self::Remove { key } | Self::Quarantine { key, .. } => key,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceTransactionRequest {
    pub operations: Vec<PreferenceMutation>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredPreferenceValue {
    pub schema_version: u32,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceMigrationJournalView {
    pub legacy_key: String,
    pub preference_key: String,
    pub schema_version: u32,
    pub digest: String,
    pub state: String,
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesSnapshot {
    pub schema_version: u32,
    pub values: BTreeMap<String, StoredPreferenceValue>,
    pub migrations: BTreeMap<String, PreferenceMigrationJournalView>,
}

fn validate_preference_key(key: &str) -> Result<u32, PreferenceStoreError> {
    allowed_preference_schema(key)
        .ok_or_else(|| PreferenceStoreError::new("PREFERENCE_KEY_NOT_ALLOWED", key.to_string()))
}

fn serialize_preference_value(
    key: &str,
    value: &serde_json::Value,
) -> Result<String, PreferenceStoreError> {
    let serialized = serde_json::to_string(value).map_err(|error| {
        PreferenceStoreError::new("PREFERENCE_VALUE_INVALID", error.to_string())
    })?;
    if serialized.len() > MAX_PREFERENCE_VALUE_BYTES {
        return Err(PreferenceStoreError::new(
            "PREFERENCE_VALUE_TOO_LARGE",
            key.to_string(),
        ));
    }
    Ok(serialized)
}

fn validate_preference_transaction(
    request: &PreferenceTransactionRequest,
) -> Result<Vec<Option<String>>, PreferenceStoreError> {
    if request.operations.len() > MAX_PREFERENCE_OPERATIONS {
        return Err(PreferenceStoreError::new(
            "PREFERENCES_TOO_MANY_OPERATIONS",
            request.operations.len().to_string(),
        ));
    }
    let mut total_bytes = 0usize;
    let mut serialized_values = Vec::with_capacity(request.operations.len());
    for operation in &request.operations {
        let expected_schema = validate_preference_key(operation.key())?;
        total_bytes = total_bytes.saturating_add(operation.key().len());
        match operation {
            PreferenceMutation::Set {
                key,
                schema_version,
                value,
            } => {
                if *schema_version != expected_schema {
                    return Err(PreferenceStoreError::new(
                        "PREFERENCE_SCHEMA_VERSION_UNSUPPORTED",
                        key.to_string(),
                    ));
                }
                let serialized = serialize_preference_value(key, value)?;
                total_bytes = total_bytes.saturating_add(serialized.len());
                serialized_values.push(Some(serialized));
            }
            PreferenceMutation::Remove { .. } => serialized_values.push(None),
            PreferenceMutation::Quarantine { reason, .. } => {
                total_bytes = total_bytes.saturating_add(reason.len());
                serialized_values.push(None);
            }
        }
    }
    if total_bytes > MAX_PREFERENCE_TRANSACTION_BYTES {
        return Err(PreferenceStoreError::new(
            "PREFERENCES_PAYLOAD_TOO_LARGE",
            total_bytes.to_string(),
        ));
    }
    Ok(serialized_values)
}

fn preference_store_payload_bytes(conn: &Connection) -> Result<usize, PreferenceStoreError> {
    let bytes: i64 = conn.query_row(
        "SELECT COALESCE(SUM(
            length(CAST(key AS BLOB)) + length(CAST(value_json AS BLOB))
         ), 0) FROM preferences",
        [],
        |row| row.get(0),
    )?;
    usize::try_from(bytes).map_err(|error| {
        PreferenceStoreError::new("PREFERENCES_PAYLOAD_INVALID", error.to_string())
    })
}

fn enforce_preference_store_limit(conn: &Connection) -> Result<(), PreferenceStoreError> {
    let bytes = preference_store_payload_bytes(conn)?;
    if bytes > MAX_PREFERENCE_SNAPSHOT_BYTES {
        return Err(PreferenceStoreError::new(
            "PREFERENCES_STORE_TOO_LARGE",
            bytes.to_string(),
        ));
    }
    Ok(())
}

pub fn get_preferences_snapshot(
    conn: &Connection,
) -> Result<PreferencesSnapshot, PreferenceStoreError> {
    let mut values = BTreeMap::new();
    let mut statement =
        conn.prepare("SELECT key, schema_version, value_json FROM preferences ORDER BY key ASC")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, u32>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut payload_bytes = 0usize;
    for row in rows {
        let (key, schema_version, value_json) = row?;
        if allowed_preference_schema(&key) != Some(schema_version) {
            continue;
        }
        payload_bytes = payload_bytes
            .saturating_add(key.len())
            .saturating_add(value_json.len());
        if payload_bytes > MAX_PREFERENCE_SNAPSHOT_BYTES {
            return Err(PreferenceStoreError::new(
                "PREFERENCES_SNAPSHOT_TOO_LARGE",
                payload_bytes.to_string(),
            ));
        }
        let value = serde_json::from_str(&value_json).map_err(|error| {
            PreferenceStoreError::new("PREFERENCE_VALUE_INVALID", error.to_string())
        })?;
        values.insert(
            key,
            StoredPreferenceValue {
                schema_version,
                value,
            },
        );
    }
    drop(statement);

    let mut migrations = BTreeMap::new();
    let mut statement = conn.prepare(
        "SELECT legacy_key, preference_key, schema_version, digest, state, diagnostic
         FROM preference_migration_journal ORDER BY legacy_key ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(PreferenceMigrationJournalView {
            legacy_key: row.get(0)?,
            preference_key: row.get(1)?,
            schema_version: row.get(2)?,
            digest: row.get(3)?,
            state: row.get(4)?,
            diagnostic: row.get(5)?,
        })
    })?;
    for row in rows {
        let journal = row?;
        migrations.insert(journal.legacy_key.clone(), journal);
    }

    Ok(PreferencesSnapshot {
        schema_version: 1,
        values,
        migrations,
    })
}

pub fn commit_preferences_transaction(
    conn: &Connection,
    request: PreferenceTransactionRequest,
) -> Result<PreferencesSnapshot, PreferenceStoreError> {
    let serialized_values = validate_preference_transaction(&request)?;
    let tx = conn.unchecked_transaction()?;
    for (operation, serialized) in request.operations.iter().zip(serialized_values) {
        match operation {
            PreferenceMutation::Set {
                key,
                schema_version,
                ..
            } => {
                tx.execute(
                    "INSERT INTO preferences (key, schema_version, value_json)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(key) DO UPDATE SET
                        schema_version = excluded.schema_version,
                        value_json = excluded.value_json,
                        updated_at_ms = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)",
                    rusqlite::params![key, schema_version, serialized.expect("set value")],
                )?;
            }
            PreferenceMutation::Remove { key } => {
                tx.execute("DELETE FROM preferences WHERE key = ?1", [key])?;
            }
            PreferenceMutation::Quarantine { key, reason } => {
                tx.execute(
                    "INSERT INTO preference_quarantine (key, schema_version, value_json, reason)
                     SELECT key, schema_version, value_json, ?2 FROM preferences WHERE key = ?1",
                    rusqlite::params![key, reason],
                )?;
                tx.execute("DELETE FROM preferences WHERE key = ?1", [key])?;
                tx.execute(
                    "DELETE FROM preference_quarantine
                     WHERE id NOT IN (
                        SELECT id FROM preference_quarantine
                        ORDER BY id DESC LIMIT ?1
                     )",
                    [MAX_PREFERENCE_QUARANTINE_ENTRIES as i64],
                )?;
            }
        }
    }
    enforce_preference_store_limit(&tx)?;
    tx.commit()?;
    get_preferences_snapshot(conn)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPreferenceMigrationEntry {
    pub legacy_key: String,
    pub preference_key: String,
    pub schema_version: u32,
    pub digest: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPreferencesMigrationRequest {
    pub entries: Vec<LegacyPreferenceMigrationEntry>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MigrationCheckpoint {
    Copied,
    Verified,
}

pub fn preference_value_digest(value: &serde_json::Value) -> Result<String, PreferenceStoreError> {
    let canonical = serde_json::to_string(value).map_err(|error| {
        PreferenceStoreError::new("PREFERENCE_VALUE_INVALID", error.to_string())
    })?;
    Ok(format!("{:x}", Sha256::digest(canonical.as_bytes())))
}

fn validate_legacy_preference_entry(
    entry: &LegacyPreferenceMigrationEntry,
) -> Result<(String, String), PreferenceStoreError> {
    let mapping_allowed =
        ALLOWED_LEGACY_PREFERENCE_MIGRATIONS
            .iter()
            .any(|(legacy, preference)| {
                *legacy == entry.legacy_key && *preference == entry.preference_key
            });
    if !mapping_allowed {
        return Err(PreferenceStoreError::new(
            "PREFERENCE_LEGACY_MAPPING_NOT_ALLOWED",
            format!("{}->{}", entry.legacy_key, entry.preference_key),
        ));
    }
    let expected_schema = validate_preference_key(&entry.preference_key)?;
    if expected_schema != entry.schema_version {
        return Err(PreferenceStoreError::new(
            "PREFERENCE_SCHEMA_VERSION_UNSUPPORTED",
            entry.preference_key.clone(),
        ));
    }
    let serialized = serialize_preference_value(&entry.preference_key, &entry.value)?;
    if entry.digest.len() != 64 || !entry.digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(PreferenceStoreError::new(
            "PREFERENCE_DIGEST_INVALID",
            entry.legacy_key.clone(),
        ));
    }
    // Web digest 用于识别 legacy 原始内容变化；Rust digest 只用于 SQLite readback 校验，
    // 避免两种 JSON number/key 排序实现的规范化细节互相耦合。
    let readback_digest = preference_value_digest(&entry.value)?;
    Ok((serialized, readback_digest))
}

fn migration_journal(
    conn: &Connection,
    legacy_key: &str,
) -> Result<Option<PreferenceMigrationJournalView>, PreferenceStoreError> {
    conn.query_row(
        "SELECT legacy_key, preference_key, schema_version, digest, state, diagnostic
         FROM preference_migration_journal WHERE legacy_key = ?1",
        [legacy_key],
        |row| {
            Ok(PreferenceMigrationJournalView {
                legacy_key: row.get(0)?,
                preference_key: row.get(1)?,
                schema_version: row.get(2)?,
                digest: row.get(3)?,
                state: row.get(4)?,
                diagnostic: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(PreferenceStoreError::from)
}

fn stored_preference_digest(
    conn: &Connection,
    key: &str,
) -> Result<Option<String>, PreferenceStoreError> {
    let value_json: Option<String> = conn
        .query_row(
            "SELECT value_json FROM preferences WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()?;
    value_json
        .map(|raw| {
            let value: serde_json::Value = serde_json::from_str(&raw).map_err(|error| {
                PreferenceStoreError::new("PREFERENCE_VALUE_INVALID", error.to_string())
            })?;
            preference_value_digest(&value)
        })
        .transpose()
}

fn copy_legacy_preference(
    conn: &Connection,
    entry: &LegacyPreferenceMigrationEntry,
    serialized: &str,
) -> Result<(), PreferenceStoreError> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO preferences (key, schema_version, value_json)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
            schema_version = excluded.schema_version,
            value_json = excluded.value_json,
            updated_at_ms = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)",
        rusqlite::params![entry.preference_key, entry.schema_version, serialized],
    )?;
    tx.execute(
        "INSERT INTO preference_migration_journal
            (legacy_key, preference_key, schema_version, digest, state, diagnostic)
         VALUES (?1, ?2, ?3, ?4, 'copied', NULL)
         ON CONFLICT(legacy_key) DO UPDATE SET
            preference_key = excluded.preference_key,
            schema_version = excluded.schema_version,
            digest = excluded.digest,
            state = 'copied',
            diagnostic = NULL,
            updated_at_ms = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)",
        rusqlite::params![
            entry.legacy_key,
            entry.preference_key,
            entry.schema_version,
            entry.digest.to_ascii_lowercase()
        ],
    )?;
    enforce_preference_store_limit(&tx)?;
    tx.commit()?;
    Ok(())
}

fn update_migration_state(
    conn: &Connection,
    legacy_key: &str,
    expected_state: &str,
    next_state: &str,
) -> Result<(), PreferenceStoreError> {
    let changed = conn.execute(
        "UPDATE preference_migration_journal
         SET state = ?3,
             updated_at_ms = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
         WHERE legacy_key = ?1 AND state = ?2",
        rusqlite::params![legacy_key, expected_state, next_state],
    )?;
    if changed != 1 {
        return Err(PreferenceStoreError::new(
            "PREFERENCE_MIGRATION_STATE_CONFLICT",
            legacy_key.to_string(),
        ));
    }
    Ok(())
}

fn migrate_legacy_preferences_until(
    conn: &Connection,
    request: LegacyPreferencesMigrationRequest,
    stop_after: Option<MigrationCheckpoint>,
) -> Result<PreferencesSnapshot, PreferenceStoreError> {
    if request.entries.len() > MAX_PREFERENCE_MIGRATION_ENTRIES {
        return Err(PreferenceStoreError::new(
            "PREFERENCES_TOO_MANY_MIGRATIONS",
            request.entries.len().to_string(),
        ));
    }
    let mut validated = Vec::with_capacity(request.entries.len());
    let mut total_bytes = 0usize;
    for entry in &request.entries {
        let (serialized, readback_digest) = validate_legacy_preference_entry(entry)?;
        total_bytes = total_bytes
            .saturating_add(entry.legacy_key.len())
            .saturating_add(entry.preference_key.len())
            .saturating_add(entry.digest.len())
            .saturating_add(serialized.len());
        validated.push((serialized, readback_digest));
    }
    if total_bytes > MAX_PREFERENCE_TRANSACTION_BYTES {
        return Err(PreferenceStoreError::new(
            "PREFERENCES_PAYLOAD_TOO_LARGE",
            total_bytes.to_string(),
        ));
    }

    for (entry, (serialized, readback_digest)) in request.entries.iter().zip(validated) {
        let journal = migration_journal(conn, &entry.legacy_key)?;
        if journal
            .as_ref()
            .is_some_and(|item| item.state == "committed")
        {
            // committed 后新存储已成为权威，旧值之后的变化不会覆盖用户的新设置。
            continue;
        }
        let digest_matches = journal
            .as_ref()
            .is_some_and(|item| item.digest.eq_ignore_ascii_case(&entry.digest));
        let stored_matches = stored_preference_digest(conn, &entry.preference_key)?
            .is_some_and(|digest| digest == readback_digest);
        if !digest_matches || !stored_matches {
            copy_legacy_preference(conn, entry, &serialized)?;
        }
        if stop_after == Some(MigrationCheckpoint::Copied) {
            return get_preferences_snapshot(conn);
        }

        let journal = migration_journal(conn, &entry.legacy_key)?.ok_or_else(|| {
            PreferenceStoreError::new(
                "PREFERENCE_MIGRATION_STATE_CONFLICT",
                entry.legacy_key.clone(),
            )
        })?;
        if journal.state == "copied" {
            let verified = stored_preference_digest(conn, &entry.preference_key)?
                .is_some_and(|digest| digest == readback_digest);
            if !verified {
                return Err(PreferenceStoreError::new(
                    "PREFERENCE_MIGRATION_VERIFY_FAILED",
                    entry.legacy_key.clone(),
                ));
            }
            update_migration_state(conn, &entry.legacy_key, "copied", "verified")?;
        }
        if stop_after == Some(MigrationCheckpoint::Verified) {
            return get_preferences_snapshot(conn);
        }

        let journal = migration_journal(conn, &entry.legacy_key)?.ok_or_else(|| {
            PreferenceStoreError::new(
                "PREFERENCE_MIGRATION_STATE_CONFLICT",
                entry.legacy_key.clone(),
            )
        })?;
        if journal.state == "verified" {
            update_migration_state(conn, &entry.legacy_key, "verified", "committed")?;
        }
    }
    get_preferences_snapshot(conn)
}

pub fn migrate_legacy_preferences(
    conn: &Connection,
    request: LegacyPreferencesMigrationRequest,
) -> Result<PreferencesSnapshot, PreferenceStoreError> {
    migrate_legacy_preferences_until(conn, request, None)
}

fn get_kv(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM kv_store WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
}

/// 写入 kv_store;当前生产路径暂无通用 KV command,保留给后续设置迁移复用。
#[allow(dead_code)]
fn set_kv(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO kv_store (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now');",
        [key, value],
    )?;
    tx.commit()?;
    Ok(())
}

/// 记录一次收听历史到 listen_history 表。
///
/// 当前未被任何 Tauri command 引用,保留 pub 是为后续"听歌统计上报"
/// 留出入口,本次 issue 不接入前端。`#[allow]` 抑制 dead_code 警告。
// 这些参数逐一映射 listen_history 数据库列，显式签名便于核对写入顺序。
#[allow(dead_code, clippy::too_many_arguments)]
pub fn add_listen_history(
    conn: &Connection,
    song_key: &str,
    name: &str,
    artist: &str,
    cover: Option<&str>,
    source: Option<&str>,
    listen_ms: i64,
    completed: bool,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO listen_history
            (song_key, name, artist, cover, source, listen_ms, completed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            song_key,
            name,
            artist,
            cover,
            source,
            listen_ms,
            completed as i64
        ],
    )?;
    Ok(())
}

fn current_migration_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM _migrations",
        [],
        |row| row.get(0),
    )
}

fn get_startup_count(conn: &Connection) -> rusqlite::Result<i64> {
    match get_kv(conn, "startup_count")? {
        Some(value) => value
            .parse::<i64>()
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e))),
        None => Ok(0),
    }
}

fn increment_startup_count(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "INSERT INTO kv_store (key, value) VALUES ('startup_count', '1')
         ON CONFLICT(key) DO UPDATE SET
             value = CAST(CAST(kv_store.value AS INTEGER) + 1 AS TEXT),
             updated_at = datetime('now')
         RETURNING CAST(value AS INTEGER)",
        [],
        |row| row.get(0),
    )
}

/// 数据库运行时状态:把连接和它在磁盘上的路径打包在一起。
///
/// 把 path 也放在这里,调用方(Tauri AppState、诊断命令)就能直接报告
/// 当前数据库位置,不用再重新算一次
pub struct DbRuntimeState {
    pub conn: Connection,
    pub path: PathBuf,
}

/// 为 Tauri 运行时初始化本地 SQLite 数据库
///
/// 步骤:
/// 1. 确保 `app_data_dir` 目录存在
/// 2. 算出数据库文件路径
/// 3. 打开连接(不存在则自动创建)
/// 4. 执行所有未应用的迁移
/// 5. 递增启动计数 `startup_count`
///
/// 返回连接和它的磁盘路径
pub fn initialize(app_data_dir: &Path) -> rusqlite::Result<DbRuntimeState> {
    fs::create_dir_all(app_data_dir)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    let path = resolve_db_path(app_data_dir);
    let conn = open_connection(&path)?;
    run_migrations(&conn)?;
    increment_startup_count(&conn)?;
    Ok(DbRuntimeState { conn, path })
}

/// 数据库诊断快照,供 Tauri command 返回给前端。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStatus {
    /// 数据库文件的绝对路径,前端可用于"数据存放在哪"展示。
    pub path: String,
    /// 来自 _migrations 表的 MAX(version);0 表示从未跑过迁移。
    pub migration_version: i64,
    /// 自增的启动计数器,只用于诊断,不应作为业务判断依据。
    pub startup_count: i64,
}

/// 读取数据库的诊断信息。
///
/// 是 `get_database_status` command 的纯函数核心,方便单测。
pub fn build_database_status(conn: &Connection, path: &Path) -> rusqlite::Result<DatabaseStatus> {
    Ok(DatabaseStatus {
        path: path.to_string_lossy().to_string(),
        migration_version: current_migration_version(conn)?,
        startup_count: get_startup_count(conn)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_db() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    #[test]
    fn test_resolve_db_path() {
        let app_data_dir = Path::new("/path/to/app/data");
        let expected_path = Path::new("/path/to/app/data/mineradio.db");
        assert_eq!(resolve_db_path(app_data_dir), expected_path);
    }

    #[test]
    fn test_open_connection() {
        let db_path = Path::new(":memory:"); // 使用内存数据库进行测试
        let conn_result: Result<Connection, rusqlite::Error> = open_connection(db_path);
        assert!(conn_result.is_ok());
    }

    #[test]
    fn migrations_creates_tables() {
        let conn = fresh_db();
        // 在全新内存数据库上执行全部迁移，验证不会报错
        assert!(run_migrations(&conn).is_ok());
        let result = conn.execute_batch("SELECT COUNT(*) FROM _migrations");
        assert!(result.is_ok());
    }

    #[test]
    fn test_migrations_is_idempotent() {
        let conn = fresh_db();
        assert!(run_migrations(&conn).is_ok());
        // 再次运行迁移，确保不会出错
        let result = run_migrations(&conn);
        assert!(result.is_ok());
    }

    #[test]
    fn apply_migration_skips_when_version_is_already_recorded() {
        let conn = fresh_db();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (
                version INTEGER PRIMARY KEY,
                name    TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO _migrations (version, name) VALUES (2, 'create_listen_history');",
        )
        .unwrap();

        apply_migration(&conn, 2, "create_listen_history", true).unwrap();

        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'listen_history'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 0);
    }

    #[test]
    fn test_get_kv_missing_key_returns_none() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();
        let result = get_kv(&conn, "nope");
        assert_eq!(result.unwrap(), None);
    }

    #[test]
    fn test_set_and_get_kv() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();
        set_kv(&conn, "test_key", "hello").unwrap();
        let result = get_kv(&conn, "test_key");
        assert_eq!(result.unwrap(), Some("hello".to_string()));
    }

    #[test]
    // 测试 set_kv 是否会覆盖已有的键值
    fn test_set_kv_overwrites() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();
        set_kv(&conn, "test_key", "hello").unwrap();
        set_kv(&conn, "test_key", "world").unwrap();
        let result = get_kv(&conn, "test_key");
        assert_eq!(result.unwrap(), Some("world".to_string()));
    }

    #[test]
    fn test_v2_migration_creates_listen_history() {
        let conn = fresh_db();
        assert!(run_migrations(&conn).is_ok());
        // 检查 listen_history 表是否存在
        let result = conn.execute_batch("SELECT COUNT(*) FROM listen_history");
        assert!(result.is_ok());
    }

    #[test]
    fn test_add_listen_history_inserts_row() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();

        add_listen_history(
            &conn,
            "id:123",
            "歌名",
            "歌手",
            Some("https://example.com/cover.jpg"), // cover 有值
            Some("netease"),                       // source 有值
            30000,                                 // 听了 30 秒
            false,                                 // 没听完
        )
        .unwrap();

        // 查询:listen_history 表里应该有 1 行
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM listen_history", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_get_startup_count_returns_zero_when_empty() {
        let conn: Connection = fresh_db();
        run_migrations(&conn).unwrap();
        let count = get_startup_count(&conn).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_increment_startup_count_increments() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();

        // 调一次: 0 → 1
        let after_first = increment_startup_count(&conn).unwrap();
        assert_eq!(after_first, 1);

        // 再调一次: 1 → 2 (这才是"递增"的关键)
        let after_second = increment_startup_count(&conn).unwrap();
        assert_eq!(after_second, 2);
    }

    #[test]
    fn increment_startup_count_handles_parallel_connections() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let temp_dir = std::env::temp_dir();
        let db_path = temp_dir.join(format!(
            "mineradio-test-count-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_file(&db_path);

        let setup_conn = open_connection(&db_path).unwrap();
        run_migrations(&setup_conn).unwrap();
        drop(setup_conn);

        let workers = 8;
        let iterations = 8;
        let barrier = Arc::new(Barrier::new(workers));
        let mut handles = Vec::new();
        for _ in 0..workers {
            let path = db_path.clone();
            let start = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                let conn = open_connection(&path).unwrap();
                start.wait();
                for _ in 0..iterations {
                    increment_startup_count(&conn).unwrap();
                }
            }));
        }

        for handle in handles {
            handle.join().unwrap();
        }

        let conn = open_connection(&db_path).unwrap();
        let count = get_startup_count(&conn).unwrap();
        let _ = std::fs::remove_file(&db_path);
        assert_eq!(count, (workers * iterations) as i64);
    }

    #[test]
    fn test_current_migration_version_returns_max() {
        // 先跑迁移,让 _migrations 表存在
        let conn = fresh_db();
        run_migrations(&conn).unwrap();

        // 跑过迁移: 应该返回最大 version
        let v = current_migration_version(&conn).unwrap();
        assert!(v >= 1);
    }

    #[test]
    fn initialize_creates_db_and_increments_count() {
        let temp_dir = std::env::temp_dir().join("mineradio-test-init-1");
        let _ = std::fs::remove_dir_all(&temp_dir);

        let state = initialize(&temp_dir).expect("initialize ok");

        assert!(state.path.exists());

        let count = get_startup_count(&state.conn).expect("read count");
        assert_eq!(count, 1);
    }

    #[test]
    fn initialize_twice_increments_count() {
        let temp_dir = std::env::temp_dir().join("mineradio-test-init-2");
        let _ = std::fs::remove_dir_all(&temp_dir);

        let _ = initialize(&temp_dir).unwrap();
        let state = initialize(&temp_dir).unwrap();

        let count = get_startup_count(&state.conn).expect("read count");
        assert_eq!(count, 2);
    }

    #[test]
    fn build_database_status_reports_path_version_and_count() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();
        let path = std::env::temp_dir().join("mineradio-test-status.db");

        let status = build_database_status(&conn, &path).expect("build status");

        assert_eq!(status.path, path.to_string_lossy().to_string());
        assert!(status.migration_version >= 1);
        assert_eq!(status.startup_count, 0);
    }

    #[test]
    fn preference_transaction_rejects_unknown_key_without_partial_writes() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();
        let request = PreferenceTransactionRequest {
            operations: vec![
                PreferenceMutation::Set {
                    key: "playback.quality".to_string(),
                    schema_version: 1,
                    value: serde_json::json!("flac"),
                },
                PreferenceMutation::Set {
                    key: "arbitrary.secret".to_string(),
                    schema_version: 1,
                    value: serde_json::json!(true),
                },
            ],
        };

        let error = commit_preferences_transaction(&conn, request).unwrap_err();

        assert_eq!(error.code(), "PREFERENCE_KEY_NOT_ALLOWED");
        let snapshot = get_preferences_snapshot(&conn).unwrap();
        assert!(snapshot.values.is_empty());
    }

    #[test]
    fn player_shell_preferences_round_trip_through_sqlite_restart() {
        let temp_dir = std::env::temp_dir().join(format!(
            "mineradio-player-shell-preferences-{}-{}",
            std::process::id(),
            crate::runtime::now_ms()
        ));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let db_path = temp_dir.join("mineradio.db");
        std::fs::create_dir_all(&temp_dir).unwrap();

        {
            let conn = open_connection(&db_path).unwrap();
            run_migrations(&conn).unwrap();
            let snapshot = commit_preferences_transaction(
                &conn,
                PreferenceTransactionRequest {
                    operations: vec![
                        PreferenceMutation::Set {
                            key: "lyrics.timingOffsets".to_string(),
                            schema_version: 1,
                            value: serde_json::json!({
                                "local:local:track-a": {
                                    "offset": 0.3,
                                    "updatedAt": 123,
                                    "title": "Track A",
                                    "artist": "Artist"
                                }
                            }),
                        },
                        PreferenceMutation::Set {
                            key: "player.controlsAutoHide".to_string(),
                            schema_version: 1,
                            value: serde_json::json!(true),
                        },
                        PreferenceMutation::Set {
                            key: "player.immersiveMode".to_string(),
                            schema_version: 1,
                            value: serde_json::json!(false),
                        },
                    ],
                },
            )
            .unwrap();
            assert_eq!(
                snapshot.values["lyrics.timingOffsets"].value["local:local:track-a"]["offset"],
                serde_json::json!(0.3)
            );
        }

        let reopened = open_connection(&db_path).unwrap();
        run_migrations(&reopened).unwrap();
        let snapshot = get_preferences_snapshot(&reopened).unwrap();
        assert_eq!(
            snapshot.values["lyrics.timingOffsets"].value["local:local:track-a"]["offset"],
            serde_json::json!(0.3)
        );
        assert_eq!(
            snapshot.values["player.controlsAutoHide"].value,
            serde_json::json!(true)
        );
        assert_eq!(
            snapshot.values["player.immersiveMode"].value,
            serde_json::json!(false)
        );
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn legacy_preference_migration_copies_verifies_and_commits() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();
        let value = serde_json::json!("flac");
        let request = LegacyPreferencesMigrationRequest {
            entries: vec![LegacyPreferenceMigrationEntry {
                legacy_key: "mineradio-playback-quality-v1".to_string(),
                preference_key: "playback.quality".to_string(),
                schema_version: 1,
                digest: preference_value_digest(&value).unwrap(),
                value,
            }],
        };

        let result = migrate_legacy_preferences(&conn, request).unwrap();

        assert_eq!(
            result
                .migrations
                .get("mineradio-playback-quality-v1")
                .unwrap()
                .state,
            "committed"
        );
        assert_eq!(
            result.values.get("playback.quality").unwrap().value,
            serde_json::json!("flac")
        );
    }

    #[test]
    fn legacy_preference_migration_resumes_after_each_checkpoint() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();
        let value = serde_json::json!(true);
        let request = LegacyPreferencesMigrationRequest {
            entries: vec![LegacyPreferenceMigrationEntry {
                legacy_key: "mineradio-diy-player-mode-v1".to_string(),
                preference_key: "shell.diyMode".to_string(),
                schema_version: 1,
                digest: preference_value_digest(&value).unwrap(),
                value,
            }],
        };

        let copied = migrate_legacy_preferences_until(
            &conn,
            request.clone(),
            Some(MigrationCheckpoint::Copied),
        )
        .unwrap();
        assert_eq!(
            copied
                .migrations
                .get("mineradio-diy-player-mode-v1")
                .unwrap()
                .state,
            "copied"
        );
        let verified = migrate_legacy_preferences_until(
            &conn,
            request.clone(),
            Some(MigrationCheckpoint::Verified),
        )
        .unwrap();
        assert_eq!(
            verified
                .migrations
                .get("mineradio-diy-player-mode-v1")
                .unwrap()
                .state,
            "verified"
        );

        let committed = migrate_legacy_preferences(&conn, request).unwrap();
        assert_eq!(
            committed
                .migrations
                .get("mineradio-diy-player-mode-v1")
                .unwrap()
                .state,
            "committed"
        );
    }

    #[test]
    fn legacy_digest_change_before_commit_recopies_but_committed_value_stays_authoritative() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();
        let make_request = |value: bool| {
            let value = serde_json::json!(value);
            LegacyPreferencesMigrationRequest {
                entries: vec![LegacyPreferenceMigrationEntry {
                    legacy_key: "mineradio-user-capsule-auto-hide-v1".to_string(),
                    preference_key: "shell.capsuleAutoHide".to_string(),
                    schema_version: 1,
                    digest: preference_value_digest(&value).unwrap(),
                    value,
                }],
            }
        };

        migrate_legacy_preferences_until(
            &conn,
            make_request(false),
            Some(MigrationCheckpoint::Copied),
        )
        .unwrap();
        let committed = migrate_legacy_preferences(&conn, make_request(true)).unwrap();
        assert_eq!(
            committed.values.get("shell.capsuleAutoHide").unwrap().value,
            serde_json::json!(true)
        );

        let after_legacy_changed = migrate_legacy_preferences(&conn, make_request(false)).unwrap();
        assert_eq!(
            after_legacy_changed
                .values
                .get("shell.capsuleAutoHide")
                .unwrap()
                .value,
            serde_json::json!(true)
        );
    }

    #[test]
    fn preference_store_enforces_operation_value_payload_and_schema_limits() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();

        let too_many = PreferenceTransactionRequest {
            operations: (0..=MAX_PREFERENCE_OPERATIONS)
                .map(|_| PreferenceMutation::Remove {
                    key: "shell.diyMode".to_string(),
                })
                .collect(),
        };
        assert_eq!(
            commit_preferences_transaction(&conn, too_many)
                .unwrap_err()
                .code(),
            "PREFERENCES_TOO_MANY_OPERATIONS"
        );

        let oversized = PreferenceTransactionRequest {
            operations: vec![PreferenceMutation::Set {
                key: "playback.quality".to_string(),
                schema_version: 1,
                value: serde_json::json!("x".repeat(MAX_PREFERENCE_VALUE_BYTES)),
            }],
        };
        assert_eq!(
            commit_preferences_transaction(&conn, oversized)
                .unwrap_err()
                .code(),
            "PREFERENCE_VALUE_TOO_LARGE"
        );

        let chunk = "x".repeat(180 * 1024);
        let payload = PreferenceTransactionRequest {
            operations: vec![
                PreferenceMutation::Set {
                    key: "visual.shelf".to_string(),
                    schema_version: 1,
                    value: serde_json::json!({ "payload": chunk }),
                },
                PreferenceMutation::Set {
                    key: "visual.fx".to_string(),
                    schema_version: 1,
                    value: serde_json::json!({ "payload": chunk }),
                },
                PreferenceMutation::Set {
                    key: "home.listenLedger.v2".to_string(),
                    schema_version: 2,
                    value: serde_json::json!({ "version": 2, "payload": chunk }),
                },
            ],
        };
        assert_eq!(
            commit_preferences_transaction(&conn, payload)
                .unwrap_err()
                .code(),
            "PREFERENCES_PAYLOAD_TOO_LARGE"
        );

        let wrong_schema = PreferenceTransactionRequest {
            operations: vec![PreferenceMutation::Set {
                key: "home.listenLedger.v2".to_string(),
                schema_version: 1,
                value: serde_json::json!({ "version": 2 }),
            }],
        };
        assert_eq!(
            commit_preferences_transaction(&conn, wrong_schema)
                .unwrap_err()
                .code(),
            "PREFERENCE_SCHEMA_VERSION_UNSUPPORTED"
        );
    }

    #[test]
    fn quarantine_moves_corrupt_typed_value_out_of_the_active_snapshot() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();
        commit_preferences_transaction(
            &conn,
            PreferenceTransactionRequest {
                operations: vec![PreferenceMutation::Set {
                    key: "shell.diyMode".to_string(),
                    schema_version: 1,
                    value: serde_json::json!("not-a-boolean"),
                }],
            },
        )
        .unwrap();

        let snapshot = commit_preferences_transaction(
            &conn,
            PreferenceTransactionRequest {
                operations: vec![PreferenceMutation::Quarantine {
                    key: "shell.diyMode".to_string(),
                    reason: "schema-invalid".to_string(),
                }],
            },
        )
        .unwrap();

        assert!(!snapshot.values.contains_key("shell.diyMode"));
        let quarantine_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM preference_quarantine WHERE key = 'shell.diyMode'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(quarantine_count, 1);
    }

    #[test]
    fn preference_store_total_limit_rolls_back_the_overflowing_commit() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();
        let value = serde_json::json!({ "payload": "x".repeat(220 * 1024) });
        for key in [
            "visual.shelf",
            "visual.fx",
            "home.listenLedger.v2",
            "search.history",
        ] {
            let schema_version = allowed_preference_schema(key).unwrap();
            commit_preferences_transaction(
                &conn,
                PreferenceTransactionRequest {
                    operations: vec![PreferenceMutation::Set {
                        key: key.to_string(),
                        schema_version,
                        value: value.clone(),
                    }],
                },
            )
            .unwrap();
        }

        let error = commit_preferences_transaction(
            &conn,
            PreferenceTransactionRequest {
                operations: vec![PreferenceMutation::Set {
                    key: "playback.quality".to_string(),
                    schema_version: 1,
                    value,
                }],
            },
        )
        .unwrap_err();

        assert_eq!(error.code(), "PREFERENCES_STORE_TOO_LARGE");
        assert!(!get_preferences_snapshot(&conn)
            .unwrap()
            .values
            .contains_key("playback.quality"));
    }

    #[test]
    fn preference_command_payloads_accept_camel_case_web_contracts() {
        let request: PreferenceTransactionRequest = serde_json::from_value(serde_json::json!({
            "operations": [{
                "kind": "set",
                "key": "playback.quality",
                "schemaVersion": 1,
                "value": "flac"
            }]
        }))
        .unwrap();
        assert!(matches!(
            &request.operations[0],
            PreferenceMutation::Set {
                schema_version: 1,
                ..
            }
        ));

        let migration: LegacyPreferencesMigrationRequest =
            serde_json::from_value(serde_json::json!({
                "entries": [{
                    "legacyKey": "mineradio-playback-quality-v1",
                    "preferenceKey": "playback.quality",
                    "schemaVersion": 1,
                    "digest": "0".repeat(64),
                    "value": "flac"
                }]
            }))
            .unwrap();
        assert_eq!(migration.entries[0].schema_version, 1);
        assert_eq!(migration.entries[0].preference_key, "playback.quality");
    }

    #[test]
    fn provider_order_preference_round_trips_through_sqlite_restart() {
        let temp_dir = std::env::temp_dir().join(format!(
            "mineradio-provider-order-roundtrip-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&temp_dir);

        let first = initialize(&temp_dir).expect("初始化首个数据库连接");
        commit_preferences_transaction(
            &first.conn,
            PreferenceTransactionRequest {
                operations: vec![PreferenceMutation::Set {
                    key: "accounts.providerOrder.v1".to_string(),
                    schema_version: 1,
                    value: serde_json::json!({
                        "version": 1,
                        "order": ["qq", "netease", "soda"],
                        "visible": ["qq", "netease", "soda"]
                    }),
                }],
            },
        )
        .expect("Provider 顺序应通过 allowlist 写入");
        drop(first);

        let second = initialize(&temp_dir).expect("重启后重新打开数据库连接");
        let snapshot = get_preferences_snapshot(&second.conn).expect("读取偏好快照");
        assert_eq!(
            snapshot.values["accounts.providerOrder.v1"].schema_version,
            1
        );
        assert_eq!(
            snapshot.values["accounts.providerOrder.v1"].value["order"],
            serde_json::json!(["qq", "netease", "soda"])
        );

        drop(second);
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn legacy_migration_rejects_unapproved_mapping_and_digest_before_writing() {
        let conn = fresh_db();
        run_migrations(&conn).unwrap();
        let unapproved = LegacyPreferencesMigrationRequest {
            entries: vec![LegacyPreferenceMigrationEntry {
                legacy_key: "arbitrary-secret".to_string(),
                preference_key: "playback.quality".to_string(),
                schema_version: 1,
                digest: "0".repeat(64),
                value: serde_json::json!("flac"),
            }],
        };
        assert_eq!(
            migrate_legacy_preferences(&conn, unapproved)
                .unwrap_err()
                .code(),
            "PREFERENCE_LEGACY_MAPPING_NOT_ALLOWED"
        );

        let invalid_digest = LegacyPreferencesMigrationRequest {
            entries: vec![LegacyPreferenceMigrationEntry {
                legacy_key: "mineradio-search-history".to_string(),
                preference_key: "search.history".to_string(),
                schema_version: 1,
                digest: "not-a-digest".to_string(),
                value: serde_json::json!(["周杰伦"]),
            }],
        };
        assert_eq!(
            migrate_legacy_preferences(&conn, invalid_digest)
                .unwrap_err()
                .code(),
            "PREFERENCE_DIGEST_INVALID"
        );
        assert!(get_preferences_snapshot(&conn).unwrap().values.is_empty());
    }
}
