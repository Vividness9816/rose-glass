//! All SQL lives here. Read functions return serde DTOs (consumed by `commands`);
//! write functions take a `&Transaction` so callers control the atomic boundary.

use crate::indexer::{resolve, NoteIndex, ResolvedLink};
use rusqlite::{params, Connection, Transaction};
use serde::Serialize;

// ── write-side input ──────────────────────────────────────────────────────
pub struct NoteRow {
    pub path: String,
    pub title: String,
    pub frontmatter_json: Option<String>,
    pub content_hash: String,
    pub mtime: i64,
    pub word_count: i64,
    pub indexed_at: i64,
}

// ── read-side DTOs (serialized to the frontend) ─────────────────────────────
#[derive(Serialize)]
pub struct LinkDto {
    pub dst_path: Option<String>,
    pub dst_raw: String,
    pub link_type: String,
}

#[derive(Serialize)]
pub struct NoteDto {
    pub path: String,
    pub title: String,
    pub frontmatter: Option<serde_json::Value>,
    pub word_count: i64,
    pub mtime: i64,
    pub indexed_at: i64,
    pub tags: Vec<String>,
    pub out_links: Vec<LinkDto>,
}

#[derive(Serialize)]
pub struct BacklinkDto {
    pub src_path: String,
    pub src_title: String,
    pub link_type: String,
}

#[derive(Serialize)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub rank: f64,
}

#[derive(Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: i64,
}

#[derive(Serialize)]
pub struct GraphNodeMeta {
    pub path: String,
    pub title: String,
    pub cluster: Option<i64>,
    pub link_count: i64,
}

#[derive(Serialize)]
pub struct GraphEdgeMeta {
    pub src: String,
    pub dst: String,
}

#[derive(Serialize)]
pub struct GraphPayload {
    pub nodes: Vec<GraphNodeMeta>,
    pub edges: Vec<GraphEdgeMeta>,
}

#[derive(Serialize)]
pub struct OpenVaultResultDto {
    pub vault: String,
    pub note_count: i64,
    pub rebuilt: bool,
}

// ── writes ─────────────────────────────────────────────────────────────────
pub fn clear_all_derived(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "DELETE FROM notes_fts;
         DELETE FROM links;
         DELETE FROM tags;
         DELETE FROM embeddings;
         DELETE FROM clusters;
         DELETE FROM notes;",
    )
}

pub fn upsert_note(tx: &Transaction, n: &NoteRow) -> rusqlite::Result<()> {
    tx.prepare_cached(
        "INSERT INTO notes (path,title,frontmatter,content_hash,mtime,word_count,indexed_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(path) DO UPDATE SET
           title=excluded.title, frontmatter=excluded.frontmatter,
           content_hash=excluded.content_hash, mtime=excluded.mtime,
           word_count=excluded.word_count, indexed_at=excluded.indexed_at",
    )?
    .execute(params![
        n.path,
        n.title,
        n.frontmatter_json,
        n.content_hash,
        n.mtime,
        n.word_count,
        n.indexed_at
    ])?;
    Ok(())
}

pub fn replace_links(tx: &Transaction, src: &str, links: &[ResolvedLink]) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM links WHERE src_path=?1", params![src])?;
    let mut stmt = tx.prepare_cached(
        "INSERT INTO links (src_path,dst_path,dst_raw,link_type) VALUES (?1,?2,?3,?4)",
    )?;
    for l in links {
        stmt.execute(params![src, l.dst_path, l.dst_raw, l.link_type.as_str()])?;
    }
    Ok(())
}

pub fn replace_tags(tx: &Transaction, path: &str, tags: &[String]) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM tags WHERE path=?1", params![path])?;
    let mut stmt = tx.prepare_cached("INSERT INTO tags (path,tag) VALUES (?1,?2)")?;
    for t in tags {
        stmt.execute(params![path, t])?;
    }
    Ok(())
}

pub fn replace_fts(tx: &Transaction, path: &str, title: &str, body: &str) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM notes_fts WHERE path=?1", params![path])?;
    tx.execute(
        "INSERT INTO notes_fts (path,title,body) VALUES (?1,?2,?3)",
        params![path, title, body],
    )?;
    Ok(())
}

pub fn delete_note(tx: &Transaction, path: &str) -> rusqlite::Result<()> {
    // notes cascades to links/tags/embeddings/clusters; FTS is a virtual table (no FK) → delete manually
    tx.execute("DELETE FROM notes WHERE path=?1", params![path])?;
    tx.execute("DELETE FROM notes_fts WHERE path=?1", params![path])?;
    Ok(())
}

