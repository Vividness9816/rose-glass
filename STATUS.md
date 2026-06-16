# STATUS — §20 acceptance ledger

Bounded, git-anchored (ADR-20260616). One row per §20 acceptance item. A row is
`proven` ONLY if it cites a re-runnable artifact (command + output, or a committed
screenshot). Prose "verified" without an artifact is a schema violation. Resumption
index: `git log --grep=phaseN`.

States: ✅ proven · 🟡 partial · 🟥 stubbed · ⬜ untouched

| Id | §20 acceptance item | State | Evidence (commit scope + artifact) |
|---|---|---|---|
| A1 | Boots clean, no runtime errors, `tsc` passes, unit tests green, Ponytail audit clean | 🟡 | `tsc` 0; `vitest` 22/22; `vite build` 0; `cargo test` 24/24 + `cargo clippy` 0 warnings (`phase3-editor`). Remaining: live `tauri dev` window eyeball; formal `/ponytail-audit`. |
| A2 | Playwright visual diffs (shell/graph/editor/⌘K), light+dark; Impeccable on un-mocked | 🟡 | Render captured both themes: `docs/proof/phase1-shell-{dark,light}.png` (`phase1-shell`). Remaining: automated screenshot-DIFF harness vs mockup; ⌘K; Impeccable run. |
| A3 | Delete SQLite DB → reboot → index rebuilds equivalent | ✅ | `cargo test indexer::pipeline::tests::a3_delete_db_rebuild_is_equivalent` passes — builds index, snapshots, deletes DB, rebuilds, asserts order-independent equivalence (`phase2-indexer`). |
| A4 | Theme switches light/dark live, no reload, persisted | ✅ | Toggle flips `data-theme` + `--bg` `#0a0408`↔`#fdf2f4`, persists `localStorage app.theme`; `docs/proof/phase1-shell-light.png` (`phase1-shell`). Light palette is an untuned first pass (Phase 6). |
| A5 | Graph matches mockup; WebGPU 4K; gravity+collision+free clusters; click/zoom/drag/pan; WebGPU↔2D fallback | 🟡 | Canvas-2D living graph (mockup physics, token-driven), now fed by REAL indexer data when a vault is open (`get_graph_payload` → `payloadToGraphData`, `phase2-ipc`); mock otherwise. Remaining: WebGPU/4K, all mouse interaction, fallback verify (`phase4-webgpu`). |
| A6 | Any CC session read/modify lights up node (read=violet pulse, modify=rose flare); Activity pane streams all sessions | ⬜ | `phase8-activity` — gated by hook/transcript safety carve-out (ADR). |
| A7 | Embedded terminal runs Claude Code + arbitrary commands, cwd=vault | ⬜ | `phase7-terminal`. |
| A8 | True in-app editing (CM6 / MuPDF / TipTap+docx); installer registers `.md/.txt/.pdf` | 🟡 | CM6 editor with live-preview decorations (wikilink/tag/inline-code — Playwright-verified: `docs/proof/phase3-editor-decorations.png`), path-safe read/save IPC (atomic write; 3 `fs_safe` tests), open-first-note + wikilink/backlink nav, autosave + anti-clobber (`phase3-editor`). Remaining: MuPDF/docx engines + installer associations (`phase9-formats`). |
| A9 | External MCP client can `search` + `get_semantic_clusters` | ⬜ | `phase10-mcp`. |
| A10 | Reskin (edit `tokens.css`) re-themes app **and** graph, no component edits | ✅ | The `[data-theme=light]` block in `tokens.css` re-themes the whole app + the canvas graph (via `resolveGraphTheme()`) with zero component edits: compare `docs/proof/phase1-shell-{dark,light}.png` (`phase1-shell`). Formal third-theme experiment still open. |
| A11 | Taste pass confirms hand-built, not templated | ⬜ | `phase6-glass` / final gate. |

