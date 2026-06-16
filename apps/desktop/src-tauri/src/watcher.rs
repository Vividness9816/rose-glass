//! FS watcher → debounced events → a worker thread that owns the writer connection
//! and applies incremental/delete, emitting `index:note` per real change.

use crate::db;
use crate::indexer::pipeline;
use crate::indexer::IndexOutcome;
use notify_debouncer_full::new_debouncer;
use notify_debouncer_full::notify::{EventKind, RecursiveMode};
use std::any::Any;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

enum Op {
    Reindex(String),
    Delete(String),
}

/// Spawn the watcher. The returned boxed value must be held alive (in AppState) —
/// dropping it stops watching and closes the worker channel.
pub fn spawn(
    vault_root: PathBuf,
    db_path: PathBuf,
    app: AppHandle,
) -> Result<Box<dyn Any + Send>, String> {
    let (tx, rx) = mpsc::channel::<Op>();

    // worker thread: owns the single writer connection
    let worker_root = vault_root.clone();
    std::thread::spawn(move || {
        let Ok(mut conn) = db::open_db(&db_path) else {
            return;
        };
        while let Ok(op) = rx.recv() {
            let (rel, kind) = match &op {
                Op::Reindex(r) => (r.clone(), "upsert"),
                Op::Delete(r) => (r.clone(), "delete"),
            };
            let res = match &op {
                Op::Reindex(r) => pipeline::incremental(&mut conn, &worker_root, r),
                Op::Delete(r) => pipeline::delete(&mut conn, r),
            };
            if matches!(res, Ok(o) if o != IndexOutcome::Skipped) {
                let _ = app.emit("index:note", serde_json::json!({ "path": rel, "op": kind }));
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
                let is_remove = matches!(ev.kind, EventKind::Remove(_));
                for path in &ev.paths {
                    if !pipeline::is_markdown(path) {
                        continue;
                    }
                    let Some(rel) = pipeline::normalize_rel(&handler_root, path) else {
                        continue;
                    };
                    let op = if is_remove || !path.exists() {
                        Op::Delete(rel)
                    } else {
                        Op::Reindex(rel)
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
