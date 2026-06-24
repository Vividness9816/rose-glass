# Rose Glass Agent-Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude Code navigate the Rose Glass knowledge base through MCP tools (search, get_note, manifest, related) and capture notes through one deterministic write path (`upsert_note`) that never creates orphans — replacing ripgrep + sequential markdown reads.

**Architecture:** Extend the existing read-only `rose-glass-mcp` stdio sidecar. The write path executes *in the sidecar* (the MCP client spawns it; the desktop app may be closed) behind an `--allow-write` flag that keeps the default invocation provably read-only. Every write goes through one shared, confined lib fn — `capture::write_note` = `should_skip`-reject → `safe_join` (inbox-only) → atomic temp+fsync+rename → `pipeline::incremental` (synchronous) — so the file is canonical and the SQLite row is derived (A3 preserved). Read tools are thin dispatch over existing `desktop_lib::db::queries`.

**Tech Stack:** Rust (rusqlite, serde_json), the existing `desktop_lib` crate, MCP JSON-RPC 2.0 over stdio. No new dependencies. Frontend untouched.

**Founding decision:** `~/.claude/second-brain/decisions/ADR-20260623-rose-glass-agent-interface.md`. Discovery map: `docs/agent-interface-findings.md`.

## Global Constraints

- **A3 invariant is sacred:** writes go to the markdown file first; the SQLite row is derived by `pipeline::incremental`. Never write `index.db` rows for a note without a `.md` file on disk. The test `pipeline.rs:472` (`a3_delete_db_rebuild_is_equivalent`) must stay green.
- **Read-only by default:** the default `rose-glass-mcp --vault X` invocation must open the DB `SQLITE_OPEN_READ_ONLY` and must NOT advertise `upsert_note` in `tools/list`. Write capability only under `--allow-write`.
- **Local-only:** no network calls in any tool. No ONNX model in the sidecar (so no free-text `semantic_search` over MCP this milestone — `related` is model-free).
- **Incremental commits per phase**, each with green gates: `cargo test --lib` AND `cargo test --bin rose-glass-mcp` AND `cargo clippy`. Run from `apps/desktop/src-tauri`.
- **All MCP write paths confined to `<vault>/inbox/`**; reject `should_skip` targets and path traversal up front.
- **`summary` is mandatory for agent writes:** `required` in the `upsert_note` inputSchema AND server-side rejected if empty-after-trim (schema `required` is satisfied by `""`).
- Naming/style: `snake_case` fns, result structs `#[derive(Serialize)]`, line-length 100, follow existing `bin/mcp.rs` dispatch style.

---

## File Structure

- `apps/desktop/src-tauri/src/lib.rs` — MODIFY: expose `pub mod fs_safe;` and add `pub mod capture;` so the bin can reach the write path.
- `apps/desktop/src-tauri/src/fs_safe.rs` — MODIFY: add `atomic_write` helper.
- `apps/desktop/src-tauri/src/indexer/pipeline.rs` — MODIFY: `should_skip` `pub(crate)` → `pub`.
- `apps/desktop/src-tauri/src/capture.rs` — CREATE: `write_note`, `build_markdown`, `derive_rel` (the shared confined write path).
- `apps/desktop/src-tauri/src/db/queries.rs` — MODIFY: add `manifest()` query + `ManifestEntry`.
- `apps/desktop/src-tauri/src/bin/mcp.rs` — MODIFY: `--allow-write` gate, RW open, `upsert_note`/`get_note`/`manifest`/`related` tools, startup log, `--check` subcommand.

---

## Phase 1 — Confinement foundation (lib only, no MCP changes)

### Task 1.1: Expose the confinement primitives to the binary

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (module visibility)
- Modify: `apps/desktop/src-tauri/src/indexer/pipeline.rs:47` (`should_skip` visibility)

**Interfaces:**
- Produces: `desktop_lib::fs_safe::safe_join`, `desktop_lib::indexer::pipeline::{incremental, should_skip, IndexOutcome}` reachable from `bin/mcp.rs`.

- [ ] **Step 1: Make `fs_safe` and `indexer` public in the lib**

In `apps/desktop/src-tauri/src/lib.rs`, the lib currently exposes only `pub mod db;` with `mod fs_safe;` and `mod indexer;` private. Change those two to public:

```rust
pub mod fs_safe;
pub mod indexer;
```

(Leave every other `mod`/`pub mod` line as-is.)

- [ ] **Step 2: Make `should_skip` public**

In `apps/desktop/src-tauri/src/indexer/pipeline.rs:47`, change:

```rust
pub(crate) fn should_skip(rel: &str) -> bool {
```
to
```rust
pub fn should_skip(rel: &str) -> bool {
```

- [ ] **Step 3: Verify the lib still builds and tests pass**

Run: `cargo test --lib`
Expected: PASS (77+ tests), no new warnings about the visibility change.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/indexer/pipeline.rs
git commit -m "refactor(lib): expose fs_safe + indexer + should_skip for the MCP write path"
```

---

### Task 1.2: Atomic write helper

**Files:**
- Modify: `apps/desktop/src-tauri/src/fs_safe.rs`
- Test: same file (`#[cfg(test)] mod tests`)

