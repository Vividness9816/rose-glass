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
use desktop_lib::{cluster, embed, knn};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const PROTOCOL_VERSION: &str = "2025-06-18";
/// Reject a pathological multi-MB free-text query before the model load (MiniLM truncates to its
/// token window anyway). Mirrors commands.rs.
const MAX_QUERY_BYTES: usize = 8192;
/// Cap the semantic top-k (response + title fan-out) for an untrusted k.
const MAX_KNN_K: usize = 200;

/// One process-wide embedding model for the sidecar (one process serves one vault over stdio).
/// Lazily loaded on the first reembed/semantic_search; a failed load is remembered (no re-download).
/// ponytail: process-global because the sidecar is single-vault/single-process — key by vault if it
/// ever multiplexes.
fn model_cache() -> &'static Mutex<embed::ModelCache> {
    static C: OnceLock<Mutex<embed::ModelCache>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(embed::ModelCache::default()))
}

/// The on-disk model-cache dir, resolved once in main() (mirrors the app's app_cache_dir()/models
/// so the sidecar reuses the already-downloaded model). Defaults to "." only if main() never set it
/// (the model-free test paths never load the model, so they never read it).
static MODEL_DIR: OnceLock<PathBuf> = OnceLock::new();
fn model_dir() -> &'static Path {
    MODEL_DIR.get().map(|p| p.as_path()).unwrap_or_else(|| Path::new("."))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The app stores the model under Tauri's `app_cache_dir()/models` for identifier
/// `lab.home.roseglass`. The sidecar has no AppHandle, so derive the same OS cache base from env
/// (Windows %LOCALAPPDATA%; macOS ~/Library/Caches; else $XDG_CACHE_HOME or ~/.cache). A
/// `--model-cache <dir>` flag overrides if the derivation ever diverges (the resolved dir is logged
/// at startup, so a needless re-download is diagnosable). Last-ditch: the gitignored vault metadata.
fn resolve_model_dir(args: &[String], vault_root: &Path) -> PathBuf {
    if let Some(dir) = parse_flag(args, "--model-cache") {
        return PathBuf::from(dir);
    }
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Caches"))
    } else {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
    };
    base.map(|b| b.join("lab.home.roseglass").join("models"))
        .unwrap_or_else(|| vault_root.join(".rose-glass").join("models"))
}

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

    // Resolve the model-cache dir once (used only by the write-mode reembed/semantic_search).
    let resolved_model_dir = resolve_model_dir(&args, &root);
    let _ = MODEL_DIR.set(resolved_model_dir.clone());

    // Loud startup line on stderr (stdout is the JSON-RPC channel) so a stale/wrong --vault, an
    // unexpected mode, or a mismatched model-cache dir (→ a needless re-download) is diagnosable.
    eprintln!(
        "rose-glass-mcp: vault={} db={} mode={} model_cache={}",
        root.display(),
        db_path.display(),
        if allow_write { "read-write" } else { "read-only" },
        resolved_model_dir.display(),
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

/// Value of `--name <value>` or `--name=<value>` from argv, if present.
fn parse_flag(args: &[String], name: &str) -> Option<String> {
    let eq = format!("{name}=");
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == name {
            return it.next().cloned();
        }
        if let Some(v) = a.strip_prefix(&eq) {
            return Some(v.to_string());
        }
    }
    None
}

