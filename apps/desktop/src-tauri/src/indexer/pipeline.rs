//! The indexer pipeline: full rebuild (two-pass, single tx), incremental
//! (hash-gated, idempotent), delete (cascade). Both write paths share ONE
//! resolution function (`resolve`) so they converge to identical output (A3).

use super::hash::content_hash;
use super::{parse_note, resolve, IndexOutcome, NoteIndex, ResolvedLink};
use crate::db::queries::{self, NoteRow};
use rusqlite::Connection;
use ignore::WalkBuilder;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn mtime_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn is_markdown(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("md") | Some("markdown")
    )
}

/// Path segments that are never notes — build artifacts, deps, tool dirs. Combined
/// with the dot-prefix rule this is the ONE skip floor shared by `full_rebuild`,
/// `incremental`, AND the watcher, so all three converge on the same note set (A3).
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "vendor"];

/// True if this vault-relative path lives under a hidden or skipped segment and must
/// not be indexed. Operates on the forward-slash rel path so every write path agrees.
/// ponytail: hardcoded floor, no per-project `.gitignore` parsing. `.gitignore` respect
/// was dropped deliberately — a gitignored-but-not-skipped `.md` edited live would be
/// watcher-indexed yet rebuild-excluded, breaking A3. Re-add only via a shared nested
/// matcher across all three paths if it's ever worth the plumbing (see ADR-20260618-v2).
pub(crate) fn should_skip(rel: &str) -> bool {
    rel.split('/').any(|seg| {
        if seg.starts_with('.') {
            return true;
        }
        // Windows FS is case-insensitive — "Node_Modules" must skip like "node_modules"
        // (mirrors activity.rs's Windows-only case-fold). On Linux those are distinct dirs.
        if cfg!(windows) {
            SKIP_DIRS.iter().any(|s| seg.eq_ignore_ascii_case(s))
        } else {
            SKIP_DIRS.contains(&seg)
        }
    })
}

/// Vault-relative, forward-slash path; `None` if the name isn't valid UTF-8.
/// ponytail: NFC normalization skipped (needs a dep for a rare decomposed-name
/// edge case); upgrade with `unicode-normalization` if non-ASCII names misbehave.
pub(crate) fn normalize_rel(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    Some(rel.to_str()?.replace('\\', "/"))
}

fn note_row(rel: &str, p: &super::ParsedNote, mtime: i64) -> NoteRow {
    NoteRow {
        path: rel.to_string(),
        title: p.title.clone(),
        frontmatter_json: p.frontmatter_json.clone(),
        content_hash: p.content_hash.clone(),
        mtime,
        word_count: p.word_count,
        indexed_at: now_ms(),
    }
}

pub fn full_rebuild(conn: &mut Connection, vault_root: &Path) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    queries::clear_all_derived(&tx)?;

    // PASS 1 — populate the path universe + notes/tags/fts; stash unresolved links
    let mut stash: Vec<(String, Vec<super::RawLink>)> = Vec::new();
    // `ignore::WalkBuilder` with standard filters OFF: we own the skip policy via
    // `should_skip` so it is byte-identical to the incremental/watcher paths (A3).
    // Symlinks are not followed (no loops). Pruning a dir here stops descent — so a
    // home-dir vault skips node_modules/.git/etc. instead of walking 17k junk files.
    let walker = {
        let root = vault_root.to_path_buf();
        WalkBuilder::new(vault_root)
            .standard_filters(false)
            .follow_links(false)
            .filter_entry(move |e| match normalize_rel(&root, e.path()) {
                // keep the root ("") and any non-UTF8 entry; the file-level filter
                // below drops non-markdown / unreadable names
                Some(rel) if !rel.is_empty() => !should_skip(&rel),
                _ => true,
            })
            .build()
    };
    for entry in walker.filter_map(|e| e.ok()) {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false)
            || !is_markdown(entry.path())
        {
            continue;
        }
        let Some(rel) = normalize_rel(vault_root, entry.path()) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        let p = parse_note(&rel, &bytes);
        let mtime = mtime_ms(entry.path());
        queries::upsert_note(&tx, &note_row(&rel, &p, mtime))?;
        queries::replace_tags(&tx, &rel, &p.tags)?;
        queries::replace_fts(&tx, &rel, &p.title, &p.fts_body)?;
        stash.push((rel, p.links));
    }

    // PASS 2 — resolve every link against the complete note set
    let paths: Vec<String> = stash.iter().map(|(r, _)| r.clone()).collect();
    let idx = NoteIndex::build(&paths);
    for (rel, raw_links) in &stash {
        let resolved: Vec<ResolvedLink> = raw_links
            .iter()
            .map(|l| ResolvedLink {
                dst_path: resolve(&l.target, rel, &idx),
                dst_raw: l.dst_raw.clone(),
                link_type: l.link_type,
            })
            .collect();
        queries::replace_links(&tx, rel, &resolved)?;
    }

    tx.commit()?;
    Ok(stash.len())
}

