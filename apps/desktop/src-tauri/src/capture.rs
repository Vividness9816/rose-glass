//! The single confined write path shared by the MCP write tool. Writes a markdown FILE
//! (canonical) then derives the SQLite row via pipeline::incremental — never writes the DB
//! directly, so the A3 rebuild-equivalence invariant holds. All agent writes funnel here.

use crate::fs_safe::{atomic_write, safe_join};
use crate::indexer::pipeline::{incremental, is_markdown, should_skip};
use crate::indexer::IndexOutcome;
use rusqlite::Connection;
use std::path::{Component, Path};

/// Assemble schema-valid markdown: YAML frontmatter (title, mandatory summary, optional tags)
/// then the body. Values are serialized through `serde_yaml_ng` — NOT hand-formatted — so any value
/// (a colon, '#', '[', a newline, a reserved word) is correctly quoted/escaped and the file
/// always round-trips back to the intended title/summary/tags through the indexer's parser.
/// (A naive `format!("title: {v}")` silently dropped the WHOLE frontmatter on ordinary inputs
/// like "Meeting: Q3 plan" and let a newline inject sibling keys — review HIGH, both fixed here.)
pub fn build_markdown(title: &str, summary: &str, tags: &[String], body: &str) -> String {
    use serde_yaml_ng::{Mapping, Value};
    let mut map = Mapping::new();
    map.insert(Value::String("title".into()), Value::String(title.trim().to_string()));
    map.insert(Value::String("summary".into()), Value::String(summary.trim().to_string()));
    if !tags.is_empty() {
        let seq = tags.iter().map(|t| Value::String(t.clone())).collect();
        map.insert(Value::String("tags".into()), Value::Sequence(seq));
    }
    // to_string emits a trailing '\n' and never a leading '---' document marker.
    let yaml = serde_yaml_ng::to_string(&Value::Mapping(map)).unwrap_or_default();
    format!("---\n{yaml}---\n\n{}\n", body.trim_end())
}

/// `inbox/<slug>.md` from a title: lowercase, runs of non-alphanumeric → single '-', trimmed.
/// ASCII-only (the index has no NFC normalization — pipeline.rs:63 — so we keep names round-trippable).
/// NOTE: this is a pure slug fn and does NOT dedup — two distinct titles can slug to the same path
/// (e.g. "Hello World" / "Hello, World!" → inbox/hello-world.md; all-symbol titles → inbox/note.md).
/// The CREATE-vs-UPDATE intent (and therefore collision disambiguation) lives in the caller
/// (`upsert_note`), which must suffix-dedup new notes so a capture never clobbers a different one.
pub fn derive_rel(title: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in title.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "note" } else { slug };
    format!("inbox/{slug}.md")
}

/// For a NEW capture, pick a vault-relative path that does not clobber a DIFFERENT existing note:
/// `inbox/foo.md` → `inbox/foo-2.md` → `inbox/foo-3.md` … (hyphen suffix, slug-consistent with
/// `derive_rel`; the drag-drop ingest path uses a " (n)" suffix for arbitrary dropped filenames).
/// The CREATE-vs-UPDATE intent lives in the caller (`upsert_note`): a request with an explicit
/// `path` updates in place and skips this; a new capture runs through here so it never overwrites.
/// ponytail: plain exists()-probe, not an atomic create_new reservation — the MCP sidecar is
/// single-threaded, so the only race is a concurrent cross-process app write, which at worst
/// upserts (A3 keeps disk/DB consistent), never corrupts. Use create_new if that race ever bites.
pub fn dedup_rel(root: &Path, rel: &str) -> String {
    if !root.join(rel).exists() {
        return rel.to_string();
    }
    let (stem, dot_ext) = match rel.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (rel.to_string(), String::new()),
    };
    for n in 2..10_000 {
        let candidate = format!("{stem}-{n}{dot_ext}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
    }
    rel.to_string() // pathological collision count; write_note will upsert in place
}

