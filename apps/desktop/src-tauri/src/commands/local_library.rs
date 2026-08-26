//! 本地音乐库命令：对话框导入、拖放路径导入、列表、歌词与移除。

use crate::{
    runtime::local_library::{
        self, ImportInput, ImportOutcome, LibrarySnapshotOutcome, LocalMusicLibraryRuntime,
        LyricOutcome, MAX_IMPORT_FILES,
    },
    AppState,
};
use std::{collections::HashSet, path::PathBuf, sync::Arc};
use tauri_plugin_dialog::DialogExt;

fn resolve_library(
    state: &AppState,
) -> Result<Arc<std::sync::Mutex<LocalMusicLibraryRuntime>>, String> {
    state
        .local_library
        .clone()
        .ok_or_else(|| "LOCAL_LIBRARY_UNAVAILABLE".to_owned())
}

/// 递归收集目录下的受支持音频（跳过符号链接，按规范化身份防环）。
fn collect_directory_audio(
    root: &std::path::Path,
    directory: &std::path::Path,
    visited: &mut HashSet<String>,
    out: &mut Vec<(String, Option<String>)>,
) {
    if out.len() >= MAX_IMPORT_FILES {
        return;
    }
    let identity = local_library::directory_identity(directory);
    if !visited.insert(identity) {
        return;
    }
    let Ok(read_dir) = std::fs::read_dir(directory) else {
        return;
    };
    let mut entries: Vec<_> = read_dir.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_directory_audio(root, &path, visited, out);
            if out.len() >= MAX_IMPORT_FILES {
                return;
            }
            continue;
        }
        if local_library::is_supported_audio_file(&path) {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            out.push((path.to_string_lossy().into_owned(), Some(relative)));
        }
        if out.len() >= MAX_IMPORT_FILES {
            return;
        }
    }
}

fn expand_import_paths(paths: Vec<String>) -> Vec<ImportInput> {
    let mut collected: Vec<(String, Option<String>)> = Vec::new();
    for raw in paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = PathBuf::from(trimmed);
        if std::fs::metadata(&path)
            .map(|meta| meta.is_dir())
            .unwrap_or(false)
        {
            collect_directory_audio(&path, &path, &mut HashSet::new(), &mut collected);
        } else {
            collected.push((trimmed.to_owned(), None));
        }
        if collected.len() >= MAX_IMPORT_FILES {
            break;
        }
    }
    collected.truncate(MAX_IMPORT_FILES);
    collected
        .into_iter()
        .map(|(path, relative_path)| ImportInput {
            path,
            relative_path,
        })
        .collect()
}

async fn run_import(
    library: Arc<std::sync::Mutex<LocalMusicLibraryRuntime>>,
    inputs: Vec<ImportInput>,
) -> Result<ImportOutcome, String> {
    // 解析并发（信号量）与提交的 spawn_blocking 语义均由 runtime 承担。
    Ok(local_library::import_entries(&library, inputs).await)
}

#[tauri::command]
pub async fn local_library_import_dialog(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    directory: bool,
) -> Result<ImportOutcome, String> {
    let library = resolve_library(&state)?;
    let (tx, mut rx) =
        tauri::async_runtime::channel::<Option<Vec<tauri_plugin_dialog::FilePath>>>(1);
    if directory {
        app.dialog().file().pick_folder(move |selected| {
            let _ = tx.try_send(selected.map(|file_path| vec![file_path]));
        });
    } else {
        app.dialog()
            .file()
            .add_filter(
                "音频文件",
                &["mp3", "flac", "wav", "ogg", "m4a", "aac", "opus"],
            )
            .pick_files(move |selected| {
                let _ = tx.try_send(selected);
            });
    }
    let selected = rx
        .recv()
        .await
        .ok_or_else(|| "LOCAL_LIBRARY_DIALOG_FAILED".to_string())?;
    let Some(selected) = selected else {
        return Ok(ImportOutcome::dialog_dismissed());
    };

    let mut inputs: Vec<ImportInput> = Vec::new();
    for file_path in selected {
        let Ok(path) = file_path.into_path() else {
            continue;
        };
        if path.is_dir() {
            let mut collected = Vec::new();
            collect_directory_audio(&path, &path, &mut HashSet::new(), &mut collected);
            for (collected_path, relative_path) in collected {
                inputs.push(ImportInput {
                    path: collected_path,
                    relative_path,
                });
            }
        } else {
            inputs.push(ImportInput {
                path: path.to_string_lossy().into_owned(),
                relative_path: None,
            });
        }
        if inputs.len() >= MAX_IMPORT_FILES {
            break;
        }
    }
    run_import(library, inputs).await
}

#[tauri::command]
pub async fn local_library_import_paths(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
) -> Result<ImportOutcome, String> {
    let library = resolve_library(&state)?;
    run_import(library, expand_import_paths(paths)).await
}

#[tauri::command]
pub async fn local_library_list(
    state: tauri::State<'_, AppState>,
) -> Result<LibrarySnapshotOutcome, String> {
    let library = resolve_library(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let guard = library
            .lock()
            .map_err(|_| "LOCAL_LIBRARY_LOCK_POISONED".to_owned())?;
        Ok(guard.snapshot())
    })
    .await
    .map_err(|_| "LOCAL_LIBRARY_WORKER_FAILED".to_owned())?
}

#[tauri::command]
pub async fn local_library_lyric(
    state: tauri::State<'_, AppState>,
    local_file_id: String,
) -> Result<LyricOutcome, String> {
    let library = resolve_library(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let guard = library
            .lock()
            .map_err(|_| "LOCAL_LIBRARY_LOCK_POISONED".to_owned())?;
        Ok(guard.lyric_for_track(&local_file_id))
    })
    .await
    .map_err(|_| "LOCAL_LIBRARY_WORKER_FAILED".to_owned())?
}

#[tauri::command]
pub async fn local_library_remove(
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
) -> Result<LibrarySnapshotOutcome, String> {
    let library = resolve_library(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = library
            .lock()
            .map_err(|_| "LOCAL_LIBRARY_LOCK_POISONED".to_owned())?;
        guard.remove_tracks(&ids)
    })
    .await
    .map_err(|_| "LOCAL_LIBRARY_WORKER_FAILED".to_owned())?
}
