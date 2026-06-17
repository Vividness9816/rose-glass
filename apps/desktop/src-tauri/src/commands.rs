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
use tauri::{AppHandle, Emitter, Manager, State};

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

/// Phase 9: read a vault file as raw bytes (PDF/docx view). Goes through the same
/// `safe_join` vault-root guard as the text path, so a binary must live INSIDE the
/// vault (no absolute / `..` reads). Returns raw bytes via `tauri::ipc::Response`
/// (an efficient ArrayBuffer transfer, NOT a bloated JSON `number[]`). Touches only
/// the briefly-held `vault_root` lock — never the DB `Mutex` — so it can't stall IPC.
/// ponytail: 100 MB cap guards against OOM on a pathological file; raise the const if a
/// real document needs more.
#[tauri::command]
pub async fn read_file_bytes(
    state: State<'_, AppState>,
    path: String,
) -> Result<tauri::ipc::Response, IpcError> {
    const MAX_BYTES: u64 = 100 * 1024 * 1024;
    let root = lock(&state.vault_root)
        .clone()
        .ok_or_else(|| IpcError("no vault open".into()))?;
    let abs = crate::fs_safe::safe_join(&root, &path)?;
    let meta = std::fs::metadata(&abs)?;
    if !meta.is_file() {
        return Err(IpcError("target is not a regular file".into()));
    }
    if meta.len() > MAX_BYTES {
        return Err(IpcError(format!(
            "file too large to open ({} MB; cap {} MB)",
            meta.len() / (1024 * 1024),
            MAX_BYTES / (1024 * 1024)
        )));
    }
    // Bounded read from one fd: TOCTOU-safe — a file that grows after the stat still can't
    // be read past the cap, and a non-regular entry can't stream unbounded bytes.
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(&abs)?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(IpcError(format!(
            "file too large to open (cap {} MB)",
            MAX_BYTES / (1024 * 1024)
        )));
    }
    Ok(tauri::ipc::Response::new(bytes))
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

/// Phase 11: embed every note (local ONNX, all-MiniLM) and k-means them into the
/// `clusters` table — lighting up the graph's cluster colouring and the MCP
/// `get_semantic_clusters` tool. The DB lock is held only for the read and the write,
/// NOT during the slow embed. Returns the number of distinct clusters.
#[tauri::command]
pub async fn recompute_clusters(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, IpcError> {
    let cache = app.path().app_cache_dir()?.join("models");
    std::fs::create_dir_all(&cache)?;

    let rows = {
        let conn = lock(&state.db);
        crate::cluster::read_texts(&conn)?
    };
    if rows.is_empty() {
        return Ok(0);
    }

    // Embed without the DB lock (model load + inference is slow). Borrow the texts (no
    // second copy of the corpus); rows stays alive for the zip below.
    let texts: Vec<&str> = rows.iter().map(|(_, t)| t.as_str()).collect();
    let mut model = crate::embed::new_model(&cache).map_err(IpcError)?;
    let vectors = crate::embed::embed_texts(&mut model, &texts).map_err(IpcError)?;

    let items: Vec<(String, Vec<f32>)> = rows.into_iter().map(|(p, _)| p).zip(vectors).collect();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let n = {
        let mut conn = lock(&state.db);
        crate::cluster::store_clusters(&mut conn, &items, crate::cluster::K, crate::embed::MODEL_NAME, now)?
    };

    // Graph + counts changed → Shell's onIndexRebuilt refetches and recolours.
    let _ = app.emit("index:rebuilt", serde_json::json!({ "note_count": items.len() }));
    Ok(n)
}

/// Phase 8: start the read-only CC activity tail (ADR-20260617 M1 — transcript-tail
/// only; no `settings.json` mutation). The `generation` (a monotonic token bumped per
/// frontend effect run) serializes against `activity_stop` so a StrictMode / rapid
/// view-toggle re-mount can't leave a dead tail or leak a watcher. The whole spawn +
/// store runs UNDER the lock (no `.await` held), serializing it against stop. Emits
/// `activity:event` / `activity:dropped` / `activity:anomaly`.
#[tauri::command]
pub async fn activity_start(
    app: AppHandle,
    state: State<'_, AppState>,
    generation: u64,
) -> Result<(), IpcError> {
    let mut g = lock(&state.activity);
    if !crate::activity::should_start(g.0, g.1.is_some(), generation) {
        return Ok(()); // a newer/equal start already owns the tail
    }
    let handle = crate::activity::spawn(app.clone(), state.vault_root.clone()).map_err(IpcError)?;
    g.0 = generation;
    g.1 = Some(handle); // assigning drops any previous watcher (stops the old tail)
    Ok(())
}

/// Phase 8: stop the activity tail (drop the watcher → worker channel closes →
/// worker exits). Only clears if no NEWER start has taken over (`generation` gate),
/// so a stale stop can't drop a live newer watcher. In-memory only — nothing persisted.
#[tauri::command]
pub async fn activity_stop(state: State<'_, AppState>, generation: u64) -> Result<(), IpcError> {
    let mut g = lock(&state.activity);
    if crate::activity::should_stop(g.0, generation) {
        g.1 = None;
    }
    Ok(())
}

/// Phase 8: DRY-RUN the deferred M2 global-hook install (ADR-20260617). Reads
/// `~/.claude/settings.json` READ-ONLY and reports what arming would change +
/// whether uninstall round-trips. There is NO code path here that writes
/// settings.json — arming the live mutation is a future, attended, user-OK'd act.
#[tauri::command]
pub async fn activity_hook_plan() -> Result<String, IpcError> {
    let path = crate::activity::cc_settings_path()
        .ok_or_else(|| IpcError("cannot resolve ~/.claude/settings.json".into()))?;
    let json = std::fs::read_to_string(&path)?;
    crate::installer::dry_run_summary(&json).map_err(IpcError)
}
