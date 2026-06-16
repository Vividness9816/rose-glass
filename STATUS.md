# STATUS — §20 acceptance ledger

Bounded, git-anchored (ADR-20260616). One row per §20 acceptance item. A row is
`proven` ONLY if it cites a re-runnable artifact (command + output, or a committed
screenshot). Prose "verified" without an artifact is a schema violation. Resumption
index: `git log --grep=phaseN`.

States: ✅ proven · 🟡 partial · 🟥 stubbed · ⬜ untouched

| Id | §20 acceptance item | State | Evidence (commit scope + artifact) |
|---|---|---|---|
| A1 | Boots clean, no runtime errors, `tsc` passes, unit tests green, Ponytail audit clean | 🟡 | `tsc --noEmit` exit 0; `vitest run` 4/4 (`phase4-graph`); `vite build` exit 0; `cargo check` exit 0 (`phase0-scaffold`). Remaining: live `tauri dev` window eyeball; formal `/ponytail-audit`. |
| A2 | Playwright visual diffs (shell/graph/editor/⌘K), light+dark; Impeccable on un-mocked | 🟡 | Render captured both themes: `docs/proof/phase1-shell-{dark,light}.png` (`phase1-shell`). Remaining: automated screenshot-DIFF harness vs mockup; ⌘K; Impeccable run. |
| A3 | Delete SQLite DB → reboot → index rebuilds equivalent | ⬜ | No DB yet (`phase2-indexer`). |
| A4 | Theme switches light/dark live, no reload, persisted | ✅ | Toggle flips `data-theme` + `--bg` `#0a0408`↔`#fdf2f4`, persists `localStorage app.theme`; `docs/proof/phase1-shell-light.png` (`phase1-shell`). Light palette is an untuned first pass (Phase 6). |
| A5 | Graph matches mockup; WebGPU 4K; gravity+collision+free clusters; click/zoom/drag/pan; WebGPU↔2D fallback | 🟡 | Canvas-2D living graph (mockup physics, token-driven) renders on mock data: `docs/proof/phase1-shell-dark.png` (`phase4-graph`). Remaining: WebGPU/4K, all mouse interaction, fallback verify (`phase4-webgpu`). |
| A6 | Any CC session read/modify lights up node (read=violet pulse, modify=rose flare); Activity pane streams all sessions | ⬜ | `phase8-activity` — gated by hook/transcript safety carve-out (ADR). |
| A7 | Embedded terminal runs Claude Code + arbitrary commands, cwd=vault | ⬜ | `phase7-terminal`. |
| A8 | True in-app editing (CM6 / MuPDF / TipTap+docx); installer registers `.md/.txt/.pdf` | ⬜ | Editor pane is static mockup content, not yet CM6 (`phase3-editor`, `phase9-formats`). |
| A9 | External MCP client can `search` + `get_semantic_clusters` | ⬜ | `phase10-mcp`. |
| A10 | Reskin (edit `tokens.css`) re-themes app **and** graph, no component edits | ✅ | The `[data-theme=light]` block in `tokens.css` re-themes the whole app + the canvas graph (via `resolveGraphTheme()`) with zero component edits: compare `docs/proof/phase1-shell-{dark,light}.png` (`phase1-shell`). Formal third-theme experiment still open. |
| A11 | Taste pass confirms hand-built, not templated | ⬜ | `phase6-glass` / final gate. |

## This session shipped (Phase 0 + 1 + 2D-graph leg)
- pnpm workspace + Tauri 2 (React 19 / TS strict / Vite); Rust shell compiles.
- `tokens/tokens.css` copied verbatim from the mockup `:root`; self-hosted Inter + JetBrains Mono (no Google Fonts).
- Shell 1:1 from the mockup (titlebar + traffic-light window controls / 52px rail / split / statusbar).
- Mockup's canvas-2D living graph ported, de-hardcoded (colors from tokens), on mock `GraphData`.
- Live + persisted dark/light theme toggle (light = untuned first pass).

## Known ceilings (ponytail-marked)
- Frameless window: native edge-resize reduced on Windows; upgrade = resize handles / `tauri-plugin-decorum`.
- Graph canvas at CSS-px resolution (not yet 4K/dpr) — fixed-4K buffer lands with WebGPU (`phase4-webgpu`).
- `favicon.ico` 404 in dev console — cosmetic; add a favicon when chrome is finalized.