pub fn incremental(
    conn: &mut Connection,
    vault_root: &Path,
    rel: &str,
) -> rusqlite::Result<IndexOutcome> {
    // Same skip floor as full_rebuild/watcher — never index junk, so a live edit can't
    // create a node a later rebuild would drop (A3).
    if should_skip(rel) {
        return Ok(IndexOutcome::Skipped);
    }
    let abs = vault_root.join(rel);
    if !abs.exists() {
        return delete(conn, rel); // race: gone before we read
    }

    let st_mtime = mtime_ms(&abs);
    let meta = queries::note_meta(conn, rel)?;
    if let Some((_, m)) = &meta {
        if *m == st_mtime {
            return Ok(IndexOutcome::Skipped); // gate 1: cheap, no read
        }
    }

    let Ok(bytes) = std::fs::read(&abs) else {
        return Ok(IndexOutcome::Skipped);
    };
    let new_hash = content_hash(&bytes);
    if let Some((h, _)) = &meta {
        if *h == new_hash {
            queries::touch_mtime(conn, rel, st_mtime)?; // keep gate-1 fast next time
            return Ok(IndexOutcome::Skipped); // gate 2: authoritative
        }
    }

    let was_new = meta.is_none();
    let p = parse_note(rel, &bytes);
    let mut idx = queries::load_note_index(conn)?;
    if was_new {
        idx.add(rel); // ensure self is resolvable for intra-note links
    }

    let tx = conn.transaction()?;
    queries::upsert_note(&tx, &note_row(rel, &p, st_mtime))?;
    queries::replace_tags(&tx, rel, &p.tags)?;
    queries::replace_fts(&tx, rel, &p.title, &p.fts_body)?;
    let resolved: Vec<ResolvedLink> = p
        .links
        .iter()
        .map(|l| ResolvedLink {
            dst_path: resolve(&l.target, rel, &idx),
            dst_raw: l.dst_raw.clone(),
            link_type: l.link_type,
        })
        .collect();
    queries::replace_links(&tx, rel, &resolved)?;
    if was_new {
        // the path set grew → other links' stem resolution may change
        queries::reresolve_links(&tx, &idx)?;
    }
    tx.commit()?;
    Ok(IndexOutcome::Indexed)
}

