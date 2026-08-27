use crate::{db, AppState};

/// 返回 SQLite 本地存储的诊断信息。
///
/// 薄壳:把 AppState 里的 DbRuntimeState 取出来,调 db::build_database_status。
///
/// # 前端使用
/// 仅用于"设置 → 诊断"页面或开发态日志;展示 db path、当前迁移版本、启动计数。
/// 不保证字段稳定,前端应容错处理(字段缺失/类型不符)。
#[tauri::command]
pub fn get_database_status(
    state: tauri::State<'_, AppState>,
) -> Result<db::DatabaseStatus, String> {
    match &state.db {
        Some(db_mutex) => {
            let db = db_mutex.lock().map_err(|e| e.to_string())?;
            db::build_database_status(&db.conn, &db.path).map_err(|e| e.to_string())
        }
        None => Err(state
            .db_init_error
            .clone()
            .unwrap_or_else(|| "database not initialized".to_string())),
    }
}

#[tauri::command]
pub fn get_runtime_config(state: tauri::State<'_, AppState>) -> crate::RuntimeConfig {
    state.config.clone()
}
