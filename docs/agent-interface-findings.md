# Phase 0 — Agent-Interface Discovery Findings

**Date:** 2026-06-23
**Scope:** Read-only discovery (no mutations) per the "Wire Rose Glass as the agent-facing
interface" spec, plus root-cause for Issue 1 (clusters show 0 / never auto-organize).
**Method:** 7 parallel subagent readers over `apps/desktop/src-tauri/src/**` and
`apps/desktop/src/**`, every claim cited to `file:line`. Run `wf_2bfb7ad1-3d4`.

> **Gate status:** Findings reported. The Carpathia-vs-standalone fork is **resolved from
> evidence** (§1). Two product forks the code can't decide are surfaced in §6 for the user.
> No code changed in this phase.

---

## 1. THE FORK — resolved: markdown-on-disk is canonical, SQLite is a derived cache

The spec asks whether RG fronts the Carpathia Obsidian vault (markdown canonical) or runs a
standalone store. **The codebase answers unambiguously: option (a), and "Carpathia" is not
special.**

- The vault root is a **user-chosen directory** passed to `open_vault` — not the home dir, not
  a hardwired Carpathia path. RG indexes whatever folder you point it at. (`commands.rs:70-81`)
- SQLite lives at `<vault>/.rose-glass/index.db` and is a **derived, disposable cache** — a
  `.gitignore` ("*") is dropped beside it. (`commands.rs:82-87`)
- The **A3 invariant** is an explicit, tested contract: delete `index.db` (+ `-wal`/`-shm`),
  rebuild from disk, get an equivalent index. (`pipeline.rs:472-504`)
- On open, the whole index is rebuilt by walking the vault with the `ignore` crate, parsing every
  `.md`/`.markdown` (YAML frontmatter via `serde_yaml_ng` → JSON). (`pipeline.rs:82-142`,
  `parse.rs:113-117`)
- A `notify_debouncer_full` watcher (500ms, recursive) re-indexes external edits incrementally;
  **on-disk existence, not event kind, decides reindex-vs-delete** (atomic temp+rename saves are
  handled correctly). (`watcher.rs:77,98-117`, `pipeline.rs:155-176`)
- Markdown is written to disk in exactly **two** places today, both writing the `.md` *file*
  (never a SQLite-only row): editor save (`save_note_file`, atomic temp+fsync+rename,
  `commands.rs:185-204`) and drag-drop ingest (copy into `<vault>/inbox/`,
  `commands.rs:597-636`).

**Decision (forced by the code):** the future `upsert_note` write path **must write a markdown
file to disk** (like `save_note_file`), then let the watcher/indexer derive the SQLite row.
Writing SQLite directly would violate A3. There is no standalone-store option to choose — the
filesystem is the source of truth, full stop.

---

## 2. What already exists vs. the spec (the big news: most of it is built)

