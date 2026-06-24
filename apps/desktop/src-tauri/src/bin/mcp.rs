//! rose-glass-mcp — a read-only MCP sidecar (spec §14). Speaks JSON-RPC 2.0
//! (MCP protocol 2025-06-18) over stdio, newline-delimited, exposing two tools over
//! the vault's derived index.db:
//!   - `search`(query)            → FTS5 hits (reuses desktop_lib::db::queries::search_fts)
//!   - `get_semantic_clusters`()  → clusters grouped by id (empty until the embeddings phase)
//!
//! Usage: rose-glass-mcp --vault <vault-dir>   (opens <vault>/.rose-glass/index.db read-only)
//!
//! ponytail: this bin links the whole desktop_lib (so the binary is heavier than a pure
//! SQL+stdio server). Reusing the canonical, tested queries beats duplicating the schema
//! SQL; extract a lean shared `vault-db` crate if/when the sidecar ships standalone.

use desktop_lib::capture;
use desktop_lib::db::{self, queries};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

const PROTOCOL_VERSION: &str = "2025-06-18";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(vault) = parse_vault(&args) else {
        eprintln!("usage: rose-glass-mcp --vault <vault-dir> [--allow-write]");
        std::process::exit(2);
    };
    // Read-only by DEFAULT (§18). `--allow-write` flips the DB OpenFlags to RW *and* makes
    // tool_defs advertise upsert_note, so a plain invocation is provably read-only by construction.
    let allow_write = args.iter().any(|a| a == "--allow-write");
    // Canonicalize the vault root so safe_join (which canonicalizes too) and the write path agree,
    // and the resolved path is loggable; fall back to the raw arg if it doesn't resolve yet.
    let root = std::fs::canonicalize(&vault).unwrap_or_else(|_| PathBuf::from(&vault));
    let db_path = root.join(".rose-glass").join("index.db");

    // `--check` doctor: print one JSON status line and exit (no read loop). Always opens the db
    // READ-ONLY. Exit 0 if the index exists, 1 if it's missing/unreadable, 2 on bad args (above).
    // Diagnoses the most common foot-gun: --vault pointing at a folder with no built index.
    if args.iter().any(|a| a == "--check") {
        let exists = db_path.exists();
        let (count, last): (i64, i64) = if exists {
            match db::open_indexed(&db_path, db::Mode::ReadOnly) {
                Ok(c) => (
                    c.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap_or(0),
                    c.query_row("SELECT COALESCE(MAX(indexed_at),0) FROM notes", [], |r| r.get(0))
                        .unwrap_or(0),
                ),
                Err(e) => {
                    eprintln!("rose-glass-mcp --check: cannot open db: {e}");
                    std::process::exit(1);
                }
            }
        } else {
            (0, 0)
        };
        println!(
            "{}",
            json!({
                "vault": root.display().to_string(),
                "db": db_path.display().to_string(),
                "exists": exists,
                "note_count": count,
                "last_indexed_at": last,
                "mode": if allow_write { "read-write" } else { "read-only" },
            })
        );
        std::process::exit(if exists { 0 } else { 1 });
    }

    // Open through the canonical constructor so the sidecar's connection matches the app's/tests'
    // pragmas (FK ON + busy_timeout; WAL/synchronous when read-write) — no hand-rolled flags.
    let mode = if allow_write { db::Mode::ReadWrite } else { db::Mode::ReadOnly };
    let mut conn = db::open_indexed(&db_path, mode).unwrap_or_else(|e| {
        eprintln!("rose-glass-mcp: cannot open {}: {e}", db_path.display());
        std::process::exit(1);
    });

    // Loud startup line on stderr (stdout is the JSON-RPC channel) so a stale/wrong --vault or an
    // unexpected read-only/read-write mode is diagnosable from the client's server log.
    eprintln!(
        "rose-glass-mcp: vault={} db={} mode={}",
        root.display(),
        db_path.display(),
        if allow_write { "read-write" } else { "read-only" },
    );

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(&line) else {
            continue; // skip unparseable lines (can't form a JSON-RPC error without an id)
        };
        if let Some(resp) = handle_request(&req, &mut conn, allow_write, &root) {
            let mut out = stdout.lock();
            if writeln!(out, "{resp}").is_err() {
                break;
            }
            let _ = out.flush();
        }
    }
}

