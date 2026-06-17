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
| 4 | `phase4-webgpu` | WebGPU renderer at fixed 4K + drag node/cluster + zoom/pan + click-open; **spike: React19×design-libs + WebGPU 4K probe + fallback** | 🟡 interaction + airtight fallback DONE (3-lens reviewed, vitest 46/46); WebGPU render BUILT but **NOT GPU-VERIFIED** → RTX 5090 eyeball (`phase4-graph`, `phase4-webgpu`) |
| 5 | `phase5-search` | FTS5 search + ⌘K command palette (mockup glass) | ✅ done |
| 6 | `phase6-glass` | Theme-aware **r3f-v9** living backdrop (shadergradient dead on R19) + **eamonliu** liquid-glass lens (dashersw incompatible w/ WebGL) + backdrop-filter chrome; light-theme **tuned**; dual-theme diffs | ✅ done (visual taste pending user eyeball) |
| 7 | `phase7-terminal` | xterm.js + portable-pty; embedded shell at cwd=vault (runs Claude Code) | ✅ done (cargo 26/26, user-confirmed live) |
| 8 | `phase8-activity` | CC activity bus → node light-up + Activity pane (M1 transcript-tail; M2 global hook **deferred** per ADR-20260617) | 🟡 M1 done (built + 3-lens reviewed, cargo 52/52; live-eyeball + M2-arming = morning) |
| 9 | `phase9-formats` | Editor host + MuPDF/PDF.js (true PDF edit) + TipTap/docx bridge; `.md/.txt/.pdf` association via installer; **spike: MuPDF WASM + docx round-trip premises** | ⬜ |
| 10 | `phase10-mcp` | Read-only MCP sidecar (search + get_semantic_clusters) over stdio | ✅ done (cargo 35/35, e2e stdio proof) |
| 11 | `phase11-clusters` | Local neural embeddings (all-MiniLM/ONNX) + k-means → `clusters` table; graph cluster colouring + MCP clusters | ✅ done (cargo 41/41 + real-model semantic test) |
| 12 | `phase12-v1` | Full §20 acceptance gate | ⬜ |

## Binding preconditions (from ADR-20260616)
- **Phase 8** ships the §11.4 global-hook install + `~/.claude/projects` transcript-tail ONLY behind: explicit user OK · atomic `settings.json` backup + temp-write/rename + re-parse-validate-all-entries · `127.0.0.1`-only endpoint · no transcript persistence · secret-path redaction/exclusion · working uninstall.
- **Phase 4 (WebGPU)** and **Phase 9 (MuPDF/docx)** open with a premise spike — never assume the hard pillar works; prove it on a tiny scope first.
- Every `proven` row in STATUS.md cites a commit scope + a re-runnable artifact. No prose "verified."
