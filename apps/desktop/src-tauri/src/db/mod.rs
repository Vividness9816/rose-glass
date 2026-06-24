pub mod queries;
pub mod schema;

use rusqlite::{Connection, OpenFlags};
use std::path::Path;

/// Access mode for a derived-index connection. Both modes get `foreign_keys` ON +
/// `busy_timeout`; only ReadWrite gets `journal_mode=WAL` + `synchronous` (a read-only
/// handle cannot change journal_mode).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    ReadOnly,
    ReadWrite,
}

/// Apply the per-connection pragmas. MUST run on every connection (the Tauri-managed one, the
/// watcher worker's, the sidecar's, and every test connection) before any query.
/// `foreign_keys`: the bundled SQLite (libsqlite3-sys, built with `SQLITE_DEFAULT_FOREIGN_KEYS=1`)
/// already defaults this ON, but we set it explicitly so cascade-correctness never silently depends
/// on a build flag — and so the sidecar's connection matches the app's by construction.
/// `journal_mode=WAL`/`synchronous` only make sense (and only work) on a writable handle.
fn apply_pragmas(conn: &Connection, mode: Mode) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")?;
    if mode == Mode::ReadWrite {
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
    }
    Ok(())
}

pub fn open_db(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    apply_pragmas(&conn, Mode::ReadWrite)?;
    Ok(conn)
}

pub fn open_in_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    apply_pragmas(&conn, Mode::ReadWrite)?;
    Ok(conn)
}

/// Open an EXISTING index.db (does NOT create it) with the access mode's pragmas. The
/// rose-glass-mcp sidecar's connection path — replaces a hand-rolled `open_with_flags` that
/// skipped `apply_pragmas` (so it set neither FK nor WAL explicitly, relying on the bundled
/// default). Routing through here makes the sidecar's connection identical to the app's/tests'.
pub fn open_indexed(path: &Path, mode: Mode) -> rusqlite::Result<Connection> {
    let flags = match mode {
        Mode::ReadOnly => OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        Mode::ReadWrite => OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI,
    };
    let conn = Connection::open_with_flags(path, flags)?;
    apply_pragmas(&conn, mode)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression guard: a read-write connection opened the way the sidecar does MUST enforce
    /// `ON DELETE CASCADE` so deleting a note cleans its tags/links/embeddings/clusters. (FK is
    /// ON via the bundled `SQLITE_DEFAULT_FOREIGN_KEYS=1` AND the explicit pragma — this test
    /// fails loudly if both ever regress, e.g. a switch to a non-bundled SQLite.)
    #[test]
    fn open_indexed_read_write_enforces_foreign_key_cascade() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("index.db");
        {
            let c = open_db(&p).unwrap(); // the app builds the index
            migrate(&c).unwrap();
        }
        let conn = open_indexed(&p, Mode::ReadWrite).unwrap(); // the sidecar reopens it
        conn.execute(
            "INSERT INTO notes (path,title,content_hash,mtime,word_count,indexed_at)
             VALUES ('n.md','T','h',0,1,0)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO tags (path,tag) VALUES ('n.md','x')", []).unwrap();
        conn.execute("DELETE FROM notes WHERE path='n.md'", []).unwrap();
        let orphans: i64 = conn
            .query_row("SELECT COUNT(*) FROM tags WHERE path='n.md'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphans, 0, "FK cascade must clean child rows (foreign_keys must be ON)");
    }

    /// A read-only sidecar connection still reports FK ON and genuinely cannot write.
    #[test]
    fn open_indexed_read_only_is_fk_on_and_cannot_write() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("index.db");
        {
            let c = open_db(&p).unwrap();
            migrate(&c).unwrap();
        }
        let conn = open_indexed(&p, Mode::ReadOnly).unwrap();
        let fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(fk, 1, "read-only connection still has foreign_keys ON");
        assert!(
            conn.execute(
                "INSERT INTO notes (path,title,content_hash,mtime,word_count,indexed_at)
                 VALUES ('x.md','T','h',0,1,0)",
                [],
            )
            .is_err(),
            "read-only connection must reject writes"
        );
    }
}
