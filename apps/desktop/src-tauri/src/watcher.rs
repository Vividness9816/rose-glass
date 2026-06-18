//! FS watcher → debounced events → a worker thread that applies incremental/delete
//! through the SHARED DB connection (so writes serialize with IPC commands via the
//! Mutex — no second-writer contention), emitting `index:note` per real change.

use crate::indexer::pipeline;
use crate::indexer::IndexOutcome;
use crate::state::lock;
use notify_debouncer_full::new_debouncer;
use notify_debouncer_full::notify::RecursiveMode;
use rusqlite::Connection;
use std::any::Any;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

enum Op {
    Reindex(String),
    Delete(String),
}

/// Spawn the watcher. The returned boxed value must be held alive (in AppState) —
/// dropping it closes the worker channel and stops watching.
pub fn spawn(
    vault_root: PathBuf,
    db: Arc<Mutex<Connection>>,
    app: AppHandle,
) -> Result<Box<dyn Any + Send>, String> {
    let (tx, rx) = mpsc::channel::<Op>();

    let worker_root = vault_root.clone();
    std::thread::spawn(move || {
        while let Ok(op) = rx.recv() {
            let (rel, kind) = match &op {
                Op::Reindex(r) => (r.clone(), "upsert"),
                Op::Delete(r) => (r.clone(), "delete"),
            };
            let res = {
                let mut conn = lock(&db); // shared connection — serializes with commands
                match &op {
                    Op::Reindex(r) => pipeline::incremental(&mut conn, &worker_root, r),
                    Op::Delete(r) => pipeline::delete(&mut conn, r),
                }
            };
            match res {
                Ok(o) if o != IndexOutcome::Skipped => {
                    let _ = app.emit("index:note", serde_json::json!({ "path": rel, "op": kind }));
                }
                Ok(_) => {}
                Err(e) => eprintln!("[rose-glass] index op failed for {rel}: {e}"),
            }
        }
    });

    let handler_root = vault_root.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        None,
        move |result: notify_debouncer_full::DebounceEventResult| {
            let Ok(events) = result else {
                return;
            };
            for ev in events {
                for path in &ev.paths {
                    if !pipeline::is_markdown(path) {
                        continue;
                    }
                    let Some(rel) = pipeline::normalize_rel(&handler_root, path) else {
                        continue;
                    };
                    // Existence is the source of truth, NOT the event kind. An atomic save
                    // (temp-write + rename-over-target) can surface a Remove event for the
                    // target even though the file is still there; treating that as a delete
                    // wrongly evicts the note and closes the open editor mid-edit. So: present
                    // on disk → (re)index; only truly gone → delete.
                    let op = if path.exists() {
                        Op::Reindex(rel)
                    } else {
                        Op::Delete(rel)
                    };
                    let _ = tx.send(op);
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watch(&vault_root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    Ok(Box::new(debouncer))
}