fn parse_vault(args: &[String]) -> Option<String> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--vault" {
            return it.next().cloned();
        }
        if let Some(v) = a.strip_prefix("--vault=") {
            return Some(v.to_string());
        }
    }
    None
}

/// Dispatch one JSON-RPC message. Returns `None` for notifications (no `id`) and for
/// messages with no method (nothing to answer).
fn handle_request(req: &Value, conn: &mut Connection, allow_write: bool, root: &Path) -> Option<Value> {
    let id = req.get("id").cloned();
    let method = match req.get("method").and_then(|m| m.as_str()) {
        Some(m) => m,
        // Malformed: a request (has id) MUST get an error; a notification gets nothing.
        None => return id.map(|i| err(Some(i), -32600, "Invalid Request: missing or non-string method")),
    };
    // No id ⇒ a notification ⇒ no response, whatever the method (JSON-RPC 2.0).
    id.as_ref()?;
    match method {
        "initialize" => Some(ok(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "rose-glass", "version": env!("CARGO_PKG_VERSION") }
            }),
        )),
        "tools/list" => Some(ok(id, json!({ "tools": tool_defs(allow_write) }))),
        "tools/call" => Some(call_tool(id, req, conn, allow_write, root)),
        "ping" => Some(ok(id, json!({}))),
        _ => Some(err(id, -32601, &format!("Method not found: {method}"))),
    }
}

fn tool_defs(allow_write: bool) -> Value {
    let mut tools = vec![
        json!({
            "name": "search",
            "description": "Full-text search the Rose Glass vault. Returns matching notes (path, title, snippet) ranked by relevance.",
            "inputSchema": {
                "type": "object",
                "properties": { "query": { "type": "string", "description": "Search terms (FTS5)." } },
                "required": ["query"]
            }
        }),
        json!({
            "name": "get_semantic_clusters",
            "description": "List the vault's semantic clusters (groups of related notes by id). Requires the embeddings/clustering phase; returns an empty list until clusters are computed.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "get_note",
            "description": "Fetch one note's metadata, frontmatter, tags and outgoing links by vault-relative path. Returns null if the path is not indexed.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Vault-relative, forward-slash path." } },
                "required": ["path"]
            }
        }),
        json!({
            "name": "manifest",
            "description": "List every note (path, title, summary, status, tags). One call to triage the whole vault instead of grepping. Notes missing a summary are flagged (summary_present=false).",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "related",
            "description": "Notes semantically related to a given note (by vault-relative path). Model-free. Returns {ready:false} if embeddings have not been computed yet (run the app's Clusters recompute to enable).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "k": { "type": "integer", "default": 10, "description": "Max neighbours to return." }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "maintenance_report",
            "description": "Read-only vault health report: note vs embedding counts (stale flag), notes missing a summary, and orphan notes (no links in or out). Surfaces upkeep work; does not modify anything.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
    ];
    // The write tool is advertised ONLY under --allow-write, so a default (read-only) server is
    // provably non-mutating: a client that never sees upsert_note cannot call it.
    if allow_write {
        tools.push(json!({
            "name": "upsert_note",
            "description": "Capture a note into the vault inbox. Writes a markdown file (the agent MUST provide a one-line summary) and indexes it. The ONLY write path; all writes are confined to inbox/ (it cannot touch other vault notes). Omit `path` to create inbox/<slug>.md (auto-deduped, never clobbers); pass an inbox/*.md `path` to update that capture in place.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title":   { "type": "string" },
                    "summary": { "type": "string", "minLength": 1, "description": "One-line summary (mandatory)." },
                    "body":    { "type": "string" },
                    "tags":    { "type": "array", "items": { "type": "string" } },
                    "path":    { "type": "string", "description": "Optional inbox/<name>.md path to UPDATE in place; omit to create inbox/<slug>.md. Confined to inbox/." }
                },
                "required": ["title", "summary", "body"]
            }
        }));
    }
    Value::Array(tools)
}

