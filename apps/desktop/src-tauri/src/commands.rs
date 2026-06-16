//! IPC surface. Heavy work (rebuild) runs in async commands off the UI thread;
//! every DB lock is scoped and dropped before any emit/await (no guard across await).

use crate::db::{self, queries};
use crate::db::queries::{
    BacklinkDto, GraphPayload, NoteDto, OpenVaultResultDto, SearchHit, TagCount,
};
use crate::indexer::pipeline;
use crate::state::AppState;
use crate::watcher;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
pub struct IpcError(pub String);

impl From<rusqlite::Error> for IpcError {
    fn from(e: rusqlite::Error) -> Self {
        IpcError(e.to_string())
    }
}
impl From<std::io::Error> for IpcError {
    fn from(e: std::io::Error) -> Self {
        IpcError(e.to_string())
    }
}
impl From<tauri::Error> for IpcError {
    fn from(e: tauri::Error) -> Self {
        IpcError(e.to_string())
    }
}
impl From<String> for IpcError {
    fn from(s: String) -> Self {
        IpcError(s)
    }
}

#[tauri::command]
pub async fn open_vault(
    state: State<'_, AppState>,
    app: AppHandle,
    path: String,
) -> Result<OpenVaultResultDto, IpcError> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(IpcError(format!("not a directory: {path}")));
    }
    let db_dir = root.join(".rose-glass");
    std::fs::create_dir_all(&db_dir)?;
    let db_path = db_dir.join("index.db");

    let mut conn = db::open_db(&db_path)?;
    db::migrate(&conn)?;
    let count = pipeline::full_rebuild(&mut conn, &root)?;

    {
        *state.db.lock().unwrap() = conn;
        *state.vault_root.lock().unwrap() = Some(root.clone());
    }

    let w = watcher::spawn(root.clone(), db_path, app.clone())?;
    {
        *state.watcher.lock().unwrap() = Some(w);
    }

    let _ = app.emit("index:rebuilt", serde_json::json!({ "note_count": count }));
    Ok(OpenVaultResultDto {
        vault: path,
        note_count: count as i64,
        rebuilt: true,
    })
}

#[tauri::command]
pub async fn reindex(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<OpenVaultResultDto, IpcError> {
    let root = state.vault_root.lock().unwrap().clone();
    let Some(root) = root else {
        return Err(IpcError("no vault open".into()));
    };
    let count = {
        let mut db = state.db.lock().unwrap();
        pipeline::full_rebuild(&mut db, &root)?
    };
    let _ = app.emit("index:rebuilt", serde_json::json!({ "note_count": count }));
    Ok(OpenVaultResultDto {
        vault: root.to_string_lossy().to_string(),
        note_count: count as i64,
        rebuilt: true,
    })
}

#[tauri::command]
pub async fn get_note(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<NoteDto>, IpcError> {
    let db = state.db.lock().unwrap();
    Ok(queries::get_note(&db, &path)?)
}

#[tauri::command]
pub async fn get_backlinks(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<BacklinkDto>, IpcError> {
    let db = state.db.lock().unwrap();
    Ok(queries::get_backlinks(&db, &path)?)
}

#[tauri::command]
pub async fn search(state: State<'_, AppState>, query: String) -> Result<Vec<SearchHit>, IpcError> {
    let db = state.db.lock().unwrap();
    Ok(queries::search_fts(&db, &query)?)
}

#[tauri::command]
pub async fn get_tags(state: State<'_, AppState>) -> Result<Vec<TagCount>, IpcError> {
    let db = state.db.lock().unwrap();
    Ok(queries::get_tags(&db)?)
}

#[tauri::command]
pub async fn get_graph_payload(state: State<'_, AppState>) -> Result<GraphPayload, IpcError> {
    let db = state.db.lock().unwrap();
    Ok(queries::get_graph_payload(&db)?)
}
