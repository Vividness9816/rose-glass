# rose-glass v2.2 — six improvements

- **Date:** 2026-06-19
- **Status:** approved (brainstorming → build)
- **Branch:** `feat/v2.2-ui` (stacked on `feat/v2.1-ui`, which is unmerged; #4 depends on v2.1 resizable panes)
- **Process:** `/superpowers:brainstorming` over a 6-agent read-only investigation; forks decided by the user (recorded below — supersedes a `/council` ADR since nothing was left to deliberate). Built ponytail-minimal; impeccable's design lens folded into items 1/4/5.

## Decisions (the forks)

| # | Item | Decision | Why |
|---|------|----------|-----|
| 1 | Graph "solar system" | **Center-hold (figurative)**, tunable, ON by default | User wants movement *around a fixed center*, not orbital spin or freeze |
| 2 | Boot render path | **Lazy TerminalPane only** | Risk-free; backdrop/PDF/DOCX already lazy |
| 3 | Re-renders | **One optional memo** (GraphPane) | The feared editor→graph cascade does not exist; this is insurance |
| 4 | Container queries | `.note-meta` wrap + breadcrumb collapse | Only two components have real narrow/wide divergence |
| 5 | Icons | **Curated in-repo SVG set** (no dep) | Matches the existing `SlidersIcon` precedent + lean-shell ethos |
| 6 | Single-instance | plugin + reuse v2.0 ingest; **+docx**, outside-vault→`inbox/` | Forwarding is the only missing piece; associations already registered |

## Per-item design

### 1 — Graph center-hold (`graph/`)
Today `stepSimulation` (`simulation.ts:30-85`) has drift + intra-cluster cohesion + collision + damping + soft walls, but **no center force**, so the whole system slowly drifts and is "held in" only by bouncing off the boundary box. The rejected `fixed` mode freezes nodes.
- **Add** one centripetal term in the per-node loop (gated off in `fixed` mode): `n.vx += (W/2 - n.x) * centerPull; n.vy += (H/2 - n.y) * centerPull;` (center = live `W/2,H/2`, resize-safe).
- **Config:** new `centerPull: number` field in `GraphConfig`/`DEFAULT_CONFIG` (`config.ts`), default `0.0015` so the held look is on by default; `loadConfig` merge-over-defaults makes it forward-compatible. Update the "reproduces v1.0 exactly" comment.
- **Panel:** add a `center hold` slider (`GraphConfigPanel.tsx`, 0–0.006), disabled in `fixed` mode like `drift`.
- **Test:** `centerPull` holds an off-center node nearer the center than `centerPull:0` does, while velocity stays nonzero (hold-not-freeze).
- Both renderers share the step → no renderer edits. Effort **S**, no dep.

### 2 — Lazy TerminalPane (`shell/Shell.tsx`)
xterm is eager in the 1.1 MB boot chunk but the terminal is hidden until Ctrl+` and already conditionally mounted. `lazy(() => import('../terminal/TerminalPane').then(m => ({ default: m.TerminalPane })))` + wrap the render site in `<Suspense fallback={null}>`. The web checklist (preconnect/dns-prefetch/render-blocking third-party) is **N/A** — bundled desktop app, zero third-party origins; backdrop/PDF/DOCX already `React.lazy`. Effort **S**, no dep.

### 3 — One memo (`graph/GraphPane.tsx`, `shell/Shell.tsx`)
Static trace **refutes** the user's #1 suspicion: editor keystrokes go through refs + imperative CodeMirror + a self-driven RAF renderer; they do **not** re-render Shell or rebuild the canvas (`Shell.tsx:onChangeDoc` is ref-only; GraphPane rebuild is gated on `data` identity that typing never changes). Only real (bounded, cheap) trigger: `setActivity` per CC event. Fix = `React.memo(GraphPane)` + `useCallback` the `onOpenNode` arrow so the memo isn't defeated; verify all 9 props stable. Effort **S**. No broad/speculative memoization (ponytail).

### 4 — Container queries (`shell/shell.css`)
v2.1 made panes resizable, so chrome rows now span widely varying widths. `container-type: inline-size` on `.editor-pane`; `@container (max-width:480px){ .note-meta{ flex-wrap:wrap; gap:6px 16px } }` and `@container (max-width:420px){ .breadcrumb .bc-seg, .breadcrumb .bc-sep{ display:none } }`. Native in the WebView2 target, no dep, no JSX. Verify the Outline popover still anchors (containment changes the containing block). Skip the already-vertical rows. Effort **S**.

### 5 — Curated icon set (`icons/Icon.tsx` + ~10 components + `tokens.css`)
Four mixed sources today (emoji, unicode glyphs, one inline SVG, CSS shapes); one `note-meta` row alone mixes emoji 📅 + three unicode glyphs. New `<Icon name size/>` (~16 paths, `viewBox 0 0 24 24`, `fill:none`, `stroke:currentColor`, `strokeWidth:1.5`, `aria-hidden`), absorbing `SlidersIcon`. Size tokens `--icon-sm/md/lg = 13/15/18` (next to `--r-*`). Swap glyph/emoji literals across IconRail, Titlebar action glyphs (keep text labels), EditorPane (incl. the `note-meta` row), CommandPalette, GraphPane, terminal controls (Shell.tsx), pane `sp-glyph`s, `gcfg-x`. Add `aria-label` to IconRail buttons. **Leave**: macOS traffic-lights (intentional OS treatment), CSS-shape dots, keycap chips. Stroke stays 1.5px at every size (what makes them one family). Effort **M**, no dep.

### 6 — Single-instance (`src-tauri/` + `shell/Shell.tsx` + `ipc/`)
Associations are registered (`tauri.conf.json:44-63`: md/markdown/txt/pdf) but nothing consumes the launch argv, so every double-click spawns a new process that drops the file. Add `tauri-plugin-single-instance` (1 new Rust dep) registered **first**; its callback focuses the window + emits `open-file(path)` from argv. Cold-start (first instance's own argv) captured into `AppState` + a `take_pending_open_file` command. Frontend `onOpenFile` listener → reuse `ingestDroppedFile` (outside-vault → `inbox/`, index, open) — same as v2.0 drag-drop. `+docx` association; `+core:window:allow-set-focus/allow-unminimize` capabilities. Effort **M**, 1 new Rust dep.

## Build order & gates
**1 → 3 → 2 → 4 → 6 → 5** (sequential; #2/#3/#5/#6 all touch `Shell.tsx`). Each item its own commit, gates green (tsc 0 / vitest / cargo test / clippy), self-audit on #5 (broad sweep) and #6 (new dep + argv handling).

## Explicitly NOT built (ponytail guardrails)
No d3-force; no `react-resizable-panels`/icon library/lucide; no orbital-spin system (figurative hold only); no speculative memoization beyond the single GraphPane memo; no vite `manualChunks`; no macOS/Linux deep-link plumbing (Windows argv path only); no read-only viewer / vault-switching for outside-vault files (reuse ingest). Backdrop, PdfView, DocxView untouched (already optimal).
