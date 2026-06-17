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

use desktop_lib::db::queries;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

const PROTOCOL_VERSION: &str = "2025-06-18";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(vault) = parse_vault(&args) else {
        eprintln!("usage: rose-glass-mcp --vault <vault-dir>");
        std::process::exit(2);
    };
    let db_path = std::path::Path::new(&vault)
        .join(".rose-glass")
        .join("index.db");
    // Read-only: the sidecar must never mutate the vault's derived store.
    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .unwrap_or_else(|e| {
        eprintln!("rose-glass-mcp: cannot open {}: {e}", db_path.display());
        std::process::exit(1);
    });
    // Wait out transient SQLITE_BUSY (a WAL checkpoint while the app writes) instead of
    // failing the query — matches the 5000ms the rest of the codebase uses (db::apply_pragmas).
    let _ = conn.busy_timeout(std::time::Duration::from_millis(5000));

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
        if let Some(resp) = handle_request(&req, &conn) {
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
fn handle_request(req: &Value, conn: &Connection) -> Option<Value> {
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
        "tools/list" => Some(ok(id, json!({ "tools": tool_defs() }))),
        "tools/call" => Some(call_tool(id, req, conn)),
        "ping" => Some(ok(id, json!({}))),
        _ => Some(err(id, -32601, &format!("Method not found: {method}"))),
    }
}

fn tool_defs() -> Value {
    json!([
        {
            "name": "search",
            "description": "Full-text search the Rose Glass vault. Returns matching notes (path, title, snippet) ranked by relevance.",
            "inputSchema": {
                "type": "object",
                "properties": { "query": { "type": "string", "description": "Search terms (FTS5)." } },
                "required": ["query"]
            }
        },
        {
            "name": "get_semantic_clusters",
            "description": "List the vault's semantic clusters (groups of related notes by id). Requires the embeddings/clustering phase; returns an empty list until clusters are computed.",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}

fn call_tool(id: Option<Value>, req: &Value, conn: &Connection) -> Value {
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
            match queries::search_fts(conn, q) {
                Ok(hits) => tool_ok(id, &hits),
                Err(e) => tool_err(id, &e.to_string()),
            }
        }
        "get_semantic_clusters" => match queries::get_clusters(conn) {
            Ok(groups) => tool_ok(id, &groups),
            Err(e) => tool_err(id, &e.to_string()),
        },
        other => err(id, -32602, &format!("Unknown tool: {other}")),
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
            &seeded(),
        )
        .unwrap();
        assert_eq!(resp["result"]["protocolVersion"], "2025-06-18");
        assert!(resp["result"]["capabilities"]["tools"].is_object());
        assert_eq!(resp["id"], 1);
    }

    #[test]
    fn tools_list_has_search_and_clusters() {
        let resp =
            handle_request(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}), &seeded())
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
            &seeded(),
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
            &seeded(),
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
            &seeded()
        )
        .is_none());
    }

    #[test]
    fn unknown_method_is_method_not_found() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":9,"method":"bogus/method"}),
            &seeded(),
        )
        .unwrap();
        assert_eq!(resp["error"]["code"], -32601);
    }

    #[test]
    fn unknown_tool_is_invalid_params() {
        let resp = handle_request(
            &json!({"jsonrpc":"2.0","id":10,"method":"tools/call",
                    "params":{"name":"nope","arguments":{}}}),
            &seeded(),
        )
        .unwrap();
        assert_eq!(resp["error"]["code"], -32602);
    }

    #[test]
    fn request_missing_method_is_invalid_request() {
        // has an id (a request) but no method → must answer -32600, not hang the client
        let resp = handle_request(&json!({"jsonrpc":"2.0","id":5}), &seeded()).unwrap();
        assert_eq!(resp["error"]["code"], -32600);
        assert_eq!(resp["id"], 5);
    }

    #[test]
    fn known_method_without_id_is_a_notification() {
        // a known method sent without an id is a notification → no response (no id:null reply)
        assert!(handle_request(&json!({"jsonrpc":"2.0","method":"ping"}), &seeded()).is_none());
    }
}
