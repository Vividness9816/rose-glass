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

    Ok(GraphPayload { nodes, edges })
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