| Spec requirement | Status | Evidence |
|---|---|---|
| SQLite store, FTS5 | ✅ **Built** | `notes/links/tags/notes_fts/embeddings/clusters`; FTS5 over title+body, porter+unicode61 (`schema.rs:34-39`) |
| Migration framework | ⚠️ Minimal | Single `PRAGMA user_version` (v1); mismatch = DROP+rebuild, no incremental list (`db/mod.rs:38-49`) — fine for a derived cache |
| Frontmatter parsing | ✅ Built | `serde_yaml_ng` → JSON stored on `notes.frontmatter` (`parse.rs:113-117,264-266`) |
| Canonical schema w/ **mandatory `summary`** | ❌ **Absent** | No schema enforcement; no `summary` concept; no lint |
| `manifest()` | ❌ **Absent** | No manifest tool/query |
| Local embeddings | ✅ Built — **fastembed/ONNX, NOT Ollama** | all-MiniLM-L6-v2, 384-dim, offline after ~90MB fetch (`embed.rs:6,12`); **Ollama referenced nowhere** (grep: no matches) |
| Vector store | ✅ BLOB + brute-force cosine KNN — **NOT sqlite-vec** | f32 LE BLOBs (`embed.rs:31-44`), `knn.rs`; sqlite-vec deferred per ADR-20260618 |
| Semantic search | ✅ Built (Tauri only) | `semantic_search` + `related_notes` commands (`commands.rs:347-430`) — **not exposed over MCP** |
| Hybrid retrieval (FTS+vector, fused) | ❌ Absent | FTS and vector are separate; no fusion |
| Incremental reindex | ⚠️ Notes yes, **embeddings no** | Watcher updates notes/FTS incrementally; embeddings only via full `recompute_clusters` (`queries.rs:392-394`) |
| MCP server (stdio) | ✅ Built | `rose-glass-mcp` bin, JSON-RPC 2.0, MCP 2025-06-18, read-only (`bin/mcp.rs`) |
| MCP `search` | ⚠️ Partial | FTS only, no `k`/filters, not hybrid (`mcp.rs:106-112`) |
| MCP `get_note` | ❌ Absent from MCP | Exists as internal query (`queries.rs:229-286`), not dispatched |
| MCP `related` | ❌ Absent from MCP | KNN exists internally, not exposed |
| MCP `upsert_note` | ❌ Absent + impossible today | MCP opens DB **READ_ONLY**, no write tool (`mcp.rs:31-34`) |
| Session-end upkeep ("TD hook") | ❌ Absent | No maintenance pass; activity hooks are a separate read-only mirror |

**Render coupling is safe.** The graph reads only `get_graph_payload` → `fromPayload.ts` (one
transform); both renderers consume in-memory `GraphData` and never touch the DB. Schema changes
to `clusters`/`embeddings` cannot break the graph (`fromPayload.ts:7-41`, `GraphRenderer.ts:243`).

---

## 3. Issue 1 — clusters: TWO distinct root causes (k-means itself is correct)

`cluster.rs` k-means + `store_clusters` are correct and unit-tested. The bug is pure **wiring**.

### 3a. "0 clusters" in the status bar — a hardcoded literal
- `refreshGraph` sets `clusters: 0` **unconditionally** — the only updater of the count.
  → `Shell.tsx:350` `setCounts({ notes: …, links: …, clusters: 0 })`
- No `get_clusters`/`get_stats` Tauri command exists. `get_clusters` is in Rust but exposed
  **only to the MCP bin + a unit test**, not in `lib.rs` `invoke_handler`. The webview literally
  cannot read the cluster count. (`queries.rs:347`, `lib.rs:73-102`)
- `recompute_clusters` *returns* the count, but `onCluster` **discards it** (`Shell.tsx:288`),
  and the subsequent `index:rebuilt` → `refreshGraph` re-stamps `0` (`Shell.tsx:689,350`).
- **Smoking gun:** `Shell.tsx:350`. The count can never be non-zero regardless of clustering.

### 3b. Never auto-organizes — clustering is on-demand only
- `recompute_clusters` (`commands.rs:279-318`) is invoked **only** by the "Clusters" button
  (`GraphPane.tsx:293` → `onCluster` → `Shell.tsx:288`).
- Nothing in `open_vault`, `reindex`, or the boot path calls it. The `clusters` table stays empty
  until the user clicks the button, so every node loads with `cluster=NULL`.

### 3c. (Secondary, not the cause) model-download gating
- `recompute_clusters` loads the ~90MB ONNX model; a failure is **surfaced** (`clusterError` +
  Retry, `GraphPane.tsx:299-304`), not silently swallowed. Empty corpus early-returns `Ok(0)`.

### Minimal fix
- **(A) count (unambiguous, ~5 lines):** add `cluster_count` = `COUNT(DISTINCT cluster_id)` to
  `get_graph_payload`/`GraphPayload` (the query already LEFT JOINs `clusters`); use it at
  `Shell.tsx:350`. Drop the misleading `MOCK_COUNTS.clusters: 4` seed (`Shell.tsx:91`).
