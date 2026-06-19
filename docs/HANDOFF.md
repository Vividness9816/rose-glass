# Session handoff — v2.1 + v2.2 (awaiting eyeball + merge)

_Snapshot 2026-06-19. Transient: delete or fold into STATUS.md once v2.1/v2.2 merge._

## Branch state — two stacked feature branches, PUSHED, NEITHER MERGED
- `master` — v2.0 (PR #1 merged).
- `feat/v2.1-ui` (off master, 3 commits) — terminal clipboard shortcuts + PowerShell default
  shell; attention dot (circle→square); resizable panels.
- `feat/v2.2-ui` (stacked on v2.1, 8 commits) — the 6 v2.2 items below + commit `362b05a`
  fixing a v2.1 omission (see Known issue).

`git log --oneline master..feat/v2.1-ui` and `git log --oneline feat/v2.1-ui..feat/v2.2-ui`
show the stacks.

## What was built
**v2.1** (ADR `~/.claude/second-brain/decisions/ADR-20260619-rose-glass-v2.1-ui-fixes.md`):
1. Terminal clipboard: right-click copy-if-selection-else-paste; Ctrl+C copies only with a live
   selection else stays SIGINT; Ctrl+V / Ctrl+Shift+C·V; "copied" pill; default shell cmd.exe→
   PowerShell (bracketed-paste safety) + trailing-newline strip.
2. Attention dot: rose circle → emerald **square** + pulse when a terminal emits output that
   settles ~400 ms while unattended (not active tab / drawer hidden / window blurred); old
   activeTerm guard removed; clears on refocus/select.
3. Resizable panels: graph↔editor split (col-resize) + terminal-drawer height (row-resize);
   hand-rolled `<Splitter>`, sizes persisted + clamped; PTY resize rAF-coalesced.

**v2.2** (spec `docs/superpowers/specs/2026-06-19-rose-glass-v2.2-design.md`):
1. Graph "solar system": centripetal `centerPull` in `stepSimulation`, default `0.0015`,
   tunable via the new "center hold" slider (holds around centre, still lively — not frozen).
2. Lazy `TerminalPane` → boot chunk 1104 kB→771 kB (xterm out). _Web CRP checklist was N/A;
   backdrop/PDF/DOCX already lazy._
3. `React.memo(GraphPane)` — the feared editor→graph re-render cascade does **not** exist
   (already architected away); this is insurance only.
4. Container queries: `.note-meta` wraps + breadcrumb collapses by **pane** width.
5. Iconography: one curated in-repo `<Icon>` set (`apps/desktop/src/icons/Icon.tsx`, ~21 paths,
   1.5 px stroke, no dep); 16 glyph/emoji render sites swapped; IconRail got aria-labels. Left
   intentionally: macOS traffic-lights, CSS status dots, keycap chips.
6. Single-instance: `tauri-plugin-single-instance` (registered FIRST) forwards a
   double-clicked file to the running app (`open-file` event); cold-start drains own argv;
   reuses v2.0 drag-drop ingest; +docx file association.

## Gate status (all GREEN at handoff)
tsc 0 · vitest 95/95 · cargo 75/75 · clippy clean for our diffs (the `large_enum_variant`
warning in `src-tauri/src/embed.rs` is **pre-existing**, not ours) · vite build OK.
Self-audited: v2.1 Phase A, v2.1 Phase C, v2.2 item 6 — all SHIP.

## Known issue (already fixed — decide handling)
v2.1's resizable-panes commit (`0f183af`) forgot to stage `apps/desktop/src/shell/session.ts`,
so its `splitFraction`/`terminalHeight` fields were uncommitted → that commit is incomplete in
isolation. Fixed on v2.2 as `362b05a`. **Decide:** cherry-pick `362b05a` onto `feat/v2.1-ui`
so v2.1 stands alone, OR merge the two branches together.

## What to CHECK (needs a running app — not headless-verifiable)
`cd apps/desktop && pnpm tauri dev`. Frontend is live via Vite HMR; the single-instance Rust
needs the dev rebuild (relaunch `tauri dev` once to be safe). The OS double-click /
file-association flow needs a built+installed bundle (`pnpm tauri build`), **not** dev.
- v2.1: resize-seam hover/drag feel; trigger the attention square (run a command, look away,
  confirm circle→square, then clears on return); confirm Ctrl+C still interrupts when nothing
  is selected.
- v2.2: **icon alignment** (the one thing static checks can't confirm — esp. PDF/Docx bar icon,
  command-palette result chip, side-pane header glyphs); graph `centerPull` hold feel (tune via
  slider); single-instance double-click (installed build only).

## Still TO DO
1. Eyeball v2.1 + v2.2 in the running app; report anything off → adjust.
2. Decide the `session.ts` fix (cherry-pick to v2.1 vs merge together).
3. Merge strategy: stacked PRs (v2.1→master, then v2.2→v2.1) vs merge v2.1 to master then
   retarget v2.2 vs squash. Open PR(s) (`gh`; account `Vividness9816`).
4. On merge: update `STATUS.md` + `ROADMAP.md` here, and the global project memory
   (`project_rose_glass.md` / `MEMORY.md`) — deliberately held until eyeball+merge.
5. OPTIONAL, explicitly NOT built (only if wanted): orbital-spin dial for the graph; lazy-split
   CodeMirror too; activity-row container query; normalize the pane file-header-comment glyphs.

## Repo conventions
- Gates: `cd apps/desktop && pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm exec vite
  build`; Rust: `cd apps/desktop/src-tauri && cargo test --lib && cargo clippy --all-targets`.
- Don't run the full vitest suite while `tauri dev` is up (it flakes under that load).
- A pre-commit hook blocks `git commit` unless ` # self-audit-ok` is appended (after a genuine
  self-audit). Conventional commits; end messages with the Co-Authored-By / Claude-Session
  footers. Stage item files explicitly (don't `git add -A`).