**Interfaces:**
- Produces: `pub fn atomic_write(abs: &std::path::Path, content: &str) -> std::io::Result<()>` — writes to a temp file in the same dir, fsyncs, renames over the target (crash-safe; a reader never sees a half-written file).

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src-tauri/src/fs_safe.rs` tests module:

```rust
#[test]
fn atomic_write_creates_and_overwrites() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("note.md");
    atomic_write(&f, "hello").unwrap();
    assert_eq!(std::fs::read_to_string(&f).unwrap(), "hello");
    // overwrite in place
    atomic_write(&f, "world").unwrap();
    assert_eq!(std::fs::read_to_string(&f).unwrap(), "world");
    // no leftover temp files in the dir
    let leftovers: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "temp file leaked: {leftovers:?}");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib fs_safe::tests::atomic_write_creates_and_overwrites`
Expected: FAIL ("cannot find function `atomic_write`").

- [ ] **Step 3: Implement `atomic_write`**

Add to `apps/desktop/src-tauri/src/fs_safe.rs` (after `safe_join`). Mirror the existing `save_note_file` write dance (commands.rs:197-202) using `tempfile::NamedTempFile` (already a dependency):

```rust
use std::io::Write;

/// Crash-safe write: temp file in the SAME directory → fsync → atomic rename over `abs`.
/// A concurrent reader (or the file watcher) therefore only ever sees a complete file,
/// never a half-written one. The parent dir must exist.
pub fn atomic_write(abs: &Path, content: &str) -> std::io::Result<()> {
    let dir = abs.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent dir")
    })?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".rg-")
        .suffix(".tmp")
        .tempfile_in(dir)?;
    tmp.write_all(content.as_bytes())?;
    tmp.as_file().sync_all()?;
    tmp.persist(abs).map_err(|e| e.error)?;
    Ok(())
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --lib fs_safe::tests::atomic_write`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/fs_safe.rs
git commit -m "feat(fs_safe): crash-safe atomic_write helper (temp+fsync+rename)"
```

---

### Task 1.3: The shared confined write path (`capture::write_note`)

**Files:**
- Create: `apps/desktop/src-tauri/src/capture.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (add `pub mod capture;`)
- Test: in `capture.rs`

**Interfaces:**
- Consumes: `fs_safe::{safe_join, atomic_write}`, `indexer::pipeline::{incremental, should_skip, IndexOutcome}`.
- Produces:
  - `pub fn build_markdown(title: &str, summary: &str, tags: &[String], body: &str) -> String` — assembles YAML frontmatter (with mandatory `summary`) + body.
  - `pub fn derive_rel(title: &str) -> String` — `inbox/<slug>.md` from a title (lowercase, non-alphanumeric → `-`, ASCII).
  - `pub fn write_note(conn: &mut Connection, root: &Path, rel: &str, content: &str) -> Result<String, String>` — confined write: reject `should_skip`, `safe_join`, atomic write, sync `incremental`. Returns the vault-relative path written.

- [ ] **Step 1: Register the module**

In `apps/desktop/src-tauri/src/lib.rs`, add near the other module declarations:

```rust
pub mod capture;
```

- [ ] **Step 2: Write the failing tests**

Create `apps/desktop/src-tauri/src/capture.rs`:

```rust
//! The single confined write path shared by the MCP write tool. Writes a markdown FILE
//! (canonical) then derives the SQLite row via pipeline::incremental — never writes the DB
//! directly, so the A3 rebuild-equivalence invariant holds. All agent writes funnel here.

use crate::fs_safe::{atomic_write, safe_join};
use crate::indexer::pipeline::{incremental, should_skip, IndexOutcome};
use rusqlite::Connection;
use std::path::Path;

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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test --lib capture::tests`
Expected: FAIL ("cannot find function `build_markdown`" etc).

- [ ] **Step 4: Implement the module body**

Add above the `#[cfg(test)]` block in `apps/desktop/src-tauri/src/capture.rs`:

```rust
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

/// The single confined agent write. Rejects skip-dirs and traversal, writes the markdown FILE
/// atomically, then derives the SQLite row synchronously (the app/watcher may be down, so we
/// must index in-process). Returns the vault-relative path actually written.
pub fn write_note(conn: &mut Connection, root: &Path, rel: &str, content: &str) -> Result<String, String> {
    if should_skip(rel) {
        return Err(format!("refusing to write a skipped/invisible path: {rel}"));
    }
    // safe_join needs the parent dir to exist to canonicalize a NEW file; ensure inbox/ first.
    if let Some(slash) = rel.rfind('/') {
        let sub = &rel[..slash];
        std::fs::create_dir_all(root.join(sub)).map_err(|e| e.to_string())?;
    }
    let abs = safe_join(root, rel)?; // rejects absolute, '..'/'.', symlink escape
    atomic_write(&abs, content).map_err(|e| e.to_string())?;
    match incremental(conn, root, rel) {
        Ok(IndexOutcome::Indexed) | Ok(IndexOutcome::Skipped) => Ok(rel.to_string()),
        Ok(other) => Err(format!("unexpected index outcome: {other:?}")),
        Err(e) => Err(e.to_string()),
    }
}
```

