//! The single confined write path shared by the MCP write tool. Writes a markdown FILE
//! (canonical) then derives the SQLite row via pipeline::incremental — never writes the DB
//! directly, so the A3 rebuild-equivalence invariant holds. All agent writes funnel here.

use crate::fs_safe::{atomic_write, safe_join};
use crate::indexer::pipeline::{incremental, should_skip};
use crate::indexer::IndexOutcome;
use rusqlite::Connection;
use std::path::Path;

/// Assemble schema-valid markdown: YAML frontmatter (title, mandatory summary, optional tags)
/// + body. Values are single-line (callers trim); this is the agent capture format.
pub fn build_markdown(title: &str, summary: &str, tags: &[String], body: &str) -> String {
    let mut fm = String::from("---\n");
    fm.push_str(&format!("title: {}\n", title.trim()));
    fm.push_str(&format!("summary: {}\n", summary.trim()));
    if !tags.is_empty() {
        fm.push_str(&format!("tags: [{}]\n", tags.join(", ")));
    }
    fm.push_str("---\n\n");
    fm.push_str(body.trim_end());
    fm.push('\n');
    fm
}

/// `inbox/<slug>.md` from a title: lowercase, runs of non-alphanumeric → single '-', trimmed.
/// ASCII-only (the index has no NFC normalization — pipeline.rs:63 — so we keep names round-trippable).
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

/// The single confined agent write. Rejects skip-dirs, absolute paths, and traversal, writes the
/// markdown FILE atomically, then derives the SQLite row synchronously (the app/watcher may be
/// down, so we must index in-process). Returns the vault-relative path actually written.
pub fn write_note(
    conn: &mut Connection,
    root: &Path,
    rel: &str,
    content: &str,
) -> Result<String, String> {
    if should_skip(rel) {
        return Err(format!("refusing to write a skipped/invisible path: {rel}"));
    }
    // Reject absolute/rooted paths BEFORE any FS mutation. `should_skip` catches '.'/'..' segments
    // and skip-dirs, but not an absolute path (e.g. "/etc/x.md", "C:\\x", "\\\\unc\\x") — and the
    // create_dir_all below would otherwise act on it before safe_join's canonical check rejects it.
    if Path::new(rel).is_absolute() || rel.starts_with('/') || rel.starts_with('\\') {
        return Err(format!("refusing an absolute/rooted path: {rel}"));
    }
    // safe_join needs the parent dir to exist to canonicalize a NEW file; ensure inbox/ first.
    if let Some(slash) = rel.rfind('/') {
        let sub = &rel[..slash];
        std::fs::create_dir_all(root.join(sub)).map_err(|e| e.to_string())?;
    }
    let abs = safe_join(root, rel)?; // rejects absolute, '..'/'.', symlink escape (canonical check)
    atomic_write(&abs, content).map_err(|e| e.to_string())?;
    match incremental(conn, root, rel) {
        Ok(IndexOutcome::Indexed) | Ok(IndexOutcome::Skipped) => Ok(rel.to_string()),
        Ok(other) => Err(format!("unexpected index outcome: {other:?}")),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open() -> Connection {
        let conn = crate::db::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn build_markdown_has_mandatory_summary_frontmatter() {
        let md = build_markdown("My Title", "a one line summary", &["x".into(), "y".into()], "Body text.");
        assert!(md.starts_with("---\n"));
        assert!(md.contains("title: My Title"));
        assert!(md.contains("summary: a one line summary"));
        assert!(md.contains("tags: [x, y]"));
        assert!(md.trim_end().ends_with("Body text."));
    }

    #[test]
    fn derive_rel_slugifies_into_inbox() {
        assert_eq!(derive_rel("Hello, World!"), "inbox/hello-world.md");
        assert_eq!(derive_rel("  Spaces   &  Symbols  "), "inbox/spaces-symbols.md");
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
}