fn call_tool(
    id: Option<Value>,
    req: &Value,
    conn: &mut Connection,
    allow_write: bool,
    root: &Path,
) -> Value {
    let params = req.get("params");
    let name = params
        .and_then(|p| p.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("");
    let args = params
        .and_then(|p| p.get("arguments"))
        .cloned()
        .unwrap_or_else(|| json!({}));

    match name {
        "search" => {
            let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            match queries::search_fts(&*conn, q) {
                Ok(hits) => tool_ok(id, &hits),
                Err(e) => tool_err(id, &e.to_string()),
            }
        }
        "get_semantic_clusters" => match queries::get_clusters(&*conn) {
            Ok(groups) => tool_ok(id, &groups),
            Err(e) => tool_err(id, &e.to_string()),
        },
        "get_note" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            match queries::get_note(&*conn, path) {
                Ok(Some(note)) => tool_ok(id, &note),
                Ok(None) => tool_ok(id, &Value::Null), // not indexed → null, not an error
                Err(e) => tool_err(id, &e.to_string()),
            }
        }
        "manifest" => match queries::manifest(&*conn) {
            Ok(entries) => tool_ok(id, &entries),
            Err(e) => tool_err(id, &e.to_string()),
        },
        "related" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let k = args.get("k").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
            match queries::related(&*conn, path, k.min(200)) {
                Ok(res) => tool_ok(id, &res),
                Err(e) => tool_err(id, &e.to_string()),
            }
        }
        "maintenance_report" => match queries::maintenance_report(&*conn) {
            Ok(rep) => tool_ok(id, &rep),
            Err(e) => tool_err(id, &e.to_string()),
        },
        "upsert_note" if allow_write => upsert_note(id, &args, conn, root),
        // Unadvertised + uncallable without the flag: a hand-rolled client that sends it anyway
        // gets method-not-found, never a write.
        "upsert_note" => err(id, -32601, "upsert_note requires --allow-write"),
        other => err(id, -32602, &format!("Unknown tool: {other}")),
    }
}

/// The MCP write tool: validate the mandatory non-empty `summary` at the call boundary (the schema
/// `required` is satisfied by ""), assemble schema-valid markdown, resolve the target (explicit
/// `path` updates in place; omitted → a deduped inbox/<slug>.md), and route through the ONE confined
/// `capture::write_note` so the file is canonical and the SQLite row is derived (A3 preserved).
fn upsert_note(id: Option<Value>, args: &Value, conn: &mut Connection, root: &Path) -> Value {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let title = s("title");
    let summary = s("summary");
    let body = s("body");
    if summary.trim().is_empty() {
        return err(id, -32602, "summary is required and must be non-empty");
    }
    let tags: Vec<String> = args
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let rel = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p.to_string(), // update in place (no dedup)
        _ => capture::dedup_rel(root, &capture::derive_rel(&title)), // new note, never clobbers
    };
    let content = capture::build_markdown(&title, &summary, &tags, &body);
    match capture::write_note(conn, root, &rel, &content) {
        Ok(written) => tool_ok(id, &json!({ "path": written, "indexed": true })),
        Err(e) => tool_err(id, &e),
    }
}