> Note: confirm `IndexOutcome`'s variants at `apps/desktop/src-tauri/src/indexer/pipeline.rs` (search `enum IndexOutcome`). It has `Indexed` and `Skipped` (used in `incremental`); if the `Deleted` variant lacks `Debug`, add `#[derive(Debug)]` to the enum so the `{other:?}` formatting compiles.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --lib capture::tests`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/capture.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(capture): shared confined write_note (file-first, sync-indexed, A3-safe)"
```

---

## Phase 2 — Write path over MCP (passes the success test)

### Task 2.1: `--allow-write` gate + read-write connection

**Files:**
- Modify: `apps/desktop/src-tauri/src/bin/mcp.rs`
- Test: in `mcp.rs` tests

**Interfaces:**
- Produces: `main()` parses `--allow-write`; opens the DB read-write only when set. `handle_request(req, conn: &mut Connection, allow_write: bool)`, `call_tool(id, req, conn: &mut Connection, allow_write: bool)`, `tool_defs(allow_write: bool)`.

- [ ] **Step 1: Write failing tests for the gate**

Add to `apps/desktop/src-tauri/src/bin/mcp.rs` tests (update existing `handle_request(...)` test calls to pass `&mut seeded()` and `false` — see Step 4):

```rust
#[test]
fn upsert_tool_hidden_without_allow_write() {
    let mut c = seeded();
    let resp = handle_request(&json!({"jsonrpc":"2.0","id":20,"method":"tools/list"}), &mut c, false).unwrap();
    let names: Vec<&str> = resp["result"]["tools"].as_array().unwrap().iter()
        .map(|t| t["name"].as_str().unwrap()).collect();
    assert!(!names.contains(&"upsert_note"), "write tool must be hidden in read-only mode");
}

