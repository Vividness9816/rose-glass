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
pub struct SemanticHit {
    pub path: String,
    pub title: String,
    pub score: f32,
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
    /// Distinct cluster count for the status-bar "N clusters". 0 until recompute_clusters runs
    /// (clear_all_derived empties `clusters` on every rebuild, so it's 0 right after open).
    pub cluster_count: i64,
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

/// Re-resolve EVERY link against the given note set, rewriting dst_path to the
/// resolved value (which may be NULL). Called after a note is added or deleted —
/// the path set changed, so stem-collision winners and dangling links can flip.
/// Re-resolving all links (not just NULL ones) is what makes incremental produce
/// the SAME result as a full rebuild (the A3 invariant) under stem ties.
pub fn reresolve_links(tx: &Transaction, idx: &NoteIndex) -> rusqlite::Result<()> {
    let all: Vec<(i64, String, String)> = {
        let mut stmt = tx.prepare("SELECT rowid, src_path, dst_raw FROM links")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (rowid, src, dst_raw) in all {
        let target = dst_raw.split('#').next().unwrap_or(&dst_raw).trim();
        let dst = resolve(target, &src, idx);
        tx.execute(
            "UPDATE links SET dst_path=?1 WHERE rowid=?2",
            params![dst, rowid],
        )?;
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

/// Resolve a wikilink/markdown target to a vault path using the SAME logic the
/// indexer uses for edges — so click-navigation and the graph agree. None = dangling.
pub fn resolve_link(
    conn: &Connection,
    target: &str,
    src_path: &str,
) -> rusqlite::Result<Option<String>> {
    let idx = load_note_index(conn)?;
    let t = target.split('#').next().unwrap_or(target).trim();
    Ok(resolve(t, src_path, &idx))
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

#[derive(Serialize)]
pub struct ClusterMember {
    pub path: String,
    pub title: String,
}

#[derive(Serialize)]
pub struct ClusterGroup {
    pub cluster_id: i64,
    pub members: Vec<ClusterMember>,
}

/// Semantic clusters grouped by id (the `clusters` table is populated by the
/// embeddings phase; empty until then). Read surface for the MCP sidecar (§14).
pub fn get_clusters(conn: &Connection) -> rusqlite::Result<Vec<ClusterGroup>> {
    // ponytail: LIMIT is a safety cap so a future full-vault clusters table can't blow
    // up one MCP response (clusters is empty until the embeddings phase). Phase 11 adds
    // real pagination when there's data to page.
    let mut stmt = conn.prepare(
        "SELECT c.cluster_id, n.path, n.title
         FROM clusters c JOIN notes n ON n.path = c.path
         ORDER BY c.cluster_id, n.path
         LIMIT 5000",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
    })?;
    let mut groups: Vec<ClusterGroup> = Vec::new();
    for row in rows {
        let (cid, path, title) = row?;
        if groups.last().map(|g| g.cluster_id) != Some(cid) {
            groups.push(ClusterGroup {
                cluster_id: cid,
                members: Vec::new(),
            });
        }
        // safe: just pushed if the id changed, so last() exists
        if let Some(g) = groups.last_mut() {
            g.members.push(ClusterMember { path, title });
        }
    }
    Ok(groups)
}

/// All stored note embeddings for `model`: (path, decoded f32 vector). Reads the
/// `embeddings` BLOB store (populated by `recompute_clusters`). Filtering by `model`
/// guards against a stale row from a previous embedding model decoding to a wrong-length
/// vector (Phase 13 / ADR-20260618). This is the read path for brute-force KNN search.
pub fn read_embeddings(conn: &Connection, model: &str) -> rusqlite::Result<Vec<(String, Vec<f32>)>> {
    let mut stmt = conn.prepare("SELECT path, vector FROM embeddings WHERE model = ?1")?;
    let rows = stmt.query_map(params![model], |r| {
        let path: String = r.get(0)?;
        let blob: Vec<u8> = r.get(1)?;
        Ok((path, crate::embed::blob_to_vec(&blob)))
    })?;
    rows.collect()
}

/// `(embeddings_count, notes_count)` — a cheap freshness proxy. `embeddings` is refreshed
/// ONLY by `recompute_clusters` (the manual Clusters button), never by the incremental
/// indexer (ADR-20260618), so `embeddings_count < notes_count` means some notes are
/// unembedded and semantic results are stale. `embeddings_count == 0` means semantic
/// search isn't available yet (recompute to enable). The count is filtered by `model` to
/// MATCH `read_embeddings` — otherwise a table of old-model rows would report `ready` while
/// the (model-filtered) corpus the scan actually sees is empty. ponytail ceiling: a
/// cardinality proxy can't detect same-count content drift (an edited note since the last
/// recompute); a content-hash/`indexed_at` check would, if it ever bites.
pub fn embedding_freshness(conn: &Connection, model: &str) -> rusqlite::Result<(i64, i64)> {
    let emb: i64 =
        conn.query_row("SELECT COUNT(*) FROM embeddings WHERE model = ?1", params![model], |r| r.get(0))?;
    let notes: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))?;
    Ok((emb, notes))
}

/// v2.0 model-version guard: drop embedding rows from ANY model other than the current
/// one. Called at vault-open so swapping `MODEL_NAME` (a rebuilt binary) can't leave
/// stale-meaning vectors in the table. The model column already filters reads, so this is
/// belt-and-suspenders + space reclaim — NOT an automatic re-embed (the freshness check
/// then prompts a manual recompute; no startup storm — ADR-20260618-rose-glass-v2).
/// Returns the number of rows purged.
pub fn purge_stale_embeddings(conn: &Connection, model: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM embeddings WHERE model != ?1", params![model])
}

/// Titles for a set of result paths, in the order given (a note path always has a row in
/// `notes`; falls back to the path if somehow missing). Used to enrich KNN hits — only
/// the top-k, so the per-row lookup is cheap.
pub fn titles_for(conn: &Connection, scored: Vec<crate::knn::Scored>) -> Vec<SemanticHit> {
    scored
        .into_iter()
        .map(|h| {
            let title: String = conn
                .query_row("SELECT title FROM notes WHERE path = ?1", params![h.path], |r| r.get(0))
                .unwrap_or_else(|_| h.path.clone());
            SemanticHit {
                path: h.path,
                title,
                score: h.score,
            }
        })
        .collect()
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
             FROM links WHERE dst_path IS NOT NULL AND dst_path <> src_path",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(GraphEdgeMeta {
                src: r.get(0)?,
                dst: r.get(1)?,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    let cluster_count: i64 =
        conn.query_row("SELECT COUNT(DISTINCT cluster_id) FROM clusters", [], |r| r.get(0))?;

    Ok(GraphPayload { nodes, edges, cluster_count })
}

#[derive(Serialize)]
pub struct ManifestEntry {
    pub path: String,
    pub title: String,
    pub summary: Option<String>,
    pub status: Option<String>,
    pub tags: Vec<String>,
    pub summary_present: bool,
}

/// One row per note: path/title + summary/status pulled out of the frontmatter JSON, plus the
/// note's tags. The whole-vault triage surface for the agent (replaces grepping). A note with
/// no/empty frontmatter `summary` is flagged (summary_present=false) so the agent can backfill.
/// ponytail: re-prepares the tags statement per row (N+1) — fine at personal-vault scale; batch
/// into one `tags` scan + group if a huge vault ever makes this manifest call slow.
pub fn manifest(conn: &Connection) -> rusqlite::Result<Vec<ManifestEntry>> {
    let mut stmt = conn.prepare("SELECT path, title, frontmatter FROM notes ORDER BY path")?;
    let base: Vec<(String, String, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<String>>(2)?)))?
        .collect::<rusqlite::Result<_>>()?;

