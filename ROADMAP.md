# Rose Glass — Roadmap (the autonomous spine)

Phases map 1:1 to spec §15. **Commit scopes use the phase id** (`feat(phase4-graph): …`)
so `git log --grep=phase4` is the resumption index (ADR-20260616). Each phase opens
with a riskiest-premise spike on a tiny scope before its build.

| Phase | Id | Deliverable | Status |
|---|---|---|---|
| 0 | `phase0-scaffold` | Monorepo + Tauri boots + `tokens.css` verbatim + theme toggle + self-hosted fonts | ✅ done (this session) |
| 1 | `phase1-shell` | Titlebar / 52px rail / split / statusbar 1:1 from mockup | ✅ done (this session) |
| 4(2D) | `phase4-graph` | Canvas-2D living graph ported, de-hardcoded, on mock data (the §20 2D-fallback leg) | ✅ done (this session) |
| 2 | `phase2-indexer` | Vault open + watcher + indexer + SQLite schema (§8); incremental + full-rebuild | ⬜ next |
| 3 | `phase3-editor` | CodeMirror 6 editor pane (mockup parity), save path, live links/backlinks | ⬜ |
| 4 | `phase4-webgpu` | WebGPU renderer at fixed 4K + drag node/cluster + zoom/pan + click-open; **spike: React19×design-libs + WebGPU 4K probe + fallback** | ⬜ |
| 5 | `phase5-search` | FTS5 search + ⌘K command palette (mockup glass) | ⬜ |
| 6 | `phase6-glass` | Theme-aware shadergradient backdrop + dashersw glass + backdrop-filter surfaces; light-theme tuning + dual-theme diffs | ⬜ |
| 7 | `phase7-terminal` | xterm.js + portable-pty; "Run Claude Code here" | ⬜ |
| 8 | `phase8-activity` | CC activity bus → node light-up + Activity pane. **GATED: hook-install + transcript-tail safety carve-out (ADR)** | ⬜ |
| 9 | `phase9-formats` | Editor host + MuPDF/PDF.js (true PDF edit) + TipTap/docx bridge; `.md/.txt/.pdf` association via installer; **spike: MuPDF WASM + docx round-trip premises** | ⬜ |
| 10 | `phase10-mcp` | Read/query MCP sidecar (§14) | ⬜ |
| 11 | `phase11-clusters` | Embeddings + clustering → `clusters` table; optional GPU compute physics | ⬜ |
| 12 | `phase12-v1` | Full §20 acceptance gate | ⬜ |

## Binding preconditions (from ADR-20260616)
- **Phase 8** ships the §11.4 global-hook install + `~/.claude/projects` transcript-tail ONLY behind: explicit user OK · atomic `settings.json` backup + temp-write/rename + re-parse-validate-all-entries · `127.0.0.1`-only endpoint · no transcript persistence · secret-path redaction/exclusion · working uninstall.
- **Phase 4 (WebGPU)** and **Phase 9 (MuPDF/docx)** open with a premise spike — never assume the hard pillar works; prove it on a tiny scope first.
- Every `proven` row in STATUS.md cites a commit scope + a re-runnable artifact. No prose "verified."
