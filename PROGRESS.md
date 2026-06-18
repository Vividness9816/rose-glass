# Rose Glass — Progress & Resume

Local-first PKM + live Claude Code activity mirror (Tauri 2 + React 19 + TS-strict).
**Repo:** `C:\Users\dnoye\rose-glass` · **private remote** `Vividness9816/rose-glass` · branch `master`.

**Authoritative docs (read these to resume):**
- `STATUS.md` — §20 acceptance ledger (proven / partial / untouched; each `proven` row cites a commit + artifact)
- `ROADMAP.md` — phase plan; commit scopes are `feat(phaseN-...)` so `git log --grep=phaseN` is the resumption index
- `docs/build-instructions.md` — operative spec · `docs/decisions.md` — run decisions
- `docs/design-reference.html` — the **visual contract** (match it, don't approximate)
- ADR: `~/.claude/second-brain/decisions/ADR-20260616-rose-glass-execution-strategy.md` (foundation-first; no fake "verified")

## Post-eyeball polish round (2026-06-17) — from live user feedback
After the user live-verified Phases 4/8/9 + the backdrop, a feedback-driven polish/feature
pass shipped (all gated green per commit; `/impeccable` methodology for the visual items):
- `32b5c50` graph idle-drift (continuous breathe) · theme node bullseye inversion (`--graph-node-invert`) · removed the liquid-glass lens + dep · window-control glyphs (×−+ hover) · Search-rail→⌘K
- `c13fe1a` **fix**: watcher trusts file-existence over event-kind → atomic-save rename no longer read as delete (the "docx sibling closes mid-edit" bug; latent for all autosaves)
- `235e3a4` Focus → local-graph scope (dim all but the open note + its links; renderer `setFocus`)
- `d40ed5e` session persistence (resume vault+note+view; theme via initTheme)
- `dfb3754` terminal keep-alive on hide + tabs (+/×)
- `96ed013` built the six dead buttons: Notes/Tags/Settings panes + Outline/Properties(frontmatter)/Share(copy-md); CommandPalette `initialQuery`; CodeMirrorHost exposes its EditorView
- `b5dcc4e` titlebar + New note (create+open) + ↗ Share (reveal vault folder)
- `e829835` **M2 arming**: `installer.rs` arm/disarm (re-validate → backup → atomic write) + Settings Arm/Disarm/Dry-run; live arm = the user's in-app confirm
**Remaining:** GPU shader parity (auras/particles/curves/rings in WGSL — user-deprioritized last); the live app-window eyeball of the above + the in-app M2 arm.

## Round-2 live feedback (2026-06-17 PM) — DONE (gates green; live behavior = user eyeball)
User re-verified in-app. All round-2 items addressed (tsc 0 · vitest 67/67 · cargo 53/53 +9 mcp ·
clippy 0; the GPU item + a pre-commit self-audit reviewed). Tauri-only behaviors (window/clipboard/
terminal/properties live render) are code-complete + compile-verified — the live confirm is the app eyeball.
- ✅ **GPU shader parity DONE** (Ph4, 2026-06-17, commit `7fd4ae9`): the WGSL grown to the full 2D
  look via 3 instanced pipelines (sprite/ring/ribbon) — cluster auras/glow, curved edges + arrowheads +
  trails, tributary particles, hub rings + orbiting dots — and the **Focus dimming** + **theme bullseye
  inversion** ports. Riskiest-premise spike first (`ribbon.ts`, 8/8). 3-lens reviewed (7 LOW, all fixed).
  GPU-verified dark+light on the RTX 5090 (`docs/proof/phase4-parity-*.png`). Only hub text labels stay 2D.
- ✅ **Focus doesn't dim** — root cause was the **GPU no-op path** (`setFocus` was a no-op on the GPU
  renderer; the user had GPU toggled on). Ported to GPU (commit `7fd4ae9`). The 2D path is correct —
  verified by tracing: `indexer/pipeline.rs` normalizes all DB paths to `/`, so `note.path` (get_note) ≡
  graph `node.path` (get_graph_payload); `lookupNodeByRel` also has a case-folded fallback.
- ✅ **Palette result click doesn't open** — `CommandPalette.onOpenNote` now `setRailView('graph')` before
  `openNote` (Shell.tsx), so a result picked from a non-graph rail (tag-click/notes/settings/activity) no
  longer opens the note behind the current pane. Matches the onOpenNode / NotesPane.onOpen pattern.
- ✅ **Share doesn't copy** — `@tauri-apps/plugin-clipboard-manager` `writeText` in the Tauri webview
  (navigator.clipboard fallback on web); added the npm + Rust crate + `clipboard-manager:allow-write-text`.
- ✅ **Window controls + fullscreen** — traffic-light ×−+ glyphs now visible at rest (were hover-only
  opacity 0); added a ⛶ **fullscreen** toggle (`setFullscreen(!isFullscreen())`) + `core:window:allow-set-
  fullscreen`/`is-fullscreen`. (minimize/close/toggle-maximize were already permitted — they work.)