/// The single confined agent write. Validates the path FULLY before touching the filesystem —
/// it must be a MARKDOWN file under `inbox/` (the agent's quarantine; never an arbitrary vault
/// note or non-note file) — writes the file atomically, then derives the SQLite row synchronously
/// (the app/watcher may be down, so we must index in-process). Returns the path actually written.
///
/// Confinement order matters: every reject runs BEFORE `create_dir_all`, because that call mutates
/// the filesystem and a `..`/absolute/backslash path would otherwise create directories outside the
/// vault before `safe_join`'s canonical check could reject the file (review CRITICAL, fixed).
pub fn write_note(
    conn: &mut Connection,
    root: &Path,
    rel: &str,
    content: &str,
) -> Result<String, String> {
    // Forward-slash, vault-relative contract (matches normalize_rel / full_rebuild keying). Reject
    // backslashes: should_skip splits only on '/', so "node_modules\\x.md" would dodge the skip
    // floor, and incremental would key the row "node_modules\\x.md" while full_rebuild keys
    // "node_modules/..."-or-skips it → A3 rebuild-equivalence breaks. Reject up front. (review HIGH)
    if rel.contains('\\') {
        return Err(format!("backslash not allowed in a vault path (use '/'): {rel}"));
    }
    if should_skip(rel) {
        return Err(format!("refusing to write a skipped/invisible path: {rel}"));
    }
    // Reject absolute / drive-rooted / drive-relative / traversing paths via path COMPONENTS before
    // any FS mutation. Catches "/x", "C:\\x", "C:x.md" (drive-relative, NOT is_absolute on Windows),
    // "\\\\unc\\x", and "../x" (should_skip also catches the dot forms — belt and suspenders).
    let p = Path::new(rel);
    let rooted_or_traversing = p.is_absolute()
        || rel.starts_with('/')
        || p.components().any(|c| {
            matches!(
                c,
                Component::Prefix(_) | Component::RootDir | Component::ParentDir | Component::CurDir
            )
        });
    if rooted_or_traversing {
        return Err(format!("refusing an absolute/rooted/traversing path: {rel}"));
    }
    // Confine EVERY agent write to a MARKDOWN file under inbox/ — the ADR's "safe_join (inbox-only)"
    // contract + the plan's Global Constraint ("All MCP write paths confined to <vault>/inbox/").
    // (a) An attacker-supplied `path` can't overwrite an arbitrary existing vault note (README.md,
    // a real source note) — only the agent's own inbox captures. (b) Requiring markdown keeps the
    // write keying-space identical to full_rebuild's is_markdown filter, so a non-.md write can't
    // create a row a rebuild would drop — preserving A3. "inbox/" (trailing slash) also blocks the
    // "inboxevil/x.md" prefix trick.
    if !rel.starts_with("inbox/") {
        return Err(format!("agent writes are confined to inbox/: {rel}"));
    }
    if !is_markdown(Path::new(rel)) {
        return Err(format!("agent writes must be markdown (.md/.markdown): {rel}"));
    }
    // Path is now a clean forward-slash relative path; safe to materialize the parent dir.
    if let Some(slash) = rel.rfind('/') {
        let sub = &rel[..slash];
        std::fs::create_dir_all(root.join(sub)).map_err(|e| e.to_string())?;
    }
    let abs = safe_join(root, rel)?; // final canonical/symlink containment check
    atomic_write(&abs, content).map_err(|e| e.to_string())?;
    match incremental(conn, root, rel) {
        Ok(IndexOutcome::Indexed) | Ok(IndexOutcome::Skipped) => Ok(rel.to_string()),
        // Reachable race: the file was removed (watcher/AV/user) between our write and incremental's
        // existence check, so it deleted any row. Disk and DB stay consistent — report it clearly
        // rather than as a generic "unexpected outcome". (review MEDIUM)
        Ok(IndexOutcome::Deleted) => {
            Err(format!("note vanished during write (concurrent delete): {rel}"))
        }
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexer::parse_note;

    fn open() -> Connection {
        let conn = crate::db::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn
    }

    fn fm(md: &str) -> serde_json::Value {
        let p = parse_note("inbox/x.md", md.as_bytes());
        serde_json::from_str(p.frontmatter_json.as_deref().unwrap()).unwrap()
    }

    #[test]
    fn build_markdown_roundtrips_title_summary_tags_through_parser() {
        let md = build_markdown("My Title", "a one line summary", &["x".into(), "y".into()], "Body text.");
        assert!(md.starts_with("---\n"));
        assert!(md.trim_end().ends_with("Body text."));
        let p = parse_note("inbox/x.md", md.as_bytes());
        assert_eq!(p.title, "My Title");
        let f = serde_json::from_str::<serde_json::Value>(p.frontmatter_json.as_deref().unwrap()).unwrap();
        assert_eq!(f["summary"], "a one line summary");
        assert_eq!(f["tags"], serde_json::json!(["x", "y"]));
    }

    #[test]
    fn build_markdown_escapes_yaml_metachars_so_frontmatter_survives() {
        // ': ', '[', '#' all break a naive `key: value` and would drop the WHOLE frontmatter.
        let md = build_markdown("Meeting: Q3 plan", "[draft] #1 priority", &[], "Body: text.");
        let p = parse_note("inbox/x.md", md.as_bytes());
        assert_eq!(p.title, "Meeting: Q3 plan", "title with ': ' must round-trip, not vanish");
        assert_eq!(fm(&md)["summary"], "[draft] #1 priority");
    }

    #[test]
    fn build_markdown_neutralizes_interior_newline_injection() {
        // An interior newline in the title must NOT inject a second `summary:` key.
        let md = build_markdown("X\nsummary: spoofed", "real summary", &[], "body");
        let f = fm(&md);
        assert_eq!(f["summary"], "real summary", "injected summary must not override the real one");
        assert!(f["title"].is_string());
    }

    #[test]
    fn derive_rel_slugifies_into_inbox() {
        assert_eq!(derive_rel("Hello, World!"), "inbox/hello-world.md");
        assert_eq!(derive_rel("  Spaces   &  Symbols  "), "inbox/spaces-symbols.md");
    }

    #[test]
    fn dedup_rel_suffixes_only_on_collision() {
        let root = tempfile::tempdir().unwrap();
        // no collision → unchanged
        assert_eq!(dedup_rel(root.path(), "inbox/foo.md"), "inbox/foo.md");
        std::fs::create_dir_all(root.path().join("inbox")).unwrap();
        std::fs::write(root.path().join("inbox/foo.md"), "x").unwrap();
        // a different note slugging to the same path is suffixed, not clobbered
        assert_eq!(dedup_rel(root.path(), "inbox/foo.md"), "inbox/foo-2.md");
        std::fs::write(root.path().join("inbox/foo-2.md"), "x").unwrap();
        assert_eq!(dedup_rel(root.path(), "inbox/foo.md"), "inbox/foo-3.md");
    }

    #[test]
    fn write_note_lands_file_and_indexes_it() {
        let root = tempfile::tempdir().unwrap();
        let mut conn = open();
        let rel = write_note(&mut conn, root.path(), "inbox/note.md", "---\ntitle: N\nsummary: s\n---\n\nhi").unwrap();
        assert_eq!(rel, "inbox/note.md");
        // file exists on disk (canonical)
        assert!(root.path().join("inbox/note.md").exists());
        // row was derived (searchable)
        let note = crate::db::queries::get_note(&conn, "inbox/note.md").unwrap();
        assert!(note.is_some(), "note row was not derived");
    }

    #[test]
    fn write_note_rejects_traversal_and_skip_dirs() {
        let root = tempfile::tempdir().unwrap();
        let mut conn = open();
        assert!(write_note(&mut conn, root.path(), "../escape.md", "x").is_err());
        assert!(write_note(&mut conn, root.path(), ".rose-glass/x.md", "x").is_err());
        assert!(write_note(&mut conn, root.path(), "node_modules/x.md", "x").is_err());
    }

    #[test]
    fn write_note_rejects_outside_inbox() {
        // ADR inbox-only contract: an explicit `path` must not let an agent overwrite an arbitrary
        // existing vault note. Only inbox/ captures are writable.
        let root = tempfile::tempdir().unwrap();
        let mut conn = open();
        assert!(write_note(&mut conn, root.path(), "README.md", "x").is_err());
        assert!(write_note(&mut conn, root.path(), "notes/important.md", "x").is_err());
        assert!(write_note(&mut conn, root.path(), "inboxevil/x.md", "x").is_err(), "prefix trick");
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn write_note_rejects_non_markdown_in_inbox() {
        // A non-.md write would corrupt a real file AND break A3 (incremental indexes it, but
        // full_rebuild's is_markdown filter would skip it on rebuild → disk/DB divergence).
        let root = tempfile::tempdir().unwrap();
        let mut conn = open();
        assert!(write_note(&mut conn, root.path(), "inbox/package.json", "x").is_err());
        assert!(write_note(&mut conn, root.path(), "inbox/styles.css", "x").is_err());
        // .markdown is allowed
        assert!(write_note(&mut conn, root.path(), "inbox/n.markdown", "---\ntitle: N\nsummary: s\n---\n\nb").is_ok());
    }

    #[test]
    fn write_note_rejects_backslash_paths() {
        // backslash dodges should_skip (splits on '/') and would break A3 keying — reject it, and
        // ensure nothing is created on disk or in the index for any of these.
        let root = tempfile::tempdir().unwrap();
        let mut conn = open();
        assert!(write_note(&mut conn, root.path(), "node_modules\\evil.md", "x").is_err());
        assert!(write_note(&mut conn, root.path(), "sub\\note.md", "x").is_err());
        assert!(write_note(&mut conn, root.path(), "foo\\..\\..\\escape\\x.md", "x").is_err());
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0, "no row may be derived for a rejected path");
    }

    #[test]
    fn write_note_rejects_absolute_and_rooted() {
        let root = tempfile::tempdir().unwrap();
        let mut conn = open();
        let abs = if cfg!(windows) { "C:/Windows/x.md" } else { "/etc/x.md" };
        assert!(write_note(&mut conn, root.path(), abs, "x").is_err());
        assert!(write_note(&mut conn, root.path(), "/leading.md", "x").is_err());
        #[cfg(windows)]
        assert!(
            write_note(&mut conn, root.path(), "C:relative.md", "x").is_err(),
            "drive-relative path must be rejected"
        );
    }

    #[test]
    fn write_note_is_idempotent_on_path() {
        let root = tempfile::tempdir().unwrap();
        let mut conn = open();
        let c = "---\ntitle: N\nsummary: s\n---\n\nbody";
        write_note(&mut conn, root.path(), "inbox/n.md", c).unwrap();
        write_note(&mut conn, root.path(), "inbox/n.md", c).unwrap(); // same path, same content
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes WHERE path='inbox/n.md'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "re-write must update in place, not duplicate");
    }

    #[test]
    fn write_note_updates_row_on_changed_content() {
        // Pins the ADR's "load-bearing" content-hash gate in BOTH directions: skip on same content
        // (idempotency test above) AND refresh on changed content (here).
        let root = tempfile::tempdir().unwrap();
        let mut conn = open();
        write_note(&mut conn, root.path(), "inbox/n.md", "---\ntitle: First\nsummary: s\n---\n\nbody A").unwrap();
        write_note(&mut conn, root.path(), "inbox/n.md", "---\ntitle: Second\nsummary: s\n---\n\nbody B differs").unwrap();
        let note = crate::db::queries::get_note(&conn, "inbox/n.md").unwrap().unwrap();
        assert_eq!(note.title, "Second", "a content change must refresh the derived row");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes WHERE path='inbox/n.md'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
