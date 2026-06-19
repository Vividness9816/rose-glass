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
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// A coalesced filesystem op for one path (the path is the map key, so this is just the
/// kind). Last write wins per path → a rapid save storm collapses to one op.
#[derive(Clone, Copy)]
enum Op {
    Reindex,
    Delete,
}

/// Spawn the watcher. The returned boxed value must be held alive (in AppState) —
/// dropping it closes the worker channel and stops watching.
pub fn spawn(
    vault_root: PathBuf,
    db: Arc<Mutex<Connection>>,
    app: AppHandle,
) -> Result<Box<dyn Any + Send>, String> {
    // Coalesce-at-ENQUEUE: the debounce callback records one pending Op per path in this
    // map (last write wins — a save storm collapses to one op) and pings a zero-size wake
    // channel; the worker drains the whole map per wake. This bounds memory by distinct
    // changed paths (NOT event count) and — unlike a bounded sync_channel — never blocks
    // the notify callback thread (a block there would silently drop OS events). ADR-20260618-v2.
    let pending: Arc<Mutex<HashMap<String, Op>>> = Arc::new(Mutex::new(HashMap::new()));
    let (tx, rx) = mpsc::channel::<()>();

    let worker_root = vault_root.clone();
    let worker_pending = Arc::clone(&pending);
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            // Collapse extra wakes that queued while we were busy — one drain covers them.
            while rx.try_recv().is_ok() {}
            let batch: Vec<(String, Op)> = {
                let mut p = lock(&worker_pending);
                p.drain().collect()
            };
            for (rel, op) in batch {
                let res = {
                    let mut conn = lock(&db); // shared connection — serializes with commands
                    match op {
                        Op::Reindex => pipeline::incremental(&mut conn, &worker_root, &rel),
                        Op::Delete => pipeline::delete(&mut conn, &rel),
                    }
                };
                match res {
                    Ok(o) if o != IndexOutcome::Skipped => {
                        let kind = match op {
                            Op::Reindex => "upsert",
                            Op::Delete => "delete",
                        };
                        let _ = app.emit("index:note", serde_json::json!({ "path": rel, "op": kind }));
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("[rose-glass] index op failed for {rel}: {e}"),
                }
            }
        }
    });

    let handler_root = vault_root.clone();
    let handler_pending = Arc::clone(&pending);
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        None,
        move |result: notify_debouncer_full::DebounceEventResult| {
            let Ok(events) = result else {
                return;
            };
            let mut woke = false;
            for ev in events {
                for path in &ev.paths {
                    if !pipeline::is_markdown(path) {
                        continue;
                    }
                    let Some(rel) = pipeline::normalize_rel(&handler_root, path) else {
                        continue;
                    };
                    // Same skip floor as full_rebuild/incremental — a markdown file under
                    // node_modules/.git/etc. must never enter the graph (A3 convergence).
                    if pipeline::should_skip(&rel) {
                        continue;
                    }
                    // Existence is the source of truth, NOT the event kind. An atomic save
                    // (temp-write + rename-over-target) can surface a Remove event for the
                    // target even though the file is still there; treating that as a delete
                    // wrongly evicts the note and closes the open editor mid-edit. So: present
                    // on disk → (re)index; only truly gone → delete. (incremental/delete
                    // re-check existence, so this is only the enqueue hint.)
                    let op = if path.exists() { Op::Reindex } else { Op::Delete };
                    lock(&handler_pending).insert(rel, op); // last op for this path wins
                    woke = true;
                }
            }
            if woke {
                let _ = tx.send(()); // one wake per debounce batch; the work lives in `pending`
            }
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watch(&vault_root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    Ok(Box::new(debouncer))
}