- ✅ **Terminal tabs** — double-click a tab name to rename (Esc cancels, Enter/blur commits); a pulsing
  green attention dot on a background tab whose PTY rings the bell (xterm `onBell` → `markTermAttention`,
  cleared on select). ponytail: bell is the one concrete signal; a fuller prompt-parse heuristic is deferred.
- ✅ **Properties disk size** — new `file_size` IPC (vault-relative `safe_join` + `is_file`, same guard as
  read_file_bytes) → a "size" row in the Properties popover.
- ✅ **M2 hook** — DECISION: **view-only / deferred** (M1 transcript-tail is the active, verified mechanism;
  a global per-tool-use hook + M1↔M2 dedup is disproportionate for the latency gain — ADR-20260617's
  original reasoning). Fixed the harm: the planned hook command was a broken `node "$ROSE_GLASS_ACTIVITY_HOOK"`
  that ERRORED on each tool-use → now a harmless self-contained **no-op** (`node -e 0`, always exit 0). Settings
  UI relabeled honestly ("M2 deferred — no-op placeholder"). settings.json never written autonomously; arm/
  disarm stays the user's click (the proven backup/validate/atomic install path is unchanged). **If you armed
  the old placeholder, Disarm it** (it has no active consumer; M1 delivers).

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
- **Phase 9 (engines)** — **lossless-writes-only** editor engines (`/council` → **ADR-20260617**; scope revised away from "true PDF edit / docx round-trip" because a binary writer is the same silent-corruption class the codebase already forbids). Commit `40d756f`, 3-lens-reviewed (14/14 fixed). **PDF = read-only PDF.js** (pdfjs-dist v6; worker bundled locally, `enableXfa`/`useWasm` off; v6 dropped `isEvalSupported`). **docx = read-only mammoth→HTML** (DOMPurify: remote-img beacons stripped, links→OS browser) **+ "Edit as Markdown"** → sibling `<name>.docx.md` via the existing atomic save (the `.docx` is never mutated; re-extract opens the existing sibling, never clobbers edits). `read_file_bytes` IPC (vault-relative `safe_join` + `is_file` + bounded read, raw ArrayBuffer, no DB-lock). Open-file dialog routes by `editorKind`; viewers lazy-split. **NO** MuPDF/TipTap/pdf-lib/docx-writer; **NO** binary FTS indexing (deferred); **NO** new OS association. Gates green (tsc/vitest 56/cargo 52/clippy/build). **Live in-app render = your app-window eyeball** (needs Tauri IPC, not headless-verifiable — not faked).
- **Phase 4 (interaction + WebGPU)** — graph gains wheel-zoom-to-cursor / drag-pan / drag-node / click-to-open, built renderer-agnostic on shared pure `camera`/`hitTest`/seedable `stepSimulation` (vitest 9 + GraphRenderer node-lookup). **WebGPU primary renderer BUILT** (`WebGpuGraphRenderer`, instanced discs + edge lines, `@webgpu/types`-validated) behind a `probeWebGpu()` + GPU/2D toggle with an **airtight fallback** (create()→null on any failure + per-backend canvas `key` remount + device-loss recovery → canvas-2D; a GPU failure can never blank the graph). 3-lens review: 10 findings, all fixed (incl. the HIGH fallback-blank bug). **WebGPU render + zoom GPU-VERIFIED 2026-06-17** on the RTX 5090 (adapter `nvidia/blackwell`, via headed Edge = the app's WebView2 engine): toggle stays "GPU" (shaders/pipelines validated, no fallback), graph renders, zoom works, 0 errors — `docs/proof/phase4-webgpu-{render,zoom}.png` via `phase4-webgpu-verify.cjs`. Residual (optional user confirm): drag/pan/click feel + literal-4K + GPU-visual-parity. d3-force decision recorded (decisions.md #9/#10).
- **Phase 8 (M1)** — CC activity mirror via **transcript-tail** (read-only `~/.claude/projects/**/*.jsonl`; M2 global hook **deferred**, plan-only, per **ADR-20260617**). Council-decided (5 seats, unanimous): the live `settings.json` write is the one unrecoverable-if-botched unattended action → kept for an attended morning step. **Structural redaction at the Rust source** (the `External` event variant has no path field → an out-of-vault path never crosses IPC); in-vault classification fails CLOSED on `..` escape, case-folded on Windows. Node light-up (read=violet pulse / modify=rose flare, tokenised), muted path-free external rows, a **health row** (liveness/tally/dropped/drift). Bounded drop-oldest ring + partial-line buffering + rotation resync + generation-gated start↔stop. The M2 installer is **plan/validate/uninstall with NO `fs::write`**, proven against the live settings.json read-only (20 hooks preserved + round-trips). 3-lens review: 7 findings, all fixed + regressions. **Live-eyeball on a sanitized vault = morning.**
- Each phase closed with a **3-lens adversarial review** + fixes + regression tests.

**Latest gates (all green):** `cargo test` 53/53 (+3 `#[ignore]`d on demand) + `clippy` 0 · `tsc` 0 · `vitest` **67/67** (+8 ribbon-tessellation) · `vite build` 0 · A2 visual 4/4 · Playwright renders + live WebGL/terminal end-to-end + **GPU parity GPU-verified on the RTX 5090** (0 console errors bar a cosmetic favicon 404). Proof shots in `docs/proof/`.

## Next — these need the user in the loop (morning verification)
This overnight run (2026-06-17): user gave durable consent for the whole plan + Phase-8 order (8 → 4 → 9), "build as much as possible without me, leave the must-verify parts for the morning."
- **Phase 8 — DONE (M1)**, pending your **live-eyeball on a SANITIZED vault**: run the app, open the Activity pane (◎ rail), confirm real CC sessions stream + in-vault nodes flare (read=violet/modify=rose). The M2 global hook is **plan-only / not armed** — arming it (`installer.rs` is fixture+live-proven, no `fs::write` exists yet) is a separate attended OK. See ADR-20260617.
- **Phase 4 — GPU-VERIFIED (2026-06-17)**: interaction + airtight fallback built + 3-lens reviewed; **the WebGPU render + zoom were verified on the RTX 5090** (adapter nvidia/blackwell via headed Edge = the app's WebView2 engine; toggle stayed "GPU" so shaders/pipelines validated; graph rendered; zoom worked; 0 errors — `docs/proof/phase4-webgpu-*.png`). Optional 30-sec confirm: drag/pan/click feel in the app + whether the leaner GPU visual is acceptable (else I grow the shaders to mockup parity).
- **Phase 6 — DONE**, pending visual-acceptance eyeball + formal Impeccable/Taste (A11). Dials: backdrop `opacity` (ShaderBackdrop.tsx, 0.8), `GRAPH_BG_ALPHA` (GraphRenderer.ts, 0.4).
- **Phase 9 — ENGINES DONE** (lossless-only: PDF view-only + docx view/edit-as-sibling-md + binary-read IPC; commit `40d756f`, 3-lens-reviewed, gates green). Scope revised by ADR-20260617 (no true-PDF-edit / no docx round-trip / no binary indexing — a binary writer violates the no-silent-corruption invariant). **Pending your app-window eyeball: the LIVE PDF/docx render** (open a vault → "Open file…" a pdf/docx; needs Tauri IPC so not headless-verifiable). Optional follow-on: formal `/impeccable` polish of the viewer chrome once the render is confirmed.
- **Phases 6 + 7 + 9 + 10 + 11 — DONE** (backdrop/glass, terminal, editor engines, MCP sidecar, neural clusters). Remaining to v1.0: the eyeballs (8 activity / 4 GPU-feel / 6 taste / **9 live editor render**), **Phase 12 — full §20 v1.0 acceptance gate**.

## Resume / verify
Run the app **from inside the repo** (never from `C:\Users\dnoye` — pnpm junction-dupes the
project there → 4× concurrent `tauri dev` colliding on the strict :1420 port):
```
cd C:\Users\dnoye\rose-glass\apps\desktop
pnpm tauri dev     # open a folder of .md → indexer/editor/search live · Ctrl+` terminal · ◎ Lens · Clusters button · ◎ Activity (Phase 8)
```
Gates (from `C:\Users\dnoye\rose-glass`):
```
pnpm --filter @rose-glass/desktop exec tsc --noEmit                               # 0
pnpm --filter @rose-glass/desktop test                                            # vitest 50/50
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml                      # 52/52
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml -- --ignored         # +3: 2 ONNX (cached all-MiniLM) + live-settings installer proof (20 hooks preserved)
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings   # 0
```

### Resume gotchas (this session)
- **Two cargo bins**: `desktop` (app) + `rose-glass-mcp` (sidecar). `default-run=desktop` keeps `tauri dev` working; run the sidecar via `cargo run --bin rose-glass-mcp -- --vault <dir>`.
- **Phase 11 model**: the first **Clusters** click downloads all-MiniLM (~90MB) to the app cache, then offline. The two `#[ignore]d` ONNX tests reuse a cached model under `%TEMP%\rg-fastembed-cache`.
- **cargo target lock**: while `tauri dev` runs (or a stale test binary lives), a separate `cargo test` can hit `LNK1104` on a held binary. Kill stale `cargo`/`rustc` first, or verify in a separate `CARGO_TARGET_DIR` (cold but contention-free).
- **shadergradient is dead on React 19** (bundles r3f v8); the backdrop is hand-written GLSL on `@react-three/fiber@9`. **dashersw glass** can't sample WebGL (html2canvas) → using **eamonliu** liquid-glass. (See [[reference_design_libs_toolkit]].)

## Working pattern (what's been succeeding)
design-workflow (big/version-sensitive phases) → inline verified implementation → 3-lens adversarial-review workflow → fix confirmed findings (+ regression tests) → phase-scoped commit + push → update `STATUS.md`+`ROADMAP.md`. Ponytail throughout; commit only verified work; `# self-audit-ok` appended to commit commands (self-audit PreToolUse hook). cargo runs need `--manifest-path apps/desktop/src-tauri/Cargo.toml` (Bash cwd drifts).