    let mut out = Vec::with_capacity(base.len());
    for (path, title, fm_json) in base {
        let fm: Option<serde_json::Value> = fm_json.and_then(|s| serde_json::from_str(&s).ok());
        let field = |k: &str| -> Option<String> {
            fm.as_ref()
                .and_then(|v| v.get(k))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.trim().is_empty())
        };
        let summary = field("summary");
        let status = field("status");
        let tags: Vec<String> = {
            let mut ts = conn.prepare("SELECT tag FROM tags WHERE path=?1 ORDER BY tag")?;
            let rows = ts.query_map(params![path], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let summary_present = summary.is_some();
        out.push(ManifestEntry { path, title, summary, status, tags, summary_present });
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct RelatedResult {
    pub ready: bool,
    pub neighbors: Vec<SemanticHit>,
}

/// Notes most similar to `path` by cosine over STORED embeddings — MODEL-FREE (the note's own
/// vector is already in `embeddings`, so no ONNX load). Mirrors `commands::related_notes` without
/// its lock/telemetry wrapper. `ready=false` when no embeddings exist yet (the app hasn't run the
/// Clusters recompute), so an empty list reads as "not ready", NOT "no neighbours". Self-excluded.
pub fn related(conn: &Connection, path: &str, k: usize) -> rusqlite::Result<RelatedResult> {
    let corpus = read_embeddings(conn, crate::embed::MODEL_NAME)?;
    if corpus.is_empty() {
        return Ok(RelatedResult { ready: false, neighbors: vec![] });
    }
    // The note may not be embedded yet (added since the last recompute): ready, but no neighbours.
    let Some((_, query_vec)) = corpus.iter().find(|(p, _)| p == path).cloned() else {
        return Ok(RelatedResult { ready: true, neighbors: vec![] });
    };
    let scored = crate::knn::knn(&query_vec, &corpus, k, Some(path));
    Ok(RelatedResult { ready: true, neighbors: titles_for(conn, scored) })
}

#[derive(Serialize)]
pub struct MaintenanceReport {
    pub note_count: i64,
    pub embedded_count: i64,
    pub embeddings_stale: bool,
    pub missing_summary: Vec<String>,
    pub orphans: Vec<String>,
}

/// Read-only upkeep report: note vs (current-model) embedding counts (stale if they differ),
/// notes with no frontmatter summary, and orphans (no resolved outbound AND no inbound links).
/// Does NOT re-embed (that needs the model, app-side) — it only surfaces what to fix, per the
/// ADR's on-demand-not-a-session-hook decision. `embedded_count` is MODEL-FILTERED (reuses
/// embedding_freshness) so the stale flag reflects the corpus `related`/`search` actually see.
pub fn maintenance_report(conn: &Connection) -> rusqlite::Result<MaintenanceReport> {
    let (embedded_count, note_count) = embedding_freshness(conn, crate::embed::MODEL_NAME)?;
    let missing_summary: Vec<String> = manifest(conn)?
        .into_iter()
        .filter(|e| !e.summary_present)
        .map(|e| e.path)
        .collect();
    let orphans: Vec<String> = {
        // Exclude SELF-links from both clauses: the resolver legitimately emits dst_path == src_path
        // for an intra-note link (e.g. `[[#heading]]` or `[[self]]`), which is NOT a real graph
        // connection — without the `!= n.path` guards a note whose only link is to itself would be
        // hidden from the orphan list, defeating the report's purpose.
        let mut stmt = conn.prepare(
            "SELECT n.path FROM notes n
             WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.src_path = n.path AND l.dst_path IS NOT NULL AND l.dst_path <> n.path)
               AND NOT EXISTS (SELECT 1 FROM links l WHERE l.dst_path = n.path AND l.src_path <> n.path)
             ORDER BY n.path",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    Ok(MaintenanceReport {
        note_count,
        embedded_count,
        embeddings_stale: embedded_count != note_count,
        missing_summary,
        orphans,
    })
}

#[cfg(test)]
mod semantic_tests {
    use super::*;
    use crate::embed::{vec_to_blob, MODEL_NAME};

    fn seed(conn: &Connection, path: &str, title: &str, vec: &[f32], model: &str) {
        conn.execute(
            "INSERT INTO notes (path,title,content_hash,mtime,word_count,indexed_at) VALUES (?1,?2,'h',0,1,0)",
            params![path, title],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO embeddings (path, vector, model) VALUES (?1,?2,?3)",
            params![path, vec_to_blob(vec), model],
        )
        .unwrap();
    }

    #[test]
    fn manifest_lists_notes_and_flags_missing_summary() {
        let conn = crate::db::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO notes (path,title,frontmatter,content_hash,mtime,word_count,indexed_at)
             VALUES ('a.md','A','{\"summary\":\"hi\",\"status\":\"active\"}','h',0,1,0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO notes (path,title,content_hash,mtime,word_count,indexed_at)
             VALUES ('b.md','B','h',0,1,0)",
            [],
        ).unwrap();
        let m = manifest(&conn).unwrap();
        assert_eq!(m.len(), 2);
        let a = m.iter().find(|e| e.path == "a.md").unwrap();
        assert_eq!(a.summary.as_deref(), Some("hi"));
        assert_eq!(a.status.as_deref(), Some("active"));
        assert!(a.summary_present);
        let b = m.iter().find(|e| e.path == "b.md").unwrap();
        assert!(!b.summary_present, "b.md has no frontmatter summary");
    }

    #[test]
    fn related_is_not_ready_with_no_embeddings() {
        let conn = crate::db::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO notes (path,title,content_hash,mtime,word_count,indexed_at) VALUES ('a.md','A','h',0,1,0)",
            [],
        ).unwrap();
        let r = related(&conn, "a.md", 5).unwrap();
        assert!(!r.ready, "no embeddings → not ready");
        assert!(r.neighbors.is_empty());
    }

    #[test]
    fn related_ranks_nearest_excluding_self() {
        let conn = crate::db::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        seed(&conn, "a.md", "A", &[1.0, 0.0, 0.0], MODEL_NAME);
        seed(&conn, "b.md", "B", &[0.9, 0.1, 0.0], MODEL_NAME); // near a
        seed(&conn, "c.md", "C", &[0.0, 0.0, 1.0], MODEL_NAME); // far
        let r = related(&conn, "a.md", 1).unwrap();
        assert!(r.ready);
        assert_eq!(r.neighbors.len(), 1);
        assert_eq!(r.neighbors[0].path, "b.md", "b is nearest; self excluded");
    }

    #[test]
    fn maintenance_report_flags_orphans_and_missing_summary() {
        let conn = crate::db::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        // a.md: has a summary + an outgoing resolved link to b.md (not an orphan)
        conn.execute("INSERT INTO notes (path,title,frontmatter,content_hash,mtime,word_count,indexed_at) VALUES ('a.md','A','{\"summary\":\"s\"}','h',0,1,0)", []).unwrap();
        // b.md: no summary, but an inbound link from a.md (not an orphan)
        conn.execute("INSERT INTO notes (path,title,content_hash,mtime,word_count,indexed_at) VALUES ('b.md','B','h',0,1,0)", []).unwrap();
        conn.execute("INSERT INTO links (src_path,dst_path,dst_raw,link_type) VALUES ('a.md','b.md','b','wikilink')", []).unwrap();
        let r = maintenance_report(&conn).unwrap();
        assert_eq!(r.note_count, 2);
        assert!(r.embeddings_stale, "0 embeddings for 2 notes");
        assert!(r.missing_summary.contains(&"b.md".to_string()));
        assert!(!r.orphans.contains(&"b.md".to_string()), "b.md has an inbound link");
    }

    #[test]
    fn maintenance_report_counts_a_self_linking_note_as_an_orphan() {
        // A note whose ONLY link is a resolved self-link ([[#heading]] / [[self]]) has no real
        // graph connections — it must still be reported as an orphan (regression: self-links were
        // counted as connections, hiding exactly the disconnected notes the report exists to find).
        let conn = crate::db::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute("INSERT INTO notes (path,title,content_hash,mtime,word_count,indexed_at) VALUES ('x.md','X','h',0,1,0)", []).unwrap();
        conn.execute("INSERT INTO links (src_path,dst_path,dst_raw,link_type) VALUES ('x.md','x.md','#heading','wikilink')", []).unwrap();
        let r = maintenance_report(&conn).unwrap();
        assert!(r.orphans.contains(&"x.md".to_string()), "a self-link is not a real connection");
    }

    #[test]
    fn graph_payload_reports_distinct_cluster_count() {
        let conn = crate::db::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        // empty clusters table → 0 (the post-open state that used to be hardcoded)
        assert_eq!(get_graph_payload(&conn).unwrap().cluster_count, 0);
        for (p, cid) in [("a.md", 0), ("b.md", 0), ("c.md", 1)] {
            conn.execute(
                "INSERT INTO notes (path,title,content_hash,mtime,word_count,indexed_at) VALUES (?1,'T','h',0,1,0)",
                params![p],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO clusters (path,cluster_id,computed_at) VALUES (?1,?2,0)",
                params![p, cid],
            )
            .unwrap();
        }
        let payload = get_graph_payload(&conn).unwrap();
        assert_eq!(payload.cluster_count, 2, "two distinct cluster ids");
        assert_eq!(payload.nodes.len(), 3);
    }

    #[test]
    fn purge_stale_embeddings_drops_other_models_only() {
        let conn = crate::db::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        seed(&conn, "cur.md", "Cur", &[1.0, 0.0], MODEL_NAME);
        seed(&conn, "old.md", "Old", &[9.0; 768], "some-old-model");

        let purged = purge_stale_embeddings(&conn, MODEL_NAME).unwrap();
        assert_eq!(purged, 1, "only the wrong-model row is dropped");
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 1, "the current-model row survives");
        // idempotent: a second purge with no stale rows drops nothing
        assert_eq!(purge_stale_embeddings(&conn, MODEL_NAME).unwrap(), 0);
    }