- **(B) auto-organize (product fork — see §6):** call `recompute_clusters` after `open_vault`'s
  rebuild, **gated on the model already being present** + async/deferred so it never blocks boot
  or forces a download on first open. Or keep it button-driven and rely on fix (A) to make the
  button's effect visible.

---

## 4. Conflicts with the spec (surfaced with evidence)

1. **Ollama (spec) vs fastembed (built).** Spec: "local embeddings via Ollama (use the 5090)."
   Reality: fastembed/ONNX all-MiniLM, fully local, offline after one fetch — Ollama appears
   nowhere. The spec's *intent* (local-only, on-box, no network in the retrieval path) is already
   met. Adding Ollama = a redundant second backend + a new runtime dependency (daemon must be up,
   GPU not guaranteed). **Recommendation: keep fastembed.** This is a genuine user preference →
   §6 Q1.
2. **sqlite-vec (spec) vs brute-force KNN (built).** ADR-20260618 deferred sqlite-vec
   deliberately. For local vault scale, linear KNN is correct and simple. **Recommendation: keep
   KNN; revisit only if the corpus grows past ~10k notes** (a perf optimization, not correctness).
3. **"Technical Director hook" (Phase 4).** The global second-brain's auto-TD was *removed* per
   ADR-20260615 as duplicative of MEMORY.md + git. **Recommendation: frame Phase 4 as a plain
   session-end maintenance command** (reindex embeddings, frontmatter-lint, surface orphans/stale,
   roll up `inbox/`), not a resurrected daemon.
4. **Carpathia.** No special integration exists or is needed — RG fronts any vault directory you
   open. "Index Carpathia" = "open the Carpathia folder as the vault." The write path targets
   markdown-on-disk regardless of which vault.

---

## 5. Reduced scope (what actually remains to build)

The spec's 5 phases collapse to a much smaller surface because storage, FTS5, local embeddings,
KNN, and the MCP server already ship.

- **P1 Triage:** add `summary` to the frontmatter schema + a frontmatter-lint (flag missing
  `summary`); build `manifest()` (query over `notes` + summary/tags/status) and expose it as an
  MCP tool. *(FTS5 already done.)*
- **P2 Discovery:** mostly **done**. Gaps: make embeddings **incremental** (hook the watcher so
  changed notes re-embed, not just full `recompute_clusters`); add **hybrid** FTS+vector fusion.
  *Decision pending: keep fastembed + KNN (recommended) vs adopt Ollama/sqlite-vec (§6).*
- **P3 Agent interface:** expose `get_note` + `related` + `manifest` over MCP (internal fns
  exist — thin dispatch); add `k`/filters + hybrid to MCP `search`; build **`upsert_note`** as the
  write path (validate schema → write `.md` into `inbox/` → watcher derives the row). Also: a
  launch story so the MCP bin's `--vault` tracks the app's open vault (currently manual).
- **P4 Upkeep:** session-end maintenance pass (incremental embed reindex, frontmatter-lint,
  orphan/stale report, capture rollup) — idempotent, no full rebuild.
- **Issue 1:** independent ~10-line wiring fix (§3); can land now, ahead of the plan.

---

## 6. Open forks for the user (code can't decide these)

1. **Embedding backend** — keep fastembed/ONNX (recommended: built, tested, offline, zero new
   deps) **vs** switch to Ollama per the literal spec (uses the 5090, but adds a daemon dependency
   and a second backend).
2. **Auto-clustering on load** — auto-organize on vault open, gated-on-model-present + async
   (matches "should organize on load," costs an embed pass) **vs** keep button-driven but fix the
   count so the button's effect is visible (cheapest, no boot cost).
3. **Issue 1 timing** — land the count-fix now as its own commit **vs** fold it into the Issue-2
   plan.

Once these are answered, the next step is `/council` on the resolved design (the `upsert_note`
write-path + hybrid retrieval are the load-bearing decisions), then a written phase plan.
