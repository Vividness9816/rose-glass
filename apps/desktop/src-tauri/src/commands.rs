//! IPC surface. Heavy work (rebuild) runs in async commands off the UI thread.
//! All writes go through the shared `Arc<Mutex<Connection>>`, so the Mutex
//! serializes commands with the watcher worker (single-writer in practice).

use crate::db::queries::{
    self, BacklinkDto, GraphPayload, NoteDto, OpenVaultResultDto, SearchHit, TagCount,
};
use crate::db::{self};
use crate::indexer::pipeline;
use crate::state::{lock, AppState};
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
    // Keep the derived cache out of the user's vault git repo.
    let _ = std::fs::write(db_dir.join(".gitignore"), "*\n");
    let db_path = db_dir.join("index.db");

    let mut conn = db::open_db(&db_path)?;
    db::migrate(&conn)?;
    let count = pipeline::full_rebuild(&mut conn, &root)?;

    // Stop the old watcher BEFORE swapping/spawning so there's never a transient
    // double-watcher on the same DB.
    *lock(&state.watcher) = None;
    *lock(&state.db) = conn;
    *lock(&state.vault_root) = Some(root.clone());

    let watcher = watcher::spawn(root.clone(), state.db.clone(), app.clone())?;
    *lock(&state.watcher) = Some(watcher);

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
    let root = lock(&state.vault_root).clone();
    let Some(root) = root else {
        return Err(IpcError("no vault open".into()));
    };
    let count = {
        let mut db = lock(&state.db);
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
    let db = lock(&state.db);
    Ok(queries::get_note(&db, &path)?)
}

#[tauri::command]
pub async fn get_backlinks(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<BacklinkDto>, IpcError> {
    let db = lock(&state.db);
    Ok(queries::get_backlinks(&db, &path)?)
}

#[tauri::command]
pub async fn search(state: State<'_, AppState>, query: String) -> Result<Vec<SearchHit>, IpcError> {
    let db = lock(&state.db);
    Ok(queries::search_fts(&db, &query)?)
}

#[tauri::command]
pub async fn get_tags(state: State<'_, AppState>) -> Result<Vec<TagCount>, IpcError> {
    let db = lock(&state.db);
    Ok(queries::get_tags(&db)?)
}

#[tauri::command]
pub async fn get_graph_payload(state: State<'_, AppState>) -> Result<GraphPayload, IpcError> {
    let db = lock(&state.db);
    Ok(queries::get_graph_payload(&db)?)
}

#[tauri::command]
pub async fn read_note_file(state: State<'_, AppState>, path: String) -> Result<String, IpcError> {
    let root = lock(&state.vault_root)
        .clone()
        .ok_or_else(|| IpcError("no vault open".into()))?;
    let abs = crate::fs_safe::safe_join(&root, &path)?;
    let bytes = std::fs::read(&abs)?;
    // strict UTF-8: never open a buffer we can't write back faithfully (a lossy
    // read + save would silently corrupt non-UTF-8 files on the first keystroke)
    String::from_utf8(bytes)
        .map_err(|_| IpcError("file is not valid UTF-8; cannot open for editing".into()))
}

#[tauri::command]
pub async fn save_note_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), IpcError> {
    let root = lock(&state.vault_root)
        .clone()
        .ok_or_else(|| IpcError("no vault open".into()))?;
    let abs = crate::fs_safe::safe_join(&root, &path)?;
    let dir = abs.parent().ok_or_else(|| IpcError("invalid target".into()))?;
    // atomic: write a temp file in the same dir, then rename over the target
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    use std::io::Write;
    tmp.write_all(content.as_bytes())?;
    tmp.flush()?;
    tmp.as_file().sync_all()?; // fsync data before the atomic rename (crash-durable)
    tmp.persist(&abs).map_err(|e| IpcError(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn resolve_link(
    state: State<'_, AppState>,
    target: String,
    src_path: String,
) -> Result<Option<String>, IpcError> {
    let db = lock(&state.db);
    Ok(queries::resolve_link(&db, &target, &src_path)?)
}