#[test]
fn upsert_tool_shown_with_allow_write() {
    let mut c = seeded();
    let resp = handle_request(&json!({"jsonrpc":"2.0","id":21,"method":"tools/list"}), &mut c, true).unwrap();
    let names: Vec<&str> = resp["result"]["tools"].as_array().unwrap().iter()
        .map(|t| t["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"upsert_note"));
}

#[test]
fn upsert_call_rejected_without_allow_write() {
    let mut c = seeded();
    let resp = handle_request(
        &json!({"jsonrpc":"2.0","id":22,"method":"tools/call",
                "params":{"name":"upsert_note","arguments":{"title":"T","summary":"s","body":"b"}}}),
        &mut c, false).unwrap();
    assert_eq!(resp["error"]["code"], -32601, "write tool must be method-not-found in read-only mode");
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --bin rose-glass-mcp upsert_tool_hidden_without_allow_write`
Expected: FAIL (compile error — `handle_request` arity, no `upsert_note`).

- [ ] **Step 3: Parse `--allow-write` and open RW conditionally**

In `main()`, after `parse_vault`, add the flag and branch the open. Replace the read-only-only open block (mcp.rs:30-38) with:

```rust
    let allow_write = args.iter().any(|a| a == "--allow-write");
    let flags = if allow_write {
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI
    };
    let mut conn = Connection::open_with_flags(&db_path, flags).unwrap_or_else(|e| {
        eprintln!("rose-glass-mcp: cannot open {}: {e}", db_path.display());
        std::process::exit(1);
    });
```

Change the read loop to pass `&mut conn` and `allow_write`:

```rust
        if let Some(resp) = handle_request(&req, &mut conn, allow_write) {
```

- [ ] **Step 4: Thread `&mut Connection` + `allow_write` through dispatch**

Update signatures. `handle_request`:

```rust
fn handle_request(req: &Value, conn: &mut Connection, allow_write: bool) -> Option<Value> {
```
In its body, `"tools/list" => Some(ok(id, json!({ "tools": tool_defs(allow_write) }))),` and `"tools/call" => Some(call_tool(id, req, conn, allow_write)),`.

`tool_defs`:

```rust
fn tool_defs(allow_write: bool) -> Value {
    let mut tools = vec![ /* the existing search + get_semantic_clusters json!(...) objects */ ];
    if allow_write {
        tools.push(json!({
            "name": "upsert_note",
            "description": "Capture a note into the vault inbox. Writes a markdown file (the agent must provide a one-line summary) and indexes it. The ONLY write path.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title":   { "type": "string" },
                    "summary": { "type": "string", "minLength": 1, "description": "One-line summary (mandatory)." },
                    "body":    { "type": "string" },
                    "tags":    { "type": "array", "items": { "type": "string" } },
                    "path":    { "type": "string", "description": "Optional vault-relative path to UPDATE in place; omit to create inbox/<slug>.md." }
                },
                "required": ["title", "summary", "body"]
            }
        }));
    }
    Value::Array(tools)
}
```
(Move the two existing tool `json!` objects into the `vec![...]`.)

`call_tool`:

```rust
fn call_tool(id: Option<Value>, req: &Value, conn: &mut Connection, allow_write: bool) -> Value {
```
Add an `upsert_note` arm guarded by `allow_write` (full body in Task 2.2). For now, add a stub arm so it compiles:

```rust
        "upsert_note" if allow_write => upsert_note(id, &args, conn, /* root */),
```
…but `root` isn't in scope here. Resolve this in Task 2.2 by threading the vault root. For Step-3/4 compilation, temporarily return `tool_err(id, "not yet implemented")` for `upsert_note if allow_write`, and keep the existing read arms borrowing `&*conn` where they need `&Connection` (e.g. `queries::search_fts(&*conn, q)`).

- [ ] **Step 5: Update existing tests to the new arity**

Every existing `handle_request(&json!(...), &seeded())` call becomes `handle_request(&json!(...), &mut seeded(), false)`. (There are 9; update each.)

- [ ] **Step 6: Run the bin test suite**

Run: `cargo test --bin rose-glass-mcp`
Expected: PASS (existing 9 + 3 new gate tests).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/bin/mcp.rs
git commit -m "feat(mcp): --allow-write gate (RW open + conditional upsert tool)"
```

---

### Task 2.2: `upsert_note` tool body

**Files:**
- Modify: `apps/desktop/src-tauri/src/bin/mcp.rs`

**Interfaces:**
- Consumes: `desktop_lib::capture::{build_markdown, derive_rel, write_note}`. The vault `root: PathBuf` (thread it from `main` into `call_tool`).
- Produces: `fn upsert_note(id, args: &Value, conn: &mut Connection, root: &Path) -> Value`.

- [ ] **Step 1: Thread the vault root into dispatch**

In `main`, keep `root` as `PathBuf` (from `--vault`, canonicalized: `std::fs::canonicalize(&vault).unwrap_or(PathBuf::from(&vault))`). Pass `&root` into `handle_request(..., &root)` → `call_tool(..., &root)`. Update those two signatures to take `root: &Path` (add `use std::path::Path;`). Update existing tests to pass a root (e.g. `Path::new(".")` — read tools ignore it).

- [ ] **Step 2: Write the failing test**

```rust
#[test]
fn upsert_note_writes_and_indexes() {
    let root = tempfile::tempdir().unwrap();
    let mut c = {
        // a real on-disk db so incremental can open a tx
        let p = root.path().join(".rose-glass/index.db");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let c = desktop_lib::db::open_db(&p).unwrap();
        desktop_lib::db::migrate(&c).unwrap();
        c
    };
    let resp = handle_request(
        &json!({"jsonrpc":"2.0","id":30,"method":"tools/call",
                "params":{"name":"upsert_note","arguments":{"title":"Test Note","summary":"a summary","body":"the body"}}}),
        &mut c, true).unwrap_or_else(|| panic!("no response"));
    // wait — handle_request needs root; see Step 1. Use the root-aware signature:
    let _ = (&root,);
    assert_eq!(resp["result"]["isError"], false, "resp: {resp}");
    assert_eq!(resp["result"]["structuredContent"]["path"], "inbox/test-note.md");
    assert!(root.path().join("inbox/test-note.md").exists());
}

#[test]
fn upsert_note_rejects_empty_summary() {
    let root = tempfile::tempdir().unwrap();
    let mut c = seeded();
    let resp = handle_request(
        &json!({"jsonrpc":"2.0","id":31,"method":"tools/call",
                "params":{"name":"upsert_note","arguments":{"title":"T","summary":"   ","body":"b"}}}),
        &mut c, true).unwrap();
    let _ = &root;
    assert_eq!(resp["error"]["code"], -32602, "empty-after-trim summary must be rejected");
}
```

> Adjust these two tests to call `handle_request` with the `root` argument added in Step 1 (`handle_request(&json!(...), &mut c, true, root.path())`).

- [ ] **Step 3: Implement `upsert_note`**

Add the dispatch arm in `call_tool` and the function:

```rust
        "upsert_note" if allow_write => upsert_note(id, &args, conn, root),
        "upsert_note" => err(id, -32601, "upsert_note requires --allow-write"),
```

```rust
fn upsert_note(id: Option<Value>, args: &Value, conn: &mut Connection, root: &Path) -> Value {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let title = s("title");
    let summary = s("summary");
    let body = s("body");
    if summary.trim().is_empty() {
        return err(id, -32602, "summary is required and must be non-empty");
    }
    let tags: Vec<String> = args.get("tags").and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let rel = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p.to_string(), // update in place
        _ => desktop_lib::capture::derive_rel(&title),    // new note → inbox/<slug>.md
    };
    let content = desktop_lib::capture::build_markdown(&title, &summary, &tags, &body);
    match desktop_lib::capture::write_note(conn, root, &rel, &content) {
        Ok(written) => tool_ok(id, &json!({ "path": written, "indexed": true })),
        Err(e) => tool_err(id, &e),
    }
}
```

Add `use std::path::Path;` at the top of `mcp.rs` if not present.

- [ ] **Step 4: Run the tests**

Run: `cargo test --bin rose-glass-mcp upsert_note`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/bin/mcp.rs
git commit -m "feat(mcp): upsert_note write tool (inbox capture, mandatory summary, A3-safe)"
```

---

### Task 2.3: `get_note` read tool

**Files:**
- Modify: `apps/desktop/src-tauri/src/bin/mcp.rs`

**Interfaces:**
- Consumes: `queries::get_note(conn, path) -> Result<Option<NoteDto>>`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn get_note_returns_the_note() {
    let mut c = seeded();
    let resp = handle_request(
        &json!({"jsonrpc":"2.0","id":40,"method":"tools/call",
                "params":{"name":"get_note","arguments":{"path":"a.md"}}}),
        &mut c, false, std::path::Path::new(".")).unwrap();
    assert_eq!(resp["result"]["isError"], false);
    assert_eq!(resp["result"]["structuredContent"]["title"], "Alpha Note");
}
```

- [ ] **Step 2: Verify failure**

Run: `cargo test --bin rose-glass-mcp get_note_returns_the_note`
Expected: FAIL ("Unknown tool: get_note").

- [ ] **Step 3: Add the tool def + dispatch arm**

In `tool_defs` (the always-on `vec!`), add:

```rust
        json!({
            "name": "get_note",
            "description": "Fetch one note's metadata, frontmatter, tags and outgoing links by vault-relative path.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }
        }),
```
In `call_tool`, add:

```rust
        "get_note" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            match queries::get_note(&*conn, path) {
                Ok(Some(note)) => tool_ok(id, &note),
                Ok(None) => tool_ok(id, &Value::Null),
                Err(e) => tool_err(id, &e.to_string()),
            }
        }
```

- [ ] **Step 4: Run + verify pass; then the full bin suite**

Run: `cargo test --bin rose-glass-mcp`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/bin/mcp.rs
git commit -m "feat(mcp): get_note read tool"
```

> **Milestone:** the success test is now reachable — an agent can `search` → `get_note` (zero markdown reads) and `upsert_note` a schema-valid note that derives a row (no orphan).

---

## Phase 3 — Discovery & triage tools

### Task 3.1: `manifest()` query + tool

**Files:**
- Modify: `apps/desktop/src-tauri/src/db/queries.rs` (add `ManifestEntry` + `manifest`)
- Modify: `apps/desktop/src-tauri/src/bin/mcp.rs` (tool)
- Test: `queries.rs` semantic_tests + `mcp.rs`

**Interfaces:**
- Produces: `pub struct ManifestEntry { path, title, summary: Option<String>, status: Option<String>, tags: Vec<String>, summary_present: bool }` (`#[derive(Serialize)]`); `pub fn manifest(conn: &Connection) -> rusqlite::Result<Vec<ManifestEntry>>`.

- [ ] **Step 1: Write the failing query test**

Add to `apps/desktop/src-tauri/src/db/queries.rs` `semantic_tests`:

```rust
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
```

- [ ] **Step 2: Verify failure**

Run: `cargo test --lib manifest_lists_notes_and_flags_missing_summary`
Expected: FAIL ("cannot find function `manifest`").

- [ ] **Step 3: Implement `ManifestEntry` + `manifest`**

Add to `queries.rs` (near the other `#[derive(Serialize)]` DTOs and reads):

```rust
#[derive(Serialize)]
pub struct ManifestEntry {
    pub path: String,
    pub title: String,
    pub summary: Option<String>,
    pub status: Option<String>,
    pub tags: Vec<String>,
    pub summary_present: bool,
}

/// One row per note: path/title + summary/status pulled out of the frontmatter JSON, plus
/// the note's tags. The whole-vault triage surface for the agent (replaces grepping). A note
/// with no/empty frontmatter `summary` is flagged (summary_present=false).
pub fn manifest(conn: &Connection) -> rusqlite::Result<Vec<ManifestEntry>> {
    let mut stmt = conn.prepare(
        "SELECT path, title, frontmatter FROM notes ORDER BY path",
    )?;
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
            ts.query_map(params![path], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        let summary_present = summary.is_some();
        out.push(ManifestEntry { path, title, summary, status, tags, summary_present });
    }
    Ok(out)
}
```

- [ ] **Step 4: Verify the query test passes**

Run: `cargo test --lib manifest_lists_notes_and_flags_missing_summary`
Expected: PASS.

- [ ] **Step 5: Add the MCP tool (def + dispatch + test)**

Tool def (always-on `vec!`):

```rust
        json!({
            "name": "manifest",
            "description": "List every note (path, title, summary, status, tags). One call to triage the whole vault instead of grepping. Notes missing a summary are flagged (summary_present=false).",
            "inputSchema": { "type": "object", "properties": {} }
        }),
```
Dispatch arm:

```rust
        "manifest" => match queries::manifest(&*conn) {
            Ok(entries) => tool_ok(id, &entries),
            Err(e) => tool_err(id, &e.to_string()),
        },
```
Test:

```rust
#[test]
fn manifest_tool_lists_notes() {
    let mut c = seeded();
    let resp = handle_request(
        &json!({"jsonrpc":"2.0","id":50,"method":"tools/call","params":{"name":"manifest","arguments":{}}}),
        &mut c, false, std::path::Path::new(".")).unwrap();
    assert_eq!(resp["result"]["isError"], false);
    assert_eq!(resp["result"]["structuredContent"][0]["path"], "a.md");
}
```

- [ ] **Step 6: Run both suites**

Run: `cargo test --lib manifest` then `cargo test --bin rose-glass-mcp manifest`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/db/queries.rs apps/desktop/src-tauri/src/bin/mcp.rs
git commit -m "feat(mcp): manifest() whole-vault triage tool (flags missing summary)"
```

---

### Task 3.2: `related` model-free tool

**Files:**
- Modify: `apps/desktop/src-tauri/src/db/queries.rs` (add a model-free `related` reader if one isn't already reusable)
- Modify: `apps/desktop/src-tauri/src/bin/mcp.rs`

**Interfaces:**
- Consumes: `queries::read_embeddings(conn, model) -> Vec<(String, Vec<f32>)>` (queries.rs:381), `knn::knn` (knn.rs), `embed::MODEL_NAME` (embed.rs:12). Mirror the model-free logic of `commands::related_notes` (commands.rs:355-374) — it reads the query note's stored vector and KNNs the corpus; NO model load.
- Produces: `pub fn related(conn: &Connection, path: &str, k: usize) -> rusqlite::Result<RelatedResult>` where `RelatedResult { ready: bool, neighbors: Vec<RelatedHit> }`, `RelatedHit { path, title, score }`. `ready=false` when the `embeddings` table is empty (the app never computed them) so the agent doesn't read "no embeddings" as "no related notes".

- [ ] **Step 1: Write the failing test (query)**

Add to `queries.rs` semantic_tests (reuse the existing `seed(conn, path, title, vec, MODEL_NAME)` helper at queries.rs:492):

```rust
#[test]
fn related_is_not_ready_with_no_embeddings() {
    let conn = crate::db::open_in_memory().unwrap();
    crate::db::migrate(&conn).unwrap();
    conn.execute("INSERT INTO notes (path,title,content_hash,mtime,word_count,indexed_at) VALUES ('a.md','A','h',0,1,0)", []).unwrap();
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
```

- [ ] **Step 2: Verify failure**

Run: `cargo test --lib related_ranks_nearest_excluding_self`
Expected: FAIL ("cannot find function `related`").

- [ ] **Step 3: Implement `related` (mirror `related_notes`, model-free)**

Read `commands.rs:355-374` for the exact `knn`/`titles_for` calls it uses, then add the equivalent to `queries.rs`:

```rust
#[derive(Serialize)]
pub struct RelatedHit { pub path: String, pub title: String, pub score: f32 }
#[derive(Serialize)]
pub struct RelatedResult { pub ready: bool, pub neighbors: Vec<RelatedHit> }

/// Notes most similar to `path` by cosine over STORED embeddings (model-free — the query
/// note's vector is already in the table). `ready=false` when no embeddings exist (the app
/// hasn't run clustering), so an empty result reads as "not ready", not "no neighbors".
pub fn related(conn: &Connection, path: &str, k: usize) -> rusqlite::Result<RelatedResult> {
    let corpus = read_embeddings(conn, crate::embed::MODEL_NAME)?;
    if corpus.is_empty() {
        return Ok(RelatedResult { ready: false, neighbors: vec![] });
    }
    let Some((_, query_vec)) = corpus.iter().find(|(p, _)| p == path) else {
        return Ok(RelatedResult { ready: true, neighbors: vec![] }); // unknown/un-embedded note
    };
    // knn over the corpus excluding self; see knn.rs for the exact signature.
    let ranked = crate::knn::knn(&query_vec.clone(), &corpus, k, path);
    let neighbors = ranked
        .into_iter()
        .map(|(p, score)| {
            let title: String = conn
                .query_row("SELECT title FROM notes WHERE path=?1", params![p], |r| r.get(0))
                .unwrap_or_default();
            RelatedHit { path: p, title, score }
        })
        .collect();
    Ok(RelatedResult { ready: true, neighbors })
}
```

> Confirm `knn::knn`'s exact signature/return at `apps/desktop/src-tauri/src/knn.rs` and how `commands::related_notes` calls it (it excludes self by path); adapt the `knn(...)` call + the `(p, score)` destructure to match. The behavior (exclude self, descending cosine, truncate to k) is the contract.

- [ ] **Step 4: Verify the query tests pass**

Run: `cargo test --lib related`
Expected: PASS.

- [ ] **Step 5: Add the MCP tool (def + dispatch + test)**

Tool def:

```rust
        json!({
            "name": "related",
            "description": "Notes semantically related to a given note (by vault-relative path). Model-free. Returns {ready:false} if embeddings have not been computed yet.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string" }, "k": { "type": "integer", "default": 10 } },
                "required": ["path"]
            }
        }),
```
Dispatch:

```rust
        "related" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let k = args.get("k").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
            match queries::related(&*conn, path, k.min(200)) {
                Ok(res) => tool_ok(id, &res),
                Err(e) => tool_err(id, &e.to_string()),
            }
        }
```
Test:

```rust
#[test]
fn related_tool_reports_not_ready_on_empty_embeddings() {
    let mut c = seeded(); // seeded() has no embeddings
    let resp = handle_request(
        &json!({"jsonrpc":"2.0","id":60,"method":"tools/call",
                "params":{"name":"related","arguments":{"path":"a.md"}}}),
        &mut c, false, std::path::Path::new(".")).unwrap();
    assert_eq!(resp["result"]["structuredContent"]["ready"], false);
}
```

- [ ] **Step 6: Run both suites + clippy**

Run: `cargo test --lib related && cargo test --bin rose-glass-mcp related && cargo clippy --bin rose-glass-mcp`
Expected: PASS, no new clippy warnings.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/db/queries.rs apps/desktop/src-tauri/src/bin/mcp.rs
git commit -m "feat(mcp): related tool (model-free KNN, ready:false when un-embedded)"
```

---

## Phase 4 — Lifecycle & observability

### Task 4.1: Loud startup log (resolved vault + db + mode)

**Files:**
- Modify: `apps/desktop/src-tauri/src/bin/mcp.rs` (`main`)

- [ ] **Step 1: Add a success-path log to stderr**

After opening `conn` in `main`, before the read loop, add:

```rust
    eprintln!(
        "rose-glass-mcp: vault={} db={} mode={}",
        root.display(),
        db_path.display(),
        if allow_write { "read-write" } else { "read-only" },
    );
```

(stderr, not stdout — stdout is the JSON-RPC channel.)

- [ ] **Step 2: Manual verify**

Run: `cargo run --bin rose-glass-mcp -- --vault . 2>&1 1>/dev/null` then immediately Ctrl-C.
Expected: a stderr line `rose-glass-mcp: vault=… db=… mode=read-only`.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/bin/mcp.rs
git commit -m "feat(mcp): log resolved vault + db path + mode on startup (stale-vault diagnosis)"
```

---

### Task 4.2: `--check` doctor subcommand

**Files:**
- Modify: `apps/desktop/src-tauri/src/bin/mcp.rs`

**Interfaces:**
- Produces: `--check` exits after printing `{vault, db, exists, note_count, last_indexed_at, mode}` as one JSON line; exit 0 if the db opened, 2 on bad args, 1 if the db is missing/unreadable.

- [ ] **Step 1: Branch on `--check` before the read loop**

After computing `db_path`/`allow_write`, before opening the long-lived `conn`:

```rust
    if args.iter().any(|a| a == "--check") {
        let exists = db_path.exists();
        let (count, last): (i64, i64) = if exists {
            match Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI) {
                Ok(c) => (
                    c.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap_or(0),
                    c.query_row("SELECT COALESCE(MAX(indexed_at),0) FROM notes", [], |r| r.get(0)).unwrap_or(0),
                ),
                Err(e) => { eprintln!("rose-glass-mcp --check: cannot open db: {e}"); std::process::exit(1); }
            }
        } else { (0, 0) };
        println!("{}", json!({
            "vault": root.display().to_string(),
            "db": db_path.display().to_string(),
            "exists": exists,
            "note_count": count,
            "last_indexed_at": last,
            "mode": if allow_write { "read-write" } else { "read-only" },
        }));
        std::process::exit(if exists { 0 } else { 1 });
    }
