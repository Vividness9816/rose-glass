//! Canonical DDL for the derived store. Every table is a rebuildable cache of the
//! vault (spec §8). Pragmas are applied per-connection in `db::open_db`, NOT here
//! (`journal_mode=WAL` errors inside a transaction; `foreign_keys` is per-connection).

pub const SCHEMA_VERSION: i64 = 1;

pub const SCHEMA_V1: &str = r#"
CREATE TABLE notes (
    path         TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    frontmatter  TEXT,
    content_hash TEXT NOT NULL,
    mtime        INTEGER NOT NULL,
    word_count   INTEGER NOT NULL DEFAULT 0,
    indexed_at   INTEGER NOT NULL
);

CREATE TABLE links (
    src_path  TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    dst_path  TEXT          REFERENCES notes(path) ON DELETE SET NULL,
    dst_raw   TEXT NOT NULL,
    link_type TEXT NOT NULL CHECK (link_type IN ('wikilink','markdown','embed'))
);
CREATE INDEX idx_links_dst ON links(dst_path);
CREATE INDEX idx_links_src ON links(src_path);

CREATE TABLE tags (
    path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    tag  TEXT NOT NULL
);
CREATE INDEX idx_tags_tag  ON tags(tag);
CREATE INDEX idx_tags_path ON tags(path);

CREATE VIRTUAL TABLE notes_fts USING fts5(
    path UNINDEXED,
    title,
    body,
    tokenize = 'porter unicode61 remove_diacritics 2'
);

CREATE TABLE embeddings (
    path   TEXT PRIMARY KEY REFERENCES notes(path) ON DELETE CASCADE,
    vector BLOB NOT NULL,
    model  TEXT NOT NULL
);

CREATE TABLE clusters (
    path        TEXT PRIMARY KEY REFERENCES notes(path) ON DELETE CASCADE,
    cluster_id  INTEGER NOT NULL,
    computed_at INTEGER NOT NULL
);
"#;

/// DROP every table (incl. the FTS virtual table). Order: children/virtual first.
pub const DROP_ALL: &str = r#"
DROP TABLE IF EXISTS clusters;
DROP TABLE IF EXISTS embeddings;
DROP TABLE IF EXISTS notes_fts;
DROP TABLE IF EXISTS tags;
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS notes;
"#;