## Phase 3 shipped (CodeMirror 6 editor)
- CM6 editor host (StrictMode-safe single mount — Playwright `cmCount===1`) replaces the static body; React keeps the breadcrumb/title/meta/backlinks chrome.
- Live-preview decorations (ViewPlugin over visible ranges) for `[[wikilink]]` / `#tag` / `` `inline code` `` — tag regex mirrors the indexer so painted ≡ indexed; verified live via Playwright typing.
- Theme via `EditorView.theme` reading `var(--*)` tokens → re-themes on dark/light flip with zero JS.
- Path-safe IPC: `read_note_file` / `save_note_file` (atomic temp+rename, vault-root canonicalize check — 3 `fs_safe` tests) / `resolve_link` (reuses the indexer's resolution so nav ≡ graph edges).
- Editor host: open-first-note on vault open; Mod/Ctrl-click wikilink + backlink-click navigation; debounced autosave with an anti-clobber guard (never reload the buffer the user is editing; ignore our own save echo) — vitest unit tests.
- **Adversarial review applied:** save-completion race guarded by captured path; empty-state editor is read-only (no silently-discarded typing); `read_note_file` strict-UTF-8 (no lossy round-trip corruption); **CRLF preserved** (LF internally, original EOL re-applied on save — the app never silently reformats a file); decoration tokenizer reorders inline-code before tag (+ pure `scanTokens` tests); delete-of-open-note handled; doc-swap excluded from undo; `save_note_file` fsyncs before rename; `fs_safe` rejects empty/dir targets.

## Phase 2 shipped (vault + indexer + SQLite + watcher + IPC)
- Rust indexer: deterministic markdown parser (frontmatter/wikilinks/embeds/md-links/tags, length-preserving masking so code/URLs are ignored), blake3 content-hash gate, two-pass link resolution, full-rebuild + incremental + delete, FS watcher (notify-debouncer-full) → worker thread.
- SQLite (rusqlite bundled + FTS5), derived-only schema (§8) at `<vault>/.rose-glass/index.db`; WAL + foreign_keys + busy_timeout pragmas; migrate-or-rebuild.
- IPC: `open_vault / get_note / get_backlinks / search (FTS5) / get_tags / get_graph_payload / reindex` + `index:note`/`index:rebuilt` events; typed `src/ipc` client; `payloadToGraphData` mapper feeds the real graph.
- Tests: 16 Rust (parser/resolve/pipeline/A3) + 7 vitest; clippy clean.
- **Pending on resume:** the adversarial review workflow (`phase2-review`) was interrupted by the pause — re-run it before building on this; its script is saved (see resume note below).

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

### Phase 2 review — deferred (low/speculative or future-phase)
- **mtime gate-1** skips the hash check when mtime is unchanged → a content edit that preserves mtime (coarse FS, mtime-restoring editors) is skipped until a full rebuild. Acceptable perf gate; revisit if it bites.
- **Tags starting with a digit** (`#3d`, `#1password`) are rejected by the TAG regex (requires a leading letter); `norm_tag` keeps a trailing `/`/`-`. Minor index inaccuracy.
- **Path-traversal targets** (`[x](../../etc/passwd)`) parse to dangling (never used as FS paths in P2) — when the link-follow feature lands, canonicalize + assert inside vault root.
- **Symlinked .md files** are indexed under their in-vault relpath (out-of-vault content can enter the index); **non-UTF-8 filenames** are silently skipped (no log). Add observability when it matters.
- **Watcher worker** has no UI health signal if its connection hits a fatal error (errors are now logged, not silently dropped); **mpsc channel** is unbounded under a save-storm. Revisit with the activity pane (Phase 8).

### Phase 3 review — deferred (low/cosmetic or future-phase)
- **Decoration code-fence masking**: a `[[link]]`/`#tag` inside a ``` ``` ``` fence is still painted (the JS tokenizer doesn't mask multi-line fences like the Rust indexer). Cosmetic — clicking resolves via the backend index (real note → nav, otherwise no-op).
- **`index:note` refetch on every save**: each open-note index event does getNote+getBacklinks+readNoteFile+refreshGraph. Debounce/throttle when vaults get large (perf, not correctness).
- **Multi-segment new folders**: `save_note_file` can't create a note in a not-yet-existing nested dir (errors cleanly). Add `create_dir_all` when that workflow lands.
- **Save-failure on rapid switch**: a rejected autosave during a note switch is logged but not retried/surfaced; add a status-bar "save failed" affordance later.