```

- [ ] **Step 2: Manual verify**

Run: `cargo run --bin rose-glass-mcp -- --vault <a-real-vault-with-an-index> --check`
Expected: one JSON line with a non-zero `note_count`, exit 0.
Run: `cargo run --bin rose-glass-mcp -- --vault /tmp/empty --check`
Expected: `exists:false`, exit 1.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/bin/mcp.rs
git commit -m "feat(mcp): --check doctor (vault/db/note_count/last_indexed_at, exit codes)"
```

---

## Phase 5 — Maintenance report (on-demand, read-only)

### Task 5.1: `maintenance_report` tool (orphans, stale, missing summaries)

**Files:**
- Modify: `apps/desktop/src-tauri/src/db/queries.rs` (add `maintenance_report`)
- Modify: `apps/desktop/src-tauri/src/bin/mcp.rs`

**Interfaces:**
- Produces: `pub struct MaintenanceReport { note_count, embedded_count, embeddings_stale: bool, missing_summary: Vec<String>, orphans: Vec<String> }` (`#[derive(Serialize)]`); `pub fn maintenance_report(conn: &Connection) -> rusqlite::Result<MaintenanceReport>`. **Read-only — no re-embed** (embedding requires the model, which is app-side; this only *reports*). Per the ADR, this is the on-demand maintenance surface, never a session-end hook.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn maintenance_report_flags_orphans_and_missing_summary() {
    let conn = crate::db::open_in_memory().unwrap();
    crate::db::migrate(&conn).unwrap();
    // a.md: has a summary + an outgoing link (not an orphan)
    conn.execute("INSERT INTO notes (path,title,frontmatter,content_hash,mtime,word_count,indexed_at) VALUES ('a.md','A','{\"summary\":\"s\"}','h',0,1,0)", []).unwrap();
    conn.execute("INSERT INTO notes (path,title,content_hash,mtime,word_count,indexed_at) VALUES ('b.md','B','h',0,1,0)", []).unwrap();
    conn.execute("INSERT INTO links (src_path,dst_path,dst_raw,link_type) VALUES ('a.md','b.md','b','wikilink')", []).unwrap();
    let r = maintenance_report(&conn).unwrap();
    assert_eq!(r.note_count, 2);
    assert!(r.embeddings_stale, "0 embeddings for 2 notes");
    assert!(r.missing_summary.contains(&"b.md".to_string()));
    assert!(r.orphans.contains(&"b.md".to_string()) == false, "b.md has an inbound link");
}
```

- [ ] **Step 2: Verify failure**

Run: `cargo test --lib maintenance_report_flags_orphans_and_missing_summary`
Expected: FAIL.

- [ ] **Step 3: Implement `maintenance_report`**

```rust
#[derive(Serialize)]
pub struct MaintenanceReport {
    pub note_count: i64,
    pub embedded_count: i64,
    pub embeddings_stale: bool,
    pub missing_summary: Vec<String>,
    pub orphans: Vec<String>,
}

