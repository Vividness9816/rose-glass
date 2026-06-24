# Agent interface (MCP)

Rose Glass exposes its vault to an MCP client (e.g. Claude Code) through a small **stdio
sidecar** — `rose-glass-mcp` — so an agent navigates and captures notes through tools instead of
ripgrep + sequential file reads. The sidecar is spawned by the **client**, so it works even when
the desktop app is closed.

> Founding decision: `ADR-20260623-rose-glass-agent-interface`. Discovery: [agent-interface-findings.md](agent-interface-findings.md).

## Tools

**Read-only (always available):**

| Tool | Purpose |
|---|---|
| `search(query)` | Full-text (FTS5) search → ranked notes (path, title, snippet). |
| `get_note(path)` | One note's metadata, frontmatter, tags, outgoing links. `null` if not indexed. |
| `manifest()` | Every note (path, title, summary, status, tags) in one call — whole-vault triage instead of grepping. Notes with no summary are flagged (`summary_present: false`). |
| `related(path, k?)` | Notes semantically nearest `path` by cosine over stored embeddings (model-free). Returns `{ ready: false }` if embeddings haven't been computed — run `reembed` (write mode) or the app's **Clusters** recompute to enable. |
| `get_semantic_clusters()` | The vault's semantic clusters grouped by id. |
| `maintenance_report()` | Read-only health: note vs embedding counts (stale flag), notes missing a summary, and orphans (no links in or out). Surfaces upkeep; modifies nothing. |

**Write / model (only under `--allow-write`):**

| Tool | Purpose |
|---|---|
| `upsert_note(title, summary, body, tags?, path?)` | Capture a note. `summary` is **mandatory** (rejected if empty). Omit `path` → a new `inbox/<slug>.md` (auto-deduped, never clobbers a different note); pass an `inbox/<name>.md` `path` → update that capture in place. **The only file-write path.** |
| `reembed()` | Recompute the whole vault's embeddings + clusters so `related`/`semantic_search` work. **No-op when already fresh** (`embedded == note count`) — it short-circuits before loading the model. Returns `{ reembedded, note_count, embedded_before, embedded_after, model }`. Embeddings are a derived cache: opening the desktop app rebuilds the index and clears them, so re-run `reembed` if `related`/`semantic_search` report `ready:false`. Reuses the app's single embedding writer (no second write-semantics). |
| `semantic_search(query, k?)` | Free-text semantic search — embed `query` with the local model and rank notes by **meaning, not keywords**. Use when keyword `search` returns nothing for a conceptual query. Returns `{ ready:false }` until `reembed` has run. Advertised only here because the model loads only in write mode. |

## Read-only by default

The default invocation (`rose-glass-mcp --vault X`) opens the index **`SQLITE_OPEN_READ_ONLY`**
and does **not** advertise `upsert_note`, `reembed`, or `semantic_search` in `tools/list` —
read-only is provable by construction, and the default sidecar **never loads the embedding model**.
Passing `--allow-write` flips the connection to read-write *and* registers the write/model tools.

Every file write — create or update — is confined to a **markdown file under `inbox/`**: the sidecar
cannot overwrite an arbitrary vault note or create a non-note file. Writes go to the markdown file
first (atomic temp+fsync+rename); the SQLite row is then **derived** by the indexer, so deleting
`index.db` and rebuilding from disk yields an equivalent index (the A3 invariant). `reembed` writes
only the derived `embeddings`/`clusters` cache (A3-safe) via the app's single embedding writer.
There is no network call in any tool.

**Semantic search (ADR-20260624).** In `--allow-write` mode the sidecar loads the local ONNX model
(all-MiniLM, offline after a one-time fetch) for `reembed` and `semantic_search`. The model cache dir
mirrors the app's (`app_cache_dir()/models`); override with `--model-cache <dir>` if they ever
diverge (the resolved dir is logged at startup). Free-text semantic ranking + note-anchored `related`
together cover the keyword `search`'s blind spot; RRF fusion of the two remains deferred (the agent
blends them in its own reasoning).

## `--check` doctor

```bash
rose-glass-mcp --vault C:/path/to/vault --check
```

Prints one JSON line — `{vault, db, exists, note_count, last_indexed_at, mode}` — and exits **0**
(index present), **1** (missing/unreadable), or **2** (bad args). Use it to confirm `--vault`
points at a folder the app has actually indexed. On startup the server also logs the resolved
vault, canonical `index.db` path, and mode to **stderr** (stdout is the JSON-RPC channel).

## Client config (`.mcp.json`)

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

- Omit `--allow-write` for a **provably read-only** server (no `upsert_note`).
- `--vault` must point at the **same folder the desktop app opens** — the sidecar reads the vault's
  `<vault>/.rose-glass/index.db`, which the app builds. Run `--check` if results look stale.
- The index must already exist (build it by opening the vault in the app once); `--allow-write`
  does not create a new database.
