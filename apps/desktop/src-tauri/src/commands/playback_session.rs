use crate::{runtime, AppState};

/// 保存播放会话 checkpoint envelope（`{app_data_dir}\playback-session-checkpoint-v1.json`）。
///
/// Rust 侧只校验 canonical 序列化后的字节上限；envelope/checkpoint 的深度校验由
/// Web playback store 负责。超限时返回稳定 code
/// `PLAYBACK_SESSION_CHECKPOINT_TOO_LARGE`。
#[tauri::command]
pub fn playback_session_checkpoint_save(
    state: tauri::State<'_, AppState>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let store = runtime::playback_session::checkpoint_directory(&state.config.app_data_dir);
    runtime::playback_session::save_checkpoint(&store, &request)
        .map(|()| serde_json::json!({ "ok": true }))
        .map_err(|error| error.code().to_owned())
}

/// 读取播放会话 checkpoint；文件缺失或内容损坏时返回 `None`，调用方按无 checkpoint
/// 启动处理。数据库不可用与本命令无关：文件直接位于 app data 目录。
#[tauri::command]
pub fn playback_session_checkpoint_load(
    state: tauri::State<'_, AppState>,
) -> Result<Option<serde_json::Value>, String> {
    let store = runtime::playback_session::checkpoint_directory(&state.config.app_data_dir);
    runtime::playback_session::load_checkpoint(&store).map_err(|error| error.code().to_owned())
}