/// Read-only upkeep report: note vs embedding counts (stale if they differ), notes with no
/// frontmatter summary, and orphans (no inbound AND no outbound resolved links). Does NOT
/// re-embed (that needs the model, app-side) — it surfaces what to fix, per the ADR's
/// on-demand-not-a-hook decision.
pub fn maintenance_report(conn: &Connection) -> rusqlite::Result<MaintenanceReport> {
    let note_count: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))?;
    let embedded_count: i64 = conn.query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))?;
    let missing_summary: Vec<String> = manifest(conn)?
        .into_iter()
        .filter(|e| !e.summary_present)
        .map(|e| e.path)
        .collect();
    let orphans: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT n.path FROM notes n
             WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.src_path = n.path AND l.dst_path IS NOT NULL)
               AND NOT EXISTS (SELECT 1 FROM links l WHERE l.dst_path = n.path)
             ORDER BY n.path",
        )?;
        stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<_>>()?
    };
    Ok(MaintenanceReport {
        note_count,
        embedded_count,
        embeddings_stale: embedded_count != note_count,
        missing_summary,
        orphans,
    })
}
```

- [ ] **Step 4: Verify pass**

Run: `cargo test --lib maintenance_report`
Expected: PASS.

- [ ] **Step 5: Add the MCP tool (def + dispatch + test)**

Tool def:

```rust
        json!({
            "name": "maintenance_report",
            "description": "Read-only vault health report: note vs embedding counts (stale flag), notes missing a summary, and orphan notes (no links in or out). Surfaces upkeep work; does not modify anything.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
```
Dispatch:

```rust
        "maintenance_report" => match queries::maintenance_report(&*conn) {
            Ok(rep) => tool_ok(id, &rep),
            Err(e) => tool_err(id, &e.to_string()),
        },
```
Test:

```rust
#[test]
fn maintenance_report_tool_runs() {
    let mut c = seeded();
    let resp = handle_request(
        &json!({"jsonrpc":"2.0","id":70,"method":"tools/call","params":{"name":"maintenance_report","arguments":{}}}),
        &mut c, false, std::path::Path::new(".")).unwrap();
    assert_eq!(resp["result"]["isError"], false);
    assert_eq!(resp["result"]["structuredContent"]["note_count"], 1);
}
```

- [ ] **Step 6: Run everything + clippy**

Run: `cargo test --lib && cargo test --bin rose-glass-mcp && cargo clippy`
Expected: ALL PASS, no new clippy warnings.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/db/queries.rs apps/desktop/src-tauri/src/bin/mcp.rs
git commit -m "feat(mcp): maintenance_report tool (orphans, stale embeddings, missing summaries)"
```

---

## Phase 6 — Documentation & client config

### Task 6.1: Document the MCP server for Claude Code

**Files:**
- Create: `docs/agent-interface.md`
- Modify: `README.md` (add an "Agent interface (MCP)" section)

- [ ] **Step 1: Write `docs/agent-interface.md`**

Include: the tool list (`search`, `get_note`, `manifest`, `related`, `get_semantic_clusters`, and `upsert_note` under `--allow-write`), the read-only-by-default security note, the `--allow-write` opt-in, the `--check` doctor, and a copy-pasteable `.mcp.json` block:

```json
{
  "mcpServers": {
    "rose-glass": {
      "command": "rose-glass-mcp",
      "args": ["--vault", "C:/path/to/your/vault", "--allow-write"]
    }
  }
}
```
Note that omitting `--allow-write` yields a provably read-only server (no `upsert_note`), and that `--vault` must point at the same vault the desktop app opens.

- [ ] **Step 2: Update README**

Add a short "Agent interface (MCP)" section linking to `docs/agent-interface.md` and listing the tools.

- [ ] **Step 3: Commit**

```bash
git add docs/agent-interface.md README.md
git commit -m "docs(agent-interface): MCP tool surface, --allow-write, .mcp.json setup"
```

---

## Self-Review

**Spec coverage (vs ADR + the original Issue-2 spec):**
- Triage layer (manifest, mandatory-summary flag, FTS5): Phase 3.1 (manifest) + Phase 2.2 (schema-required summary); FTS5 already shipped. ✓
- Discovery layer (local embeddings, hybrid): `related` model-free in 3.2; **fusion + free-text-semantic-over-MCP intentionally deferred** per ADR (no model in sidecar) — documented, not silently dropped. ✓ (gap is deliberate)
- Agent interface (search/get_note/manifest/related/upsert_note over MCP): Phases 2-3. ✓
- Deterministic write path (file-first, inbox, no orphan): Phase 1.3 + 2.2. ✓
- Phase 4 upkeep → on-demand `maintenance_report` (not a session-end hook), no re-embed: Phase 5. ✓ (re-embed stays the app's Clusters button — noted)
- Read-only-by-default security boundary: Phase 2.1 `--allow-write` gate. ✓
- Lifecycle/stale-vault: Phase 4 startup log + `--check`. ✓

**Placeholder scan:** none — every code step has complete code; the three "confirm signature at file:line" notes (IndexOutcome variants, knn::knn call, related_notes shape) reference REAL existing code the executor verifies, not undefined symbols.

**Type consistency:** `write_note` returns `Result<String,String>` (Task 1.3) consumed in Task 2.2; `ManifestEntry`/`RelatedResult`/`MaintenanceReport` defined in queries.rs and dispatched in mcp.rs with matching field names; `handle_request`/`call_tool`/`tool_defs` arity changes (`&mut Connection`, `allow_write`, `root`) applied consistently across Tasks 2.1-5.1 and the existing tests.

**Known follow-ups (out of scope, by ADR):** free-text semantic search over MCP + RRF fusion (needs the model in the sidecar); NFC path normalization (pipeline.rs:63 gap — agent writes are ASCII-slugged in `derive_rel`, sidestepping it for new notes); app-managed sidecar launch (rejected — client owns lifecycle).
