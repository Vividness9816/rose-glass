use rusqlite::Connection;
use std::any::Any;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// App-wide state. The DB is a single shared connection — `Arc<Mutex<_>>` so the
/// watcher worker thread and the IPC commands write through the SAME connection,
/// letting the Mutex serialize all writes (no second-connection WAL contention /
/// lost updates). `open_vault` swaps the connection's contents in place, so the
/// worker (holding a clone of the Arc) always sees the current vault's DB.
/// The watcher is `Box<dyn Any + Send>` so this struct doesn't depend on the
/// version-specific debouncer generics — dropping it stops watching.
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    /// `Arc` so the Phase-8 activity tail worker holds a clone and always sees the
    /// current vault (for in-vault vs external classification) as it changes.
    pub vault_root: Arc<Mutex<Option<PathBuf>>>,
    pub watcher: Mutex<Option<Box<dyn Any + Send>>>,
    /// Phase 8: the CC activity tail watcher + its generation. `Some` while the
    /// Activity pane is open; dropping it stops the watch (read-only — never touches
    /// `settings.json`). The generation serializes start↔stop so a stale stop from a
    /// StrictMode/rapid-toggle re-mount can't drop a newer start's watcher.
    pub activity: Mutex<(u64, Option<Box<dyn Any + Send>>)>,
    /// v2.0: the cached embedding model (loads the ~90MB ONNX model once, reused across
    /// recompute + semantic search). Vault-independent — survives `open_vault`. A failed
    /// load is remembered so search doesn't silently re-download every call; the Clusters
    /// Retry resets it. See `embed::ModelCache`.
    pub model: Arc<Mutex<crate::embed::ModelCache>>,
}

impl AppState {
    pub fn new(db: Connection) -> Self {
        Self {
            db: Arc::new(Mutex::new(db)),
            vault_root: Arc::new(Mutex::new(None)),
            watcher: Mutex::new(None),
            activity: Mutex::new((0, None)),
            model: Arc::new(Mutex::new(crate::embed::ModelCache::default())),
        }
    }
}

/// Lock a mutex, recovering the guard even if a previous holder panicked — one
/// transient panic must not brick every subsequent IPC call.
pub fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