    #[test]
    fn read_embeddings_decodes_and_filters_by_model() {
        let conn = crate::db::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        seed(&conn, "a.md", "A", &[1.0, 0.0, 0.0], MODEL_NAME);
        seed(&conn, "b.md", "B", &[0.0, 1.0, 0.0], MODEL_NAME);
        seed(&conn, "old.md", "Old", &[9.0; 768], "some-old-model"); // wrong model + wrong dim

        let corpus = read_embeddings(&conn, MODEL_NAME).unwrap();
        assert_eq!(corpus.len(), 2, "the wrong-model row is filtered out");
        let a = corpus.iter().find(|(p, _)| p == "a.md").unwrap();
        assert_eq!(a.1, vec![1.0, 0.0, 0.0], "BLOB round-trips back to the vector");
    }

    #[test]
    fn freshness_reports_empty_and_stale() {
        let conn = crate::db::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        // empty: a note exists but no embeddings
        conn.execute(
            "INSERT INTO notes (path,title,content_hash,mtime,word_count,indexed_at) VALUES ('n.md','N','h',0,1,0)",
            [],
        )
        .unwrap();
        let (emb, notes) = embedding_freshness(&conn, MODEL_NAME).unwrap();
        assert_eq!((emb, notes), (0, 1), "no embeddings yet ⇒ not ready");

        // a row under a DIFFERENT model must NOT count toward freshness (matches the
        // model-filtered read path, so ready/stale can't disagree with the scanned corpus)
        seed(&conn, "old.md", "Old", &[1.0, 0.0], "some-old-model");
        let (emb, _) = embedding_freshness(&conn, MODEL_NAME).unwrap();
        assert_eq!(emb, 0, "an old-model row is not counted as ready under MODEL_NAME");

        // stale: 3 notes, 1 embedded under the current model
        seed(&conn, "m.md", "M", &[1.0, 0.0], MODEL_NAME);
        let (emb, notes) = embedding_freshness(&conn, MODEL_NAME).unwrap();
        assert!(emb < notes, "1 current-model embedding < 3 notes ⇒ stale");
    }

