# Rose Glass — Roadmap (the autonomous spine)

Phases map 1:1 to spec §15. **Commit scopes use the phase id** (`feat(phase4-graph): …`)
so `git log --grep=phase4` is the resumption index (ADR-20260616). Each phase opens
with a riskiest-premise spike on a tiny scope before its build.

| Phase | Id | Deliverable | Status |
|---|---|---|---|
| 0 | `phase0-scaffold` | Monorepo + Tauri boots + `tokens.css` verbatim + theme toggle + self-hosted fonts | ✅ done (this session) |
| 1 | `phase1-shell` | Titlebar / 52px rail / split / statusbar 1:1 from mockup | ✅ done (this session) |
| 4(2D) | `phase4-graph` | Canvas-2D living graph ported, de-hardcoded, on mock data (the §20 2D-fallback leg) | ✅ done (this session) |
| 2 | `phase2-indexer` | Vault open + watcher + indexer + SQLite schema (§8); incremental + full-rebuild | ✅ done (A3 proven; review pass pending) |
| 3 | `phase3-editor` | CodeMirror 6 editor pane (mockup parity), save path, live links/backlinks | ✅ done (reviewed) |
| 4 | `phase4-webgpu` | WebGPU renderer at fixed 4K + drag node/cluster + zoom/pan + click-open; **spike: React19×design-libs + WebGPU 4K probe + fallback** | ✅ interaction + airtight fallback + **GPU-visual parity** DONE (3-lens reviewed twice). WebGPU render + zoom GPU-VERIFIED on the RTX 5090 (`nvidia/blackwell`). **GPU now matches the 2D look** — 4 instanced WGSL pipelines (sprite/ring/ribbon/label) reproduce node auras/glow, tributary particles, curved edges + arrowheads + trails, hub rings + orbiting dots, AND hub text labels (a lazily-built label-atlas texture); **Focus dimming + theme bullseye inversion ported** off the 2D-only path. **Full visual parity** (no remaining gap). Verified dark+light on the 5090 (`docs/proof/phase4-parity-*.png` via `phase4-parity-verify.cjs`; toggle stays GPU, 0 errors); both increments 3-lens reviewed. Residual: literal-4K res + the user feel/taste eyeball (`phase4-graph`, `phase4-webgpu`) |
| 5 | `phase5-search` | FTS5 search + ⌘K command palette (mockup glass) | ✅ done |
| 6 | `phase6-glass` | Theme-aware **r3f-v9** living backdrop (shadergradient dead on R19) + **eamonliu** liquid-glass lens (dashersw incompatible w/ WebGL) + backdrop-filter chrome; light-theme **tuned**; dual-theme diffs | ✅ done (visual taste pending user eyeball) |
| 7 | `phase7-terminal` | xterm.js + portable-pty; embedded shell at cwd=vault (runs Claude Code) | ✅ done (cargo 26/26, user-confirmed live) |
| 8 | `phase8-activity` | CC activity bus → node light-up + Activity pane (M1 transcript-tail; M2 global hook **deferred** per ADR-20260617) | 🟡 M1 done (built + 3-lens reviewed, cargo 52/52; live-eyeball + M2-arming = morning) |
| 9 | `phase9-formats` | Editor engines — **lossless-only (ADR-20260617, scope revised from "true PDF edit/TipTap+docx round-trip")**: PDF view-only (PDF.js) + docx view (mammoth) + edit-as-sibling-md + binary-read IPC; `.md/.txt/.pdf` association | 🟢 BUILT + 3-lens-reviewed (14/14 fixed), commit `40d756f`; gates green (tsc/vitest 56/vite + cargo 52/clippy). NO MuPDF/TipTap/pdf-lib/docx-writer, NO binary indexing (all dropped/deferred per ADR). **Remaining: LIVE in-app PDF/docx render = user app-window eyeball** (`phase9-formats`) |
| 10 | `phase10-mcp` | Read-only MCP sidecar (search + get_semantic_clusters) over stdio | ✅ done (cargo 35/35, e2e stdio proof) |
| 11 | `phase11-clusters` | Local neural embeddings (all-MiniLM/ONNX) + k-means → `clusters` table; graph cluster colouring + MCP clusters | ✅ done (cargo 41/41 + real-model semantic test) |
| 12 | `phase12-v1` | Full §20 acceptance gate | ✅ **PASSED → v1.0 (2026-06-18)** — all 11 §20 rows proven; the 6 live-window rows confirmed by the user's walkthrough. Tagged `v1.0` |
| 13 | `phase13-semantic` | Semantic search — brute-force cosine KNN over the stored embeddings (ADR-20260618; NOT sqlite-vec). Model-free "Related" list + free-text `semantic_search` IPC + freshness contract | ✅ done (post-v1.0 add; cargo 71 +real-model `#[ignore]d` proof, 3-lens reviewed). MCP tool + AppState model-cache deferred |

