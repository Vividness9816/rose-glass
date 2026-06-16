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
    pub vault_root: Mutex<Option<PathBuf>>,
    pub watcher: Mutex<Option<Box<dyn Any + Send>>>,
}

impl AppState {
    pub fn new(db: Connection) -> Self {
        Self {
            db: Arc::new(Mutex::new(db)),
            vault_root: Mutex::new(None),
            watcher: Mutex::new(None),
        }
    }
}

/// Lock a mutex, recovering the guard even if a previous holder panicked — one
/// transient panic must not brick every subsequent IPC call.
pub fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
