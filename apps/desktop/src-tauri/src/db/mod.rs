pub mod queries;
pub mod schema;

use rusqlite::Connection;
use std::path::Path;

/// Apply the per-connection pragmas. MUST run on every connection (the Tauri-managed
/// one, the watcher worker's, and every test connection) before any query —
/// `foreign_keys` is OFF by default and `journal_mode=WAL` must be set outside a tx.
fn apply_pragmas(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;",
    )
}

pub fn open_db(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    apply_pragmas(&conn)?;
    Ok(conn)
}

pub fn open_in_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    apply_pragmas(&conn)?;
    Ok(conn)
}

pub fn drop_all(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(schema::DROP_ALL)
}

/// Bring the schema to the current version. Returns `true` if it (re)created the
/// schema — the caller should then trigger a full rebuild (the cheapest correct
/// migration for a derived cache).
pub fn migrate(conn: &Connection) -> rusqlite::Result<bool> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version == schema::SCHEMA_VERSION {
        return Ok(false);
    }
    if version != 0 {
        drop_all(conn)?;
    }
    conn.execute_batch(schema::SCHEMA_V1)?;
    conn.execute_batch(&format!("PRAGMA user_version = {};", schema::SCHEMA_VERSION))?;
    Ok(true)
}
