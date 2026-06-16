use rusqlite::Connection;
use std::any::Any;
use std::path::PathBuf;
use std::sync::Mutex;

/// App-wide state. The DB is a single serialized connection (rusqlite `Connection`
/// is `Send` but `!Sync`). The watcher is held as `Box<dyn Any + Send>` so this
/// struct doesn't depend on the version-specific debouncer generics — dropping it
/// stops watching.
pub struct AppState {
    pub db: Mutex<Connection>,
    pub vault_root: Mutex<Option<PathBuf>>,
    pub watcher: Mutex<Option<Box<dyn Any + Send>>>,
}

impl AppState {
    pub fn new(db: Connection) -> Self {
        Self {
            db: Mutex::new(db),
            vault_root: Mutex::new(None),
            watcher: Mutex::new(None),
        }
    }
}