fn parse_vault(args: &[String]) -> Option<String> {
    parse_flag(args, "--vault")
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
        tools.push(json!({
            "name": "reembed",
            "description": "Recompute the vault's note embeddings + clusters (full corpus) so `related` and `semantic_search` work. No-op when already fresh (embedded == note count). Embeddings are a derived cache: opening the desktop app rebuilds the index and clears them, so re-run `reembed` if `related`/`semantic_search` report ready:false. Loads the local model on first use (slow once). --allow-write only.",
            "inputSchema": { "type": "object", "properties": {} }
        }));
        tools.push(json!({
            "name": "semantic_search",
            "description": "Free-text semantic search: embed `query` with the local model and rank notes by meaning, not keywords. Use when `search` (keyword/FTS) returns nothing for a conceptual query. Returns ready:false if embeddings have not been computed — run `reembed` first. --allow-write only (the embedding model loads only in write mode; the default read-only sidecar stays model-free).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Free-text query (semantic, not FTS)." },
                    "k": { "type": "integer", "default": 10, "description": "Max results." }
                },
                "required": ["query"]
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
        "reembed" if allow_write => reembed(id, conn),
        "semantic_search" if allow_write => semantic_search(id, &args, &*conn),
        // Unadvertised + uncallable without the flag: a hand-rolled client that sends one anyway
        // gets method-not-found, never a write / model load.
        "upsert_note" | "reembed" | "semantic_search" => {
            err(id, -32601, &format!("{name} requires --allow-write"))
        }
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

/// reembed: full-corpus recompute of embeddings + clusters, reusing the app's SINGLE embedding
/// writer (`cluster::store_clusters`) — no second/incremental write-semantics (ADR-20260624). The
/// skip-if-fresh guard (embedded == note count, or empty vault) short-circuits BEFORE loading the
/// ~90MB model, so a no-op call is cheap and never contends with the app. Mirrors
/// `commands::recompute_clusters` minus the AppState lock dance (the sidecar is single-threaded).
/// Returns a structured before/after result so the agent (and the server log) can see what happened.
fn reembed(id: Option<Value>, conn: &mut Connection) -> Value {
    let (before, notes) = match queries::embedding_freshness(conn, embed::MODEL_NAME) {
        Ok(v) => v,
        Err(e) => return tool_err(id, &e.to_string()),
    };
    let report = |reembedded: bool, after: i64| {
        json!({
            "reembedded": reembedded,
            "note_count": notes,
            "embedded_before": before,
            "embedded_after": after,
            "model": embed::MODEL_NAME,
        })
    };
    // Nothing to embed, or already fresh → no-op, no model load (skip-if-fresh).
    if notes == 0 || before == notes {
        return tool_ok(id, &report(false, before));
    }
    // Stale/empty embeddings → full corpus recompute: read_texts → embed (loads the model once) →
    // store_clusters (the one embedding writer; DELETE-all + reinsert + k-means, in one tx).
    let rows = match cluster::read_texts(conn) {
        Ok(r) => r,
        Err(e) => return tool_err(id, &e.to_string()),
    };
    let texts: Vec<&str> = rows.iter().map(|(_, t)| t.as_str()).collect();
    let vectors = match embed::with_model(model_cache(), model_dir(), |m| embed::embed_texts(m, &texts)) {
        Ok(v) => v,
        Err(e) => return tool_err(id, &e),
    };
    let items: Vec<(String, Vec<f32>)> = rows.into_iter().map(|(p, _)| p).zip(vectors).collect();
    if let Err(e) = cluster::store_clusters(conn, &items, cluster::K, embed::MODEL_NAME, now_secs()) {
        return tool_err(id, &e.to_string());
    }
    let after = queries::embedding_freshness(conn, embed::MODEL_NAME)
        .map(|(e, _)| e)
        .unwrap_or(before);
    tool_ok(id, &report(true, after))
}

/// semantic_search: embed `query` with the local model and rank stored embeddings by cosine
/// (reuses the pure `knn`). A READ, but the model only loads in --allow-write mode (where `reembed`
/// already loads it), so the default read-only sidecar stays model-free. `ready:false` (model-free
/// short-circuit) when no embeddings exist — the agent should run `reembed` first; an empty result
/// then never reads as "nothing matches". `stale:true` when some notes are unembedded.
fn semantic_search(id: Option<Value>, args: &Value, conn: &Connection) -> Value {
    let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
    let k = args.get("k").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
    if query.len() > MAX_QUERY_BYTES {
        return tool_err(id, &format!("query too long ({} bytes; cap {MAX_QUERY_BYTES})", query.len()));
    }
    let (emb, notes) = match queries::embedding_freshness(conn, embed::MODEL_NAME) {
        Ok(v) => v,
        Err(e) => return tool_err(id, &e.to_string()),
    };
    if emb == 0 {
        // model-free short-circuit: no embeddings yet → ready:false (run reembed), not "no matches".
        return tool_ok(
            id,
            &json!({
                "ready": false, "stale": false, "hits": [],
                "hint": "no embeddings yet — run reembed (under --allow-write) to enable semantic search",
            }),
        );
    }
    let corpus = match queries::read_embeddings(conn, embed::MODEL_NAME) {
        Ok(c) => c,
        Err(e) => return tool_err(id, &e.to_string()),
    };
    let stale = emb < notes;
    let query_vec = match embed::with_model(model_cache(), model_dir(), |m| {
        embed::embed_texts(m, std::slice::from_ref(&query))
    }) {
        Ok(v) => v.into_iter().next().unwrap_or_default(),
        Err(e) => return tool_err(id, &e),
    };
    let scored = knn::knn(&query_vec, &corpus, k.min(MAX_KNN_K), None);
    let hits = queries::titles_for(conn, scored);
    tool_ok(id, &json!({ "ready": true, "stale": stale, "hits": hits }))
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

    // ── ADR-20260624: reembed (freshness) + semantic_search, --allow-write only ──────

    #[test]
    fn reembed_and_semantic_search_hidden_without_allow_write() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":90,"method":"tools/list"}),
            &mut seeded(), false, std::path::Path::new("."),
        ).unwrap();
        let names: Vec<&str> = resp["result"]["tools"].as_array().unwrap().iter()
            .map(|t| t["name"].as_str().unwrap()).collect();
        assert!(!names.contains(&"reembed"), "reembed must be hidden in read-only mode");
        assert!(!names.contains(&"semantic_search"), "semantic_search must be hidden in read-only mode");
    }

    #[test]
    fn reembed_and_semantic_search_shown_with_allow_write() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":91,"method":"tools/list"}),
            &mut seeded(), true, std::path::Path::new("."),
        ).unwrap();
        let names: Vec<&str> = resp["result"]["tools"].as_array().unwrap().iter()
            .map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"reembed"));
        assert!(names.contains(&"semantic_search"));
    }

    #[test]
    fn reembed_rejected_without_allow_write() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":92,"method":"tools/call",
                    "params":{"name":"reembed","arguments":{}}}),
            &mut seeded(), false, std::path::Path::new("."),
        ).unwrap();
        assert_eq!(resp["error"]["code"], -32601, "reembed must be method-not-found without --allow-write");
    }

    #[test]
    fn reembed_noops_on_empty_vault() {
        let mut conn = db::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":93,"method":"tools/call",
                    "params":{"name":"reembed","arguments":{}}}),
            &mut conn, true, std::path::Path::new("."),
        ).unwrap();
        assert_eq!(resp["result"]["isError"], false, "resp: {resp}");
        assert_eq!(resp["result"]["structuredContent"]["reembedded"], false);
        assert_eq!(resp["result"]["structuredContent"]["note_count"], 0);
    }

    #[test]
    fn reembed_skips_when_already_fresh_without_loading_model() {
        // 1 note + its embedding already present (embedded_count == note_count) → no-op, and
        // crucially NO model load: model_dir points nowhere, so a load attempt would error. The
        // skip-if-fresh guard must short-circuit before touching the model.
        let mut conn = seeded(); // a.md note (+ cluster), no embedding yet
        conn.execute(
            "INSERT INTO embeddings (path, vector, model) VALUES ('a.md', ?1, ?2)",
            rusqlite::params![vec![0u8, 0, 0, 0], desktop_lib::embed::MODEL_NAME],
        )
        .unwrap();
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":94,"method":"tools/call",
                    "params":{"name":"reembed","arguments":{}}}),
            &mut conn, true, std::path::Path::new("."),
        ).unwrap();
        assert_eq!(resp["result"]["isError"], false, "resp: {resp}");
        assert_eq!(resp["result"]["structuredContent"]["reembedded"], false, "already fresh → no recompute");
        assert_eq!(resp["result"]["structuredContent"]["embedded_after"], 1);
    }

    #[test]
    fn semantic_search_rejected_without_allow_write() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":95,"method":"tools/call",
                    "params":{"name":"semantic_search","arguments":{"query":"x"}}}),
            &mut seeded(), false, std::path::Path::new("."),
        ).unwrap();
        assert_eq!(resp["error"]["code"], -32601, "semantic_search must require --allow-write");
    }

    #[test]
    fn semantic_search_reports_not_ready_on_empty_embeddings_without_loading_model() {
        // seeded() has a note but no embeddings → ready:false, model-free (must NOT load the model;
        // model_dir points nowhere). Mirrors `related`'s ready:false so empty ≠ "nothing matches".
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":96,"method":"tools/call",
                    "params":{"name":"semantic_search","arguments":{"query":"anything"}}}),
            &mut seeded(), true, std::path::Path::new("."),
        ).unwrap();
        assert_eq!(resp["result"]["isError"], false, "resp: {resp}");
        assert_eq!(resp["result"]["structuredContent"]["ready"], false);
    }

    #[test]
    fn semantic_search_rejects_overlong_query_before_model_load() {
        let big = "x".repeat(8193); // > MAX_QUERY_BYTES (8192)
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":97,"method":"tools/call",
                    "params":{"name":"semantic_search","arguments":{"query": big}}}),
            &mut seeded(), true, std::path::Path::new("."),
        ).unwrap();
        assert_eq!(resp["result"]["isError"], true, "overlong query must be rejected before the model load");
    }

    #[test]
    fn resolve_model_dir_prefers_flag_else_models_subdir() {
        // An explicit --model-cache wins verbatim.
        let flagged = resolve_model_dir(
            &["--model-cache".into(), "C:/custom/dir".into()],
            Path::new("vault"),
        );
        assert_eq!(flagged, PathBuf::from("C:/custom/dir"));
        // Otherwise the derived path lives in a `models/` dir (OS cache base / identifier, or fallback).
        let derived = resolve_model_dir(&["--vault".into(), "v".into()], Path::new("vault"));
        assert_eq!(derived.file_name().and_then(|s| s.to_str()), Some("models"));
    }

    /// Real-model E2E: reembed actually embeds + stores, the second call no-ops (skip-if-fresh),
    /// and semantic_search ranks a CONCEPTUAL query with no keyword overlap onto the right notes —
    /// the zero-FTS-hit hole the feature exists to close. #[ignore]d (uses the ~90MB ONNX model,
    /// cached after first run); run with `--ignored`. Reuses the temp cache the other ignored
    /// embed tests use.
    #[test]
    #[ignore = "uses the real ONNX model; run with --ignored"]
    fn reembed_then_semantic_search_end_to_end_with_real_model() {
        let _ = MODEL_DIR.set(std::env::temp_dir().join("rg-fastembed-cache"));
        let mut conn = db::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        for (p, t, b) in [
            ("cooking.md", "Cooking Pasta", "boil water add salt cook the pasta al dente then drain"),
            ("sauce.md", "Tomato Sauce", "simmer tomatoes garlic basil and olive oil into a pasta sauce"),
            ("holes.md", "Black Holes", "a black hole bends spacetime so light cannot escape it"),
            ("stars.md", "Neutron Stars", "a neutron star is the dense collapsed core of a massive star"),
        ] {
            conn.execute(
                "INSERT INTO notes (path,title,content_hash,mtime,word_count,indexed_at) VALUES (?1,?2,'h',0,1,0)",
                rusqlite::params![p, t],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO notes_fts (path,title,body) VALUES (?1,?2,?3)",
                rusqlite::params![p, t, b],
            )
            .unwrap();
        }
        let call = |conn: &mut Connection, args: Value| {
            handle_request(
                &json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":args}),
                conn,
                true,
                Path::new("."),
            )
            .unwrap()
        };
        // reembed embeds all 4
        let r = call(&mut conn, json!({"name":"reembed","arguments":{}}));
        assert_eq!(r["result"]["structuredContent"]["reembedded"], true, "resp {r}");
        assert_eq!(r["result"]["structuredContent"]["embedded_after"], 4);
        // second call is a skip-if-fresh no-op
        let r2 = call(&mut conn, json!({"name":"reembed","arguments":{}}));
        assert_eq!(r2["result"]["structuredContent"]["reembedded"], false, "already fresh");
        // a conceptual query sharing NO keyword with the notes still ranks a cooking note first
        let s = call(&mut conn, json!({"name":"semantic_search","arguments":{"query":"recipe for dinner","k":2}}));
        assert_eq!(s["result"]["structuredContent"]["ready"], true, "resp {s}");
        let hits = s["result"]["structuredContent"]["hits"].as_array().unwrap();
        let top = hits.first().and_then(|h| h["path"].as_str()).unwrap_or("");
        assert!(
            top == "cooking.md" || top == "sauce.md",
            "‘recipe for dinner’ (no shared keyword) should rank a cooking note top, got {top}"
        );
    }
}