/// Re-resolve every currently-dangling link against the (now-updated) note set,
/// setting dst_path where it resolves. This is what makes incremental converge to
/// full-rebuild: a link written before its target existed resolves once it appears.
pub fn relink_dangling(tx: &Transaction, idx: &NoteIndex) -> rusqlite::Result<()> {
    let danglers: Vec<(i64, String, String)> = {
        let mut stmt =
            tx.prepare("SELECT rowid, src_path, dst_raw FROM links WHERE dst_path IS NULL")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (rowid, src, dst_raw) in danglers {
        let target = dst_raw.split('#').next().unwrap_or(&dst_raw).trim();
        if let Some(p) = resolve(target, &src, idx) {
            tx.execute(
                "UPDATE links SET dst_path=?1 WHERE rowid=?2",
                params![p, rowid],
            )?;
        }
    }
    Ok(())
}

// ── reads ──────────────────────────────────────────────────────────────────
pub fn note_meta(conn: &Connection, path: &str) -> rusqlite::Result<Option<(String, i64)>> {
    conn.query_row(
        "SELECT content_hash, mtime FROM notes WHERE path=?1",
        params![path],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

pub fn touch_mtime(conn: &Connection, path: &str, mtime: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE notes SET mtime=?1 WHERE path=?2",
        params![mtime, path],
    )?;
    Ok(())
}

pub fn load_note_index(conn: &Connection) -> rusqlite::Result<NoteIndex> {
    let mut stmt = conn.prepare("SELECT path FROM notes")?;
    let paths: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(NoteIndex::build(&paths))
}

pub fn get_note(conn: &Connection, path: &str) -> rusqlite::Result<Option<NoteDto>> {
    let base = conn
        .query_row(
            "SELECT path,title,frontmatter,word_count,mtime,indexed_at FROM notes WHERE path=?1",
            params![path],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            },
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;

    let Some((path, title, fm_json, word_count, mtime, indexed_at)) = base else {
        return Ok(None);
    };

    let tags: Vec<String> = {
        let mut stmt = conn.prepare("SELECT tag FROM tags WHERE path=?1 ORDER BY tag")?;
        let rows = stmt.query_map(params![path], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    let out_links: Vec<LinkDto> = {
        let mut stmt = conn
            .prepare("SELECT dst_path, dst_raw, link_type FROM links WHERE src_path=?1")?;
        let rows = stmt.query_map(params![path], |r| {
            Ok(LinkDto {
                dst_path: r.get::<_, Option<String>>(0)?,
                dst_raw: r.get::<_, String>(1)?,
                link_type: r.get::<_, String>(2)?,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    let frontmatter = fm_json.and_then(|s| serde_json::from_str(&s).ok());

    Ok(Some(NoteDto {
        path,
        title,
        frontmatter,
        word_count,
        mtime,
        indexed_at,
        tags,
        out_links,
    }))
}

pub fn get_backlinks(conn: &Connection, path: &str) -> rusqlite::Result<Vec<BacklinkDto>> {
    let mut stmt = conn.prepare(
        "SELECT l.src_path, n.title, l.link_type
         FROM links l JOIN notes n ON n.path = l.src_path
         WHERE l.dst_path = ?1
         ORDER BY n.title",
    )?;
    let rows = stmt.query_map(params![path], |r| {
        Ok(BacklinkDto {
            src_path: r.get(0)?,
            src_title: r.get(1)?,
            link_type: r.get(2)?,
        })
    })?;
    rows.collect()
}

/// Wrap each term in double quotes so user punctuation can't break FTS5 grammar.
fn sanitize_query(q: &str) -> String {
    q.split_whitespace()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn search_fts(conn: &Connection, query: &str) -> rusqlite::Result<Vec<SearchHit>> {
    let sanitized = sanitize_query(query);
    if sanitized.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT path, title, snippet(notes_fts,2,'<b>','</b>','…',12) AS snippet, bm25(notes_fts) AS rank
         FROM notes_fts WHERE notes_fts MATCH ?1 ORDER BY rank LIMIT 50",
    )?;
    let rows = stmt.query_map(params![sanitized], |r| {
        Ok(SearchHit {
            path: r.get(0)?,
            title: r.get(1)?,
            snippet: r.get(2)?,
            rank: r.get(3)?,
        })
    })?;
    rows.collect()
}

pub fn get_tags(conn: &Connection) -> rusqlite::Result<Vec<TagCount>> {
    let mut stmt = conn.prepare(
        "SELECT tag, COUNT(*) AS c FROM tags GROUP BY tag ORDER BY c DESC, tag",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TagCount {
            tag: r.get(0)?,
            count: r.get(1)?,
        })
    })?;
    rows.collect()
}

pub fn get_graph_payload(conn: &Connection) -> rusqlite::Result<GraphPayload> {
    let nodes: Vec<GraphNodeMeta> = {
        let mut stmt = conn.prepare(
            "SELECT n.path, n.title, c.cluster_id AS cluster, COUNT(l.src_path) AS link_count
             FROM notes n
             LEFT JOIN links l ON l.src_path = n.path
             LEFT JOIN clusters c ON c.path = n.path
             GROUP BY n.path
             ORDER BY n.path",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(GraphNodeMeta {
                path: r.get(0)?,
                title: r.get(1)?,
                cluster: r.get::<_, Option<i64>>(2)?,
                link_count: r.get(3)?,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    let edges: Vec<GraphEdgeMeta> = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT src_path AS src, dst_path AS dst
             FROM links WHERE dst_path IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(GraphEdgeMeta {
                src: r.get(0)?,
                dst: r.get(1)?,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    Ok(GraphPayload { nodes, edges })
}