fn ok(id: Option<Value>, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn err(id: Option<Value>, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// A successful tool result: the data as both a JSON text block (canonical, per spec)
/// and `structuredContent` (for clients that consume structured output).
fn tool_ok<T: Serialize>(id: Option<Value>, data: &T) -> Value {
    let structured = serde_json::to_value(data).unwrap_or(Value::Null);
    let text = serde_json::to_string_pretty(data).unwrap_or_default();
    ok(
        id,
        json!({
            "content": [ { "type": "text", "text": text } ],
            "structuredContent": structured,
            "isError": false
        }),
    )
}

fn tool_err(id: Option<Value>, message: &str) -> Value {
    ok(
        id,
        json!({
            "content": [ { "type": "text", "text": format!("error: {message}") } ],
            "isError": true
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use desktop_lib::db;

    fn seeded() -> Connection {
        let conn = db::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO notes (path,title,content_hash,mtime,word_count,indexed_at)
             VALUES ('a.md','Alpha Note','h',0,3,0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes_fts (path,title,body) VALUES ('a.md','Alpha Note','the quick brown fox')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO clusters (path,cluster_id,computed_at) VALUES ('a.md',0,0)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn initialize_echoes_protocol_and_advertises_tools() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":1,"method":"initialize",
                    "params":{"protocolVersion":"2025-06-18"}}),
            &mut seeded(), false, std::path::Path::new("."),
        )
        .unwrap();
        assert_eq!(resp["result"]["protocolVersion"], "2025-06-18");
        assert!(resp["result"]["capabilities"]["tools"].is_object());
        assert_eq!(resp["id"], 1);
    }

    #[test]
    fn tools_list_has_search_and_clusters() {
        let resp =
            handle_request(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}), &mut seeded(), false, std::path::Path::new("."))
                .unwrap();
        let names: Vec<&str> = resp["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"search"));
        assert!(names.contains(&"get_semantic_clusters"));
    }

    #[test]
    fn search_returns_hits_from_the_index() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":3,"method":"tools/call",
                    "params":{"name":"search","arguments":{"query":"quick fox"}}}),
            &mut seeded(), false, std::path::Path::new("."),
        )
        .unwrap();
        assert_eq!(resp["result"]["isError"], false);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("a.md"), "search text was: {text}");
        assert_eq!(resp["result"]["structuredContent"][0]["path"], "a.md");
    }

    #[test]
    fn get_semantic_clusters_groups_members() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":4,"method":"tools/call",
                    "params":{"name":"get_semantic_clusters","arguments":{}}}),
            &mut seeded(), false, std::path::Path::new("."),
        )
        .unwrap();
        assert_eq!(resp["result"]["isError"], false);
        assert_eq!(resp["result"]["structuredContent"][0]["cluster_id"], 0);
        assert_eq!(
            resp["result"]["structuredContent"][0]["members"][0]["path"],
            "a.md"
        );
    }

    #[test]
    fn notification_gets_no_response() {
        assert!(handle_request(
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            &mut seeded(), false, std::path::Path::new(".")
        )
        .is_none());
    }

    #[test]
    fn unknown_method_is_method_not_found() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":9,"method":"bogus/method"}),
            &mut seeded(), false, std::path::Path::new("."),
        )
        .unwrap();
        assert_eq!(resp["error"]["code"], -32601);
    }

    #[test]
    fn unknown_tool_is_invalid_params() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":10,"method":"tools/call",
                    "params":{"name":"nope","arguments":{}}}),
            &mut seeded(), false, std::path::Path::new("."),
        )
        .unwrap();
        assert_eq!(resp["error"]["code"], -32602);
    }

    #[test]
    fn request_missing_method_is_invalid_request() {
        // has an id (a request) but no method → must answer -32600, not hang the client
        let resp = handle_request(&json!({"jsonrpc":"2.0","id":5}), &mut seeded(), false, std::path::Path::new(".")).unwrap();
        assert_eq!(resp["error"]["code"], -32600);
        assert_eq!(resp["id"], 5);
    }

    #[test]
    fn known_method_without_id_is_a_notification() {
        // a known method sent without an id is a notification → no response (no id:null reply)
        assert!(handle_request(&json!({"jsonrpc":"2.0","method":"ping"}), &mut seeded(), false, std::path::Path::new(".")).is_none());
    }

    // ── Phase 2: --allow-write gate + upsert_note ───────────────────────────

    #[test]
    fn upsert_tool_hidden_without_allow_write() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":20,"method":"tools/list"}),
            &mut seeded(), false, std::path::Path::new("."),
        ).unwrap();
        let names: Vec<&str> = resp["result"]["tools"].as_array().unwrap().iter()
            .map(|t| t["name"].as_str().unwrap()).collect();
        assert!(!names.contains(&"upsert_note"), "write tool must be hidden in read-only mode");
    }

    #[test]
    fn upsert_tool_shown_with_allow_write() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":21,"method":"tools/list"}),
            &mut seeded(), true, std::path::Path::new("."),
        ).unwrap();
        let names: Vec<&str> = resp["result"]["tools"].as_array().unwrap().iter()
            .map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"upsert_note"));
    }

    #[test]
    fn upsert_call_rejected_without_allow_write() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":22,"method":"tools/call",
                    "params":{"name":"upsert_note","arguments":{"title":"T","summary":"s","body":"b"}}}),
            &mut seeded(), false, std::path::Path::new("."),
        ).unwrap();
        assert_eq!(resp["error"]["code"], -32601, "write tool must be method-not-found in read-only mode");
    }

    #[test]
    fn upsert_note_writes_and_indexes() {
        let root = tempfile::tempdir().unwrap();
        // a real on-disk db so incremental can open a tx against the vault
        let p = root.path().join(".rose-glass/index.db");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let mut c = db::open_db(&p).unwrap();
        db::migrate(&c).unwrap();
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":30,"method":"tools/call",
                    "params":{"name":"upsert_note","arguments":{"title":"Test Note","summary":"a summary","body":"the body"}}}),
            &mut c, true, root.path(),
        ).unwrap();
        assert_eq!(resp["result"]["isError"], false, "resp: {resp}");
        assert_eq!(resp["result"]["structuredContent"]["path"], "inbox/test-note.md");
        assert!(root.path().join("inbox/test-note.md").exists());
    }

    #[test]
    fn maintenance_report_tool_runs() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":70,"method":"tools/call",
                    "params":{"name":"maintenance_report","arguments":{}}}),
            &mut seeded(), false, std::path::Path::new("."),
        ).unwrap();
        assert_eq!(resp["result"]["isError"], false);
        assert_eq!(resp["result"]["structuredContent"]["note_count"], 1);
    }

    #[test]
    fn related_tool_reports_not_ready_on_empty_embeddings() {
        // seeded() has notes but no embeddings → ready:false (so an empty list isn't read as
        // "no related notes" when it really means "not computed yet").
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":60,"method":"tools/call",
                    "params":{"name":"related","arguments":{"path":"a.md"}}}),
            &mut seeded(), false, std::path::Path::new("."),
        ).unwrap();
        assert_eq!(resp["result"]["isError"], false);
        assert_eq!(resp["result"]["structuredContent"]["ready"], false);
    }

    #[test]
    fn manifest_tool_lists_notes() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":50,"method":"tools/call",
                    "params":{"name":"manifest","arguments":{}}}),
            &mut seeded(), false, std::path::Path::new("."),
        ).unwrap();
        assert_eq!(resp["result"]["isError"], false);
        assert_eq!(resp["result"]["structuredContent"][0]["path"], "a.md");
    }

    #[test]
    fn get_note_returns_the_note() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":40,"method":"tools/call",
                    "params":{"name":"get_note","arguments":{"path":"a.md"}}}),
            &mut seeded(), false, std::path::Path::new("."),
        ).unwrap();
        assert_eq!(resp["result"]["isError"], false);
        assert_eq!(resp["result"]["structuredContent"]["title"], "Alpha Note");
    }

    #[test]
    fn get_note_missing_path_returns_null_not_error() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":41,"method":"tools/call",
                    "params":{"name":"get_note","arguments":{"path":"nope.md"}}}),
            &mut seeded(), false, std::path::Path::new("."),
        ).unwrap();
        assert_eq!(resp["result"]["isError"], false);
        assert!(resp["result"]["structuredContent"].is_null());
    }

    #[test]
    fn upsert_note_dedups_colliding_title_instead_of_clobbering() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path().join(".rose-glass/index.db");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let mut c = db::open_db(&p).unwrap();
        db::migrate(&c).unwrap();
        let mk = |body: &str| json!({"jsonrpc":"2.0","id":80,"method":"tools/call",
            "params":{"name":"upsert_note","arguments":{"title":"Test Note","summary":"s","body":body}}});
        let r1 = handle_request(&mk("first"), &mut c, true, root.path()).unwrap();
        assert_eq!(r1["result"]["structuredContent"]["path"], "inbox/test-note.md");
        let r2 = handle_request(&mk("second"), &mut c, true, root.path()).unwrap();
        assert_eq!(r2["result"]["structuredContent"]["path"], "inbox/test-note-2.md", "must dedup, not clobber");
        assert!(root.path().join("inbox/test-note.md").exists());
        assert!(root.path().join("inbox/test-note-2.md").exists());
    }

    #[test]
    fn upsert_note_updates_in_place_via_explicit_path() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path().join(".rose-glass/index.db");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let mut c = db::open_db(&p).unwrap();
        db::migrate(&c).unwrap();
        handle_request(
            &json!({"jsonrpc":"2.0","id":81,"method":"tools/call","params":{"name":"upsert_note",
                "arguments":{"title":"First","summary":"s","body":"a","path":"inbox/note.md"}}}),
            &mut c, true, root.path(),
        ).unwrap();
        let r = handle_request(
            &json!({"jsonrpc":"2.0","id":82,"method":"tools/call","params":{"name":"upsert_note",
                "arguments":{"title":"Second","summary":"s","body":"b changed","path":"inbox/note.md"}}}),
            &mut c, true, root.path(),
        ).unwrap();
        assert_eq!(r["result"]["structuredContent"]["path"], "inbox/note.md");
        let count: i64 = c.query_row("SELECT COUNT(*) FROM notes WHERE path='inbox/note.md'", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1, "explicit path updates in place, not a new row");
        let title: String = c.query_row("SELECT title FROM notes WHERE path='inbox/note.md'", [], |r| r.get(0)).unwrap();
        assert_eq!(title, "Second", "content refreshed in place");
    }

    #[test]
    fn upsert_note_rejects_non_inbox_path() {
        // The explicit-path branch must not let an agent overwrite an arbitrary vault note.
        let root = tempfile::tempdir().unwrap();
        let p = root.path().join(".rose-glass/index.db");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let mut c = db::open_db(&p).unwrap();
        db::migrate(&c).unwrap();
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":83,"method":"tools/call","params":{"name":"upsert_note",
                "arguments":{"title":"x","summary":"s","body":"b","path":"README.md"}}}),
            &mut c, true, root.path(),
        ).unwrap();
        assert_eq!(resp["result"]["isError"], true, "writing outside inbox/ must be refused");
        assert!(!root.path().join("README.md").exists());
    }

    #[test]
    fn upsert_note_rejects_empty_summary() {
        let root = tempfile::tempdir().unwrap();
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":31,"method":"tools/call",
                    "params":{"name":"upsert_note","arguments":{"title":"T","summary":"   ","body":"b"}}}),
            &mut seeded(), true, root.path(),
        ).unwrap();
        assert_eq!(resp["error"]["code"], -32602, "empty-after-trim summary must be rejected");
    }
}