    #[test]
    fn end_to_end_related_ranks_nearest_and_excludes_self() {
        let conn = crate::db::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        // query note "me" points along x; "near" is close, "far" is orthogonal.
        seed(&conn, "me.md", "Me", &[1.0, 0.0, 0.0], MODEL_NAME);
        seed(&conn, "near.md", "Near", &[0.9, 0.1, 0.0], MODEL_NAME);
        seed(&conn, "far.md", "Far", &[0.0, 0.0, 1.0], MODEL_NAME);

        let corpus = read_embeddings(&conn, MODEL_NAME).unwrap();
        let me = corpus.iter().find(|(p, _)| p == "me.md").unwrap().1.clone();
        let scored = crate::knn::knn(&me, &corpus, 5, Some("me.md"));
        let hits = titles_for(&conn, scored);

        assert!(hits.iter().all(|h| h.path != "me.md"), "self excluded");
        assert_eq!(hits[0].path, "near.md", "nearest neighbour ranks first");
        assert_eq!(hits[0].title, "Near", "title attached from notes");
        assert!(hits[0].score > hits[1].score, "near scores above far");
    }

    /// Phase 13 end-to-end with the REAL neural model: a free-text query ranks the
    /// topically-matching note above an unrelated one (the whole point of semantic search).
    /// #[ignore]d — reuses the cached ONNX model from the Phase-11 spike; run with --ignored.
    #[test]
    #[ignore = "uses the real ONNX model (cached after the embed spike); run with --ignored"]
    fn semantic_search_ranks_topically_with_real_model() {
        let dir = std::env::temp_dir().join("rg-fastembed-cache");
        let mut model = crate::embed::new_model(&dir).unwrap();
        let corpus_texts: Vec<&str> = vec![
            "boil water add salt and cook the spaghetti al dente then drain",
            "a neutron star is the dense collapsed core left by a massive star",
        ];
        let vecs = crate::embed::embed_texts(&mut model, &corpus_texts).unwrap();
        let corpus: Vec<(String, Vec<f32>)> = vec!["pasta.md".to_string(), "stars.md".to_string()]
            .into_iter()
            .zip(vecs)
            .collect();
        let qv = crate::embed::embed_texts(&mut model, &["how do I cook pasta"])
            .unwrap()
            .remove(0);
        let hits = crate::knn::knn(&qv, &corpus, 2, None);
        assert_eq!(hits[0].path, "pasta.md", "a cooking query ranks the cooking note first");
        assert!(hits[0].score > hits[1].score, "the cooking note scores strictly higher");
    }
}