## Binding preconditions (from ADR-20260616)
- **Phase 8** ships the §11.4 global-hook install + `~/.claude/projects` transcript-tail ONLY behind: explicit user OK · atomic `settings.json` backup + temp-write/rename + re-parse-validate-all-entries · `127.0.0.1`-only endpoint · no transcript persistence · secret-path redaction/exclusion · working uninstall.
- **Phase 4 (WebGPU)** and **Phase 9 (PDF/docx engines)** open with a premise spike — never assume the hard pillar works; prove it on a tiny scope first. (Phase 9's spike proved pdf-lib *can* edit a PDF but mammoth is read-only → ADR-20260617 chose lossless view-only + edit-as-sibling-md over a lossy writer.)
- Every `proven` row in STATUS.md cites a commit scope + a re-runnable artifact. No prose "verified."

## Post-v1.0 (v2.x) — shipped
- **v2.0** (PR #1, merge `f62d741`; ADR-20260618-rose-glass-v2-architecture): drag-drop ingest,
  customizable graph panel, home-dir `ignore`-crate indexing, embed durability, real CSP +
  canonical vault root + threat model, PTY ring buffer + watcher coalesce, signed NSIS/MSI installer.
- **v2.1 + v2.2** (PR #2, merge `2470fb1`, 12 commits) — see STATUS.md "Post-v1.0 v2.x shipped".
  v2.1 (ADR-20260619): terminal clipboard shortcuts + PowerShell default, attention square,
  resizable panels. v2.2: graph solar-system center-hold, lazy TerminalPane, `React.memo(GraphPane)`,
  container queries, curated in-repo `<Icon>` set, single-instance file-open forwarding. Branding:
  rose-bouquet app icon. Gates green (tsc 0 · vitest 95/95 · cargo 75/75 · clippy clean · vite build 0).
- **v2.3** (PR #3, merge `4487364`, 26 commits; tagged `v2.3` @ `0.3.0`) — see STATUS.md "v2.3".
  Obsidian-feel graph (hover highlight + labels, removed Focus toggle, ghost nodes reverted, GPU
  persists), categorized settings menu (vim/spellcheck/auto-pair/smart-lists/HTML→MD paste), reading
  mode (markdown-it), multi-document **tabs** (ADR-20260619 — single buffer unchanged + pure tabs.ts),
  General version/Check-for-Updates + in-app Help. Gates green (tsc 0 · vitest 119 · cargo 75 · build 0).
- **Agent interface (MCP)** (ADR-20260623; ✅ **MERGED** to master via PR #4, merge `78b4c6b`) —
  Claude Code navigates + captures the vault through the read-only `rose-glass-mcp` stdio sidecar:
  `search`/`get_note`/`manifest`/`related`/`get_semantic_clusters`/`maintenance_report`, plus
  `upsert_note` under `--allow-write` (inbox-only, file-first, A3-safe). 6 phases, two 3-lens reviews,
  E2E stdio proof. See STATUS.md "Agent interface (MCP) shipped" + `docs/agent-interface.md`. Gates:
  cargo 96+22 · vitest 119 · tsc/build 0.
- **v2.4 / v2.4.1** (tag `v2.4` @ `0.4.0`, then merge `dc86f21` / tag `v2.4.1` @ `0.4.1`; signed NSIS;
  ADR-20260624-rose-glass-mcp-freshness-semantic) — released the agent interface, then closed the
  embedding-freshness gap: on-demand **`reembed`** (full-corpus recompute, skip-if-fresh) + free-text
  **`semantic_search`** over MCP, both `--allow-write`-only (the model loads only in write mode), plus a
  single mode-aware `db::open_indexed` connection constructor. The flagged "FK-off bug" was a false alarm
  (bundled SQLite defaults FK ON). See STATUS.md "v2.4 + v2.4.1". Gates: cargo 98+31 (incl. real-model
  E2E) · tsc/vitest/build 0.

## Active frontier (historical — pre-v1.0 round-2 feedback, 2026-06-17 PM)
~~Primary: GPU shader parity~~ ✅ **DONE** (Phase 4 row above — GPU-visual parity + Focus + inversion,
3-lens reviewed, 5090-verified dark+light). Next: the round-2 fixes/features logged in PROGRESS.md
"Round-2 live feedback" — Focus-dim bug (2D path; the GPU no-op is now fixed), palette-result-click
bug, Share-clipboard (Tauri clipboard plugin), window controls/fullscreen (Tauri window perms),
terminal rename + Claude-attention indicator, Properties disk size. Phase 12 (§20 v1.0 gate) closes
after these.