pub fn delete(conn: &mut Connection, rel: &str) -> rusqlite::Result<IndexOutcome> {
    let tx = conn.transaction()?;
    queries::delete_note(&tx, rel)?;
    // the path set shrank → re-resolve all links against survivors so links
    // orphaned by ON DELETE SET NULL re-point to surviving stem siblings (A3 parity)
    let idx = queries::load_note_index(&tx)?;
    queries::reresolve_links(&tx, &idx)?;
    tx.commit()?;
    Ok(IndexOutcome::Deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::collections::{BTreeSet, HashMap, HashSet};
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("vault")
    }

    fn mem() -> Connection {
        let conn = db::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        conn
    }

    fn note_paths(conn: &Connection) -> HashSet<String> {
        conn.prepare("SELECT path FROM notes")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn full_rebuild_indexes_expected_set() {
        let mut conn = mem();
        assert_eq!(full_rebuild(&mut conn, &fixture()).unwrap(), 4);
        let paths = note_paths(&conn);
        for p in ["a.md", "b.md", "c.md", "sub/d.md"] {
            assert!(paths.contains(p), "missing {p}");
        }
        assert!(!paths.iter().any(|p| p.contains(".obsidian")));
        assert!(!paths.iter().any(|p| p.ends_with(".bak")));
    }

    #[test]
    fn should_skip_is_the_shared_floor() {
        for junk in [
            "node_modules/pkg/README.md",
            "a/target/debug/x.md",
            "dist/bundle.md",
            ".obsidian/workspace.md",
            ".git/x.md",
            "notes/.hidden.md",
        ] {
            assert!(should_skip(junk), "should skip {junk}");
        }
        for real in ["notes/real.md", "a/b/c.md", "inbox/dropped.md"] {
            assert!(!should_skip(real), "should keep {real}");
        }
    }

    #[test]
    #[cfg(windows)]
    fn should_skip_is_case_insensitive_on_windows() {
        // Windows FS is case-insensitive: a mixed-case junk dir must still be skipped, else
        // a live edit could index a note a rebuild drops (or vice versa).
        assert!(should_skip("Node_Modules/pkg/x.md"));
        assert!(should_skip("a/TARGET/debug/x.md"));
        assert!(!should_skip("notes/real.md"));
    }

    #[test]
    fn rebuild_and_incremental_agree_on_skip_floor() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("node_modules/pkg/README.md"), b"junk").unwrap();
        std::fs::write(root.join("notes/real.md"), b"real").unwrap();

        // full_rebuild prunes the junk dir, keeps the real note
        let mut conn = mem();
        full_rebuild(&mut conn, root).unwrap();
        let paths = note_paths(&conn);
        assert!(paths.contains("notes/real.md"));
        assert!(!paths.iter().any(|p| p.contains("node_modules")));

        // incremental refuses the SAME junk path → no node a rebuild would drop (A3 parity)
        assert_eq!(
            incremental(&mut conn, root, "node_modules/pkg/README.md").unwrap(),
            IndexOutcome::Skipped
        );
        assert!(!note_paths(&conn).iter().any(|p| p.contains("node_modules")));
    }

    #[test]
    fn backlinks_and_dangling() {
        let mut conn = mem();
        full_rebuild(&mut conn, &fixture()).unwrap();
        let srcs: HashSet<String> = queries::get_backlinks(&conn, "c.md")
            .unwrap()
            .into_iter()
            .map(|b| b.src_path)
            .collect();
        assert!(srcs.contains("a.md")); // [link](c.md)
        assert!(srcs.contains("b.md")); // ![[c]]
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM links WHERE src_path='b.md' AND dst_path IS NULL"),
            1 // [[missing-note]]
        );
    }

    #[test]
    fn tags_and_search() {
        let mut conn = mem();
        full_rebuild(&mut conn, &fixture()).unwrap();
        let map: HashMap<String, i64> = queries::get_tags(&conn)
            .unwrap()
            .into_iter()
            .map(|t| (t.tag, t.count))
            .collect();
        assert_eq!(map.get("x"), Some(&2)); // a.md (fm) + c.md (#x)
        assert_eq!(map.get("y"), Some(&1));
        assert_eq!(map.get("inline"), Some(&1));

        assert!(queries::search_fts(&conn, "beta")
            .unwrap()
            .iter()
            .any(|h| h.path == "b.md"));
        assert!(queries::search_fts(&conn, "weird:query-with:colons").is_ok());
    }

    #[test]
    fn delete_cascade_and_set_null() {
        let mut conn = mem();
        full_rebuild(&mut conn, &fixture()).unwrap();
        delete(&mut conn, "b.md").unwrap();
        assert!(!note_paths(&conn).contains("b.md"));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM links WHERE src_path='b.md'"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM notes_fts WHERE path='b.md'"), 0);
        let (dst, raw): (Option<String>, String) = conn
            .query_row(
                "SELECT dst_path, dst_raw FROM links WHERE src_path='a.md' AND dst_raw='b'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(dst.is_none(), "inbound link should be SET NULL");
        assert_eq!(raw, "b", "dst_raw preserved");
    }

    #[test]
    fn incremental_gate_dupes_and_dangling_resolution() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("x.md"), b"[[y]] and [[y]] again, plus [[z]]").unwrap();
        let mut conn = mem();

        assert_eq!(incremental(&mut conn, root, "x.md").unwrap(), IndexOutcome::Indexed);
        // unchanged re-run is a no-op
        assert_eq!(incremental(&mut conn, root, "x.md").unwrap(), IndexOutcome::Skipped);
        // duplicate edge preserved (multiplicity = weight)
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM links WHERE src_path='x.md' AND dst_raw='y'"),
            2
        );
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM links WHERE dst_path IS NULL"), 3);

        // creating the target resolves the previously-dangling links (convergence)
        std::fs::write(root.join("y.md"), b"hello").unwrap();
        assert_eq!(incremental(&mut conn, root, "y.md").unwrap(), IndexOutcome::Indexed);
        assert!(queries::get_backlinks(&conn, "y.md")
            .unwrap()
            .iter()
            .any(|b| b.src_path == "x.md"));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM links WHERE dst_path IS NULL"), 1); // only z
    }

    #[test]
    fn incremental_matches_full_rebuild_under_stem_collision() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        std::fs::write(root.join("a/Note.md"), b"alpha").unwrap();
        std::fs::write(root.join("b/Note.md"), b"beta").unwrap();
        std::fs::write(root.join("ref.md"), b"points to [[Note]]").unwrap();

        let mut full = mem();
        full_rebuild(&mut full, root).unwrap();
        let want: Option<String> = full
            .query_row("SELECT dst_path FROM links WHERE src_path='ref.md'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(want.as_deref(), Some("a/Note.md")); // lexicographically smallest

        // incremental in an order that first resolves to b, then adds the smaller a
        let mut inc = mem();
        incremental(&mut inc, root, "b/Note.md").unwrap();
        incremental(&mut inc, root, "ref.md").unwrap();
        let mid: Option<String> = inc
            .query_row("SELECT dst_path FROM links WHERE src_path='ref.md'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mid.as_deref(), Some("b/Note.md")); // only candidate so far
        incremental(&mut inc, root, "a/Note.md").unwrap(); // adding smaller sibling must re-point
        let got: Option<String> = inc
            .query_row("SELECT dst_path FROM links WHERE src_path='ref.md'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(got, want, "incremental add must converge to full-rebuild resolution");
    }

    #[test]
    fn delete_winner_repoints_to_surviving_sibling() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        std::fs::write(root.join("a/Note.md"), b"alpha").unwrap();
        std::fs::write(root.join("b/Note.md"), b"beta").unwrap();
        std::fs::write(root.join("ref.md"), b"points to [[Note]]").unwrap();

        let mut conn = mem();
        full_rebuild(&mut conn, root).unwrap(); // ref → a/Note.md
        delete(&mut conn, "a/Note.md").unwrap();
        let got: Option<String> = conn
            .query_row("SELECT dst_path FROM links WHERE src_path='ref.md'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(got.as_deref(), Some("b/Note.md"), "must re-point, not dangle");
    }

    // ── A3: delete DB → rebuild → equivalent index ──────────────────────────
    fn rows(conn: &Connection, sql: &str) -> BTreeSet<String> {
        let mut stmt = conn.prepare(sql).unwrap();
        let cols = stmt.column_count();
        stmt.query_map([], |r| {
            let mut parts = Vec::with_capacity(cols);
            for i in 0..cols {
                let v: rusqlite::types::Value = r.get(i)?;
                parts.push(format!("{v:?}"));
            }
            Ok(parts.join("|"))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    type Snapshot = (
        BTreeSet<String>,
        BTreeSet<String>,
        BTreeSet<String>,
        BTreeSet<String>,
    );

    fn snapshot(conn: &Connection) -> Snapshot {
        (
            // exclude mtime/indexed_at — wall-clock/FS-derived, not content
            rows(conn, "SELECT path,title,frontmatter,content_hash,word_count FROM notes"),
            rows(conn, "SELECT src_path,dst_path,dst_raw,link_type FROM links"),
            rows(conn, "SELECT path,tag FROM tags"),
            rows(conn, "SELECT path,title,body FROM notes_fts"),
        )
    }

    #[test]
    fn a3_delete_db_rebuild_is_equivalent() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("index.db");
        let vault = fixture();

        let mut c1 = db::open_db(&db_path).unwrap();
        db::migrate(&c1).unwrap();
        full_rebuild(&mut c1, &vault).unwrap();
        let snap1 = snapshot(&c1);
        drop(c1);

        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{}", db_path.display(), suffix));
        }

        let mut c2 = db::open_db(&db_path).unwrap();
        db::migrate(&c2).unwrap();
        full_rebuild(&mut c2, &vault).unwrap();
        let snap2 = snapshot(&c2);

        assert_eq!(snap1, snap2, "index must rebuild to an equivalent state");
    }
}
