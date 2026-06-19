# Rose Glass v2.0 — Design Spec

**Date:** 2026-06-18
**Status:** Approved (brainstorming gate passed). Build against this + the v2.0 founding ADR.
**Branch:** `feat/v2.0`

> **BINDING OVERRIDE:** `~/.claude/second-brain/decisions/ADR-20260618-rose-glass-v2-architecture.md`
> revises items 2a/2b/2c, 5/6, and the CSP/symlink details below to preserve the A3 invariant
> and remove three data-integrity hazards. Where the ADR and this spec differ, **the ADR wins.**
> Key deltas: 2c column already exists (DELETE stale rows, no startup re-embed); 2a caches the
> model in AppState (no cache-dir wipe); watcher uses coalesce-at-enqueue (not sync_channel);
> one shared `should_skip` across all 3 write paths; CSP starts wider then tightens.

## Goal

Seven changes to the shipped v1.0 PKM: drag-drop ingest, an embed/scale/durability fix
cluster, a customizable graph panel, three security fixes, real home-dir indexing, and a
signed double-click `.exe`. Each item is an atomic commit with one runnable check.

## Corrections to the originating brief (verified against code)

- **embed.rs:64 `.expect`** is in an `#[ignore]`d spike *test*, not production. The real
  path (`new_model`) already returns `Result`. No panic — but the resilience gap (no
  timeout/retry, partial-download cache needing manual clear) is real. Fix stands.
- **Scale:** `knn.rs` is **O(n·d) linear**, not O(n²). The real O(n²) is the frontend
  physics collision loop in `simulation.ts`. Both addressed; different files.
- **`ignore` swap:** `walkdir` is only in `indexer/pipeline.rs`. `watcher.rs` uses
  `notify-debouncer-full` (no walkdir) → it needs an *added skip filter*, not a crate swap.
- **.exe/no-console:** `main.rs:2` already sets `windows_subsystem="windows"` and NSIS/MSI
  are already targeted. Item is **build + code-sign**, not a code fix.

## Items

### 1. Drag-and-drop ingest (new feature)

- **Frontend:** Tauri v2 native `onDragDropEvent` (real absolute paths; HTML5 DnD can't in a
  webview). On drop → IPC `ingest_dropped_file(abs_path)`.
- **Backend `ingest_dropped_file`:** reject ext ∉ `{md, markdown, txt, pdf, docx}` (toast).
  Outside vault → copy to `<vault>/inbox/<name>` (dedupe `name (1).md`) via **fs_safe**;
  inside → use in place. `md/txt` → `pipeline::incremental` (creates orphan note) + emit
  refresh; `pdf/docx` → open in viewer only. Return `{ rel, kind }` so the right pane opens
  it (CodeMirror for md/txt, PdfView/DocxView for binaries).
- **Graph:** orphan node appears via existing `get_graph_payload` LEFT JOIN (no graph code
  change). Ensure the canvas refetches payload on `index:note` (may only listen to
  `index:rebuilt` today).
- **Check:** unit test the path-decision (inside/outside vault, ext filter, name dedupe).

### 2. Embed cluster

**2a Resilience:** wrap `new_model` in a thread + `recv_timeout` (fastembed download has no
timeout). On timeout/error → wipe the partial model cache dir → return structured error.
Cache a failed-state flag in `AppState` so search shows a **Retry** affordance, not a silent
re-download per query. Check: unit test the timeout wrapper returns Err + clears cache.

**2b Telemetry (#2):** time each KNN search, log `elapsed_ms` + corpus size; measured against
the real ~2.3k home vault. sqlite-vec/HNSW only if it bites (ADR-20260618). If telemetry
shows model-load dominates, cache the model in `AppState` (deferred until measured).

**2c Model-version (#6):** add a `model` column to `embeddings`; on startup, stored ≠ current
`MODEL_NAME` → re-embed migration. Closes silent-corpus-shrink trapdoor. Check: migration
test (mismatch → stale/re-embed path taken).

### 3. Graph customization panel (routes through /impeccable)

- **One `GraphConfig`** `{ gravity, repulsion, drift, damping, clusterColors[4], mode }` fed
  into the shared `stepSimulation` → applies to both Canvas-2D and WebGPU (shared sim + CSS
  vars). gravity→cohesion, repulsion→collision strength+minDist, drift→idle motion,
  damping→settle rate. `free` = current live drift; `fixed` = drift 0 + heavy damping (nodes
  settle and hold; gravity/links still resolve layout once). Colors → 4 pickers write
  `--cluster-0..3` at runtime.
- **UI:** collapsed gear → expandable panel, top-right of the graph. Persist to localStorage.
  Visual treatment via `/impeccable`.
- **Check:** `stepSimulation` honors config (drift=0 → no idle move; repulsion=0 → overlap OK).

### 4. Security

- **CSP:** set `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:`. Then verify PDF/WebGPU/terminal/docx render; widen *minimally* if
  needed (anticipate `worker-src 'self' blob:`, `img-src ... blob:`). Tauri v2 auto-injects
  its IPC needs.
- **Threat model:** document the terminal as intentional RCE + arbitrary cwd→PTY
  (`terminal.rs:48`), by design. No code change.
- **Symlink (#4c, LOW):** canonicalize vault root once at open-time, store canonical PathBuf,
  classify against it. Residual (symlink inside vault pointing out, per-event FS resolve)
  documented not closed — display-only, fs_safe guards real ops, canonicalizing each reported
  path breaks delete events. Check: classify test against a canonical root.

### 5. Home-dir handling — `ignore` crate (heavyweight)

- `indexer/pipeline.rs`: `walkdir::WalkDir` → `ignore::WalkBuilder` (respects `.gitignore`,
  `follow_links(false)`, hardcoded skip: `node_modules, target, dist, build, vendor, .git,
  .rose-glass, .obsidian, .cache, .venv`). Remove `walkdir` dep.
- `watcher.rs`: shared `should_skip(path)` in the debounce callback (hardcoded segment skip;
  the watcher only processes markdown). Full `.gitignore` awareness on rebuild, hardcoded skip
  on hot path — documented asymmetry.
- **Result:** ~2,319 notes (was 17,048). Makes opening `~` as vault practical.
- **Check:** `should_skip` unit test (node_modules skipped, real note kept).

### 6. Watcher bounded + coalesce (#5)

Unbounded `mpsc` → `sync_channel(1024)` + per-path coalesce on drain. Debouncer + skip-filter
already tame churn; this is the belt. Check: coalesce dedupes repeated ops for one path.

### 7. Signed `.exe`, no console

Add `bundle.windows.certificateThumbprint = "FF91E3867E3DE0BF3AAC34AF0E752D7CC54D2B11"` →
`pnpm tauri build` → signed NSIS installer → Start Menu app, double-click, no terminal.
"Verified publisher: Dylan N" on machines that trust the cert.

## Sequencing

1. #5 ignore/home-dir (foundation) → 2. security (CSP, symlink, threat doc) → 3. embed
cluster → 4. PTY ring buffer + watcher bound → 5. drag-drop → 6. graph panel (/impeccable)
→ 7. build + sign.

Atomic commit per item; one runnable check per non-trivial item.

## Defaults (vetoable)

Panel config → localStorage; `fixed` = drift-off + heavy damping; symlink residual documented
not closed; model-load caching deferred until telemetry says so.

## Items needing user verification (flag, don't block)

- Graph panel visual taste (impeccable produces it; user eyeballs).
- CSP didn't break a render path (I verify what I can headlessly; user confirms PDF/terminal).
- Cert trust + the actual `pnpm tauri build` if it's too long/heavy for the session.
