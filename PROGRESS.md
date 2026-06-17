# Rose Glass — Progress & Resume
#Test
Local-first PKM + live Claude Code activity mirror (Tauri 2 + React 19 + TS-strict).
**Repo:** `C:\Users\dnoye\rose-glass` · **private remote** `Vividness9816/rose-glass` · branch `master`.

**Authoritative docs (read these to resume):**
- `STATUS.md` — §20 acceptance ledger (proven / partial / untouched; each `proven` row cites a commit + artifact)
- `ROADMAP.md` — phase plan; commit scopes are `feat(phaseN-...)` so `git log --grep=phaseN` is the resumption index
- `docs/build-instructions.md` — operative spec · `docs/decisions.md` — run decisions
- `docs/design-reference.html` — the **visual contract** (match it, don't approximate)
- ADR: `~/.claude/second-brain/decisions/ADR-20260616-rose-glass-execution-strategy.md` (foundation-first; no fake "verified")

## Done — built · reviewed · verified · pushed
- **Council → ADR** (foundation-first staged execution; the spec's literal 1-shot is unverifiable in one session).
- **Phase 0** — pnpm workspace + Tauri 2 boots + `tokens.css` verbatim from the mockup + live dark/light theme + self-hosted Inter/JetBrains Mono.
- **Phase 1** — shell 1:1 from mockup (titlebar + traffic-light controls / 52px rail / split / statusbar).
- **canvas-2D living graph** (de-hardcoded, token-driven, on mock data) — the §20 2D-fallback leg.
- **Phase 2** — vault indexer + SQLite/FTS5 derived store + `notify` watcher + IPC (open_vault/get_note/get_backlinks/search/get_tags/get_graph_payload/reindex). **A3 delete-DB→rebuild equivalence PROVEN.**
- **Phase 3** — CodeMirror 6 editor: live wikilink/tag/inline-code decorations, path-safe read/save (atomic + strict-UTF-8 + EOL-preserving), backlinks, open-note + nav, debounced autosave + anti-clobber.
- **Phase 5** — ⌘K command palette over FTS search (debounced, keyboard nav, focus-restore).
- **Phase 6** — living rose/violet backdrop (hand-written GLSL on **r3f v9** — `@shadergradient/react` proved dead on React 19, spike-caught) + **eamonliu** liquid-glass lens (toggleable; `dashersw` is html2canvas-incompatible with WebGL) + native `backdrop-filter` chrome + **tuned light theme**. Four §17 WebGL guards (reduced-motion / WebGL2 probe / Suspense / error boundary). **Visual taste pending user eyeball.**
- **HiDPI graph fix** — canvas-2D graph now renders its backing store at `devicePixelRatio` (crisp text on 4K; was CSS-px/fuzzy) — verified at dpr 1.5 (`phase4-graph`).
- **Phase 7** — embedded terminal: glass drawer (Ctrl+\`, off by default) hosting a real shell at cwd=vault via portable-pty/ConPTY + xterm.js; runs Claude Code + arbitrary commands (A7). 3-lens review applied (per-session writer lock so a hung child stays killable, reader-thread session eviction, StrictMode listener-leak/write-after-dispose). PTY spike made self-bounding (ConPTY no-EOF). **End-to-end user-confirmed live (claude + dir).**
- **Phase 10** — read-only MCP sidecar (`rose-glass-mcp`): JSON-RPC 2.0 (MCP 2025-06-18) over stdio exposing `search` + `get_semantic_clusters` over the vault index.db (read-only; reuses desktop_lib::db). 3-lens review applied (busy_timeout for WAL contention, -32600 on malformed request, notification handling). **Proven e2e via real stdio handshake** + 9 dispatch tests. An external MCP client configures it; app-bundling deferred.
- **Phase 11** — local neural embeddings (all-MiniLM via fastembed/ONNX, offline after model fetch) + deterministic k-means → `clusters` table. Lights up the graph cluster-colouring + MCP `get_semantic_clusters` (no frontend rework); triggered by the graph-header Clusters button → `recompute_clusters` (lock-split read/embed/store). **Proven semantically** (real-model #[ignore]d test: cooking vs astrophysics separate) + spike (ONNX-on-Windows). 3-lens review applied (FK-skip on mid-recompute delete, borrow texts). sqlite-vec deferred.
- Each phase closed with a **3-lens adversarial review** + fixes + regression tests.

**Latest gates (all green):** `cargo test` 26/26 + `clippy` 0 · `tsc` 0 · `vitest` 27/27 · `vite build` 0 · Playwright renders + live WebGL/terminal end-to-end (0 console errors). Proof shots in `docs/proof/`.

## Next — these need the user in the loop (why the autonomous run paused here)
- **Phase 4 — WebGPU graph** (4K render + d3-force + drag/zoom/pan/click-open + 2D fallback): the marquee feature; final parity needs a **live-GPU eyeball** on the RTX 5090 (the predecessor's "verified-but-not" trap lives here). Opens with the required spike (React19×design-libs + WebGPU probe + fallback).
- **Phase 6 — DONE** (glass / living backdrop / light-theme tuning), pending only your visual-acceptance eyeball + a formal Impeccable/Taste run (A11). Dials are single named constants: backdrop `opacity` (ShaderBackdrop.tsx, 0.8), `GRAPH_BG_ALPHA` (GraphRenderer.ts, 0.4).
- **Phases 7 + 10 + 11 — DONE** (terminal, MCP sidecar, neural clusters). Remaining: **Phase 9 — MuPDF/docx editors** (heaviest; opens with a spike; needs the app window) · **Phase 4 — WebGPU graph** (needs the 5090 eyeball) · **Phase 8 — activity bus** (BINDING safety carve-out; needs explicit consent) · **Phase 12 — v1.0 gate**.
- **Phase 8 — activity bus**: ⚠ **BINDING SAFETY CARVE-OUT (ADR)** — the global CC-hook install (`~/.claude/settings.json`) + `~/.claude/projects/**/*.jsonl` transcript-tail need **explicit user consent** + atomic backup/validate + `127.0.0.1`-only + secret redaction + uninstall. Do not touch settings.json autonomously.

## Resume / verify
Run the app **from inside the repo** (never from `C:\Users\dnoye` — pnpm junction-dupes the
project there → 4× concurrent `tauri dev` colliding on the strict :1420 port):
```
cd C:\Users\dnoye\rose-glass\apps\desktop
pnpm tauri dev     # open a folder of .md → indexer/editor/search live · Ctrl+` terminal · ◎ Lens · Clusters button
```
Gates (from `C:\Users\dnoye\rose-glass`):
```
pnpm --filter @rose-glass/desktop exec tsc --noEmit                               # 0
pnpm --filter @rose-glass/desktop test                                            # vitest 27/27
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml                      # 41/41
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml -- --ignored         # +2 ONNX tests (need the cached all-MiniLM model)
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings   # 0
```

### Resume gotchas (this session)
- **Two cargo bins**: `desktop` (app) + `rose-glass-mcp` (sidecar). `default-run=desktop` keeps `tauri dev` working; run the sidecar via `cargo run --bin rose-glass-mcp -- --vault <dir>`.
- **Phase 11 model**: the first **Clusters** click downloads all-MiniLM (~90MB) to the app cache, then offline. The two `#[ignore]d` ONNX tests reuse a cached model under `%TEMP%\rg-fastembed-cache`.
- **cargo target lock**: while `tauri dev` runs (or a stale test binary lives), a separate `cargo test` can hit `LNK1104` on a held binary. Kill stale `cargo`/`rustc` first, or verify in a separate `CARGO_TARGET_DIR` (cold but contention-free).
- **shadergradient is dead on React 19** (bundles r3f v8); the backdrop is hand-written GLSL on `@react-three/fiber@9`. **dashersw glass** can't sample WebGL (html2canvas) → using **eamonliu** liquid-glass. (See [[reference_design_libs_toolkit]].)

## Working pattern (what's been succeeding)
design-workflow (big/version-sensitive phases) → inline verified implementation → 3-lens adversarial-review workflow → fix confirmed findings (+ regression tests) → phase-scoped commit + push → update `STATUS.md`+`ROADMAP.md`. Ponytail throughout; commit only verified work; `# self-audit-ok` appended to commit commands (self-audit PreToolUse hook). cargo runs need `--manifest-path apps/desktop/src-tauri/Cargo.toml` (Bash cwd drifts).
