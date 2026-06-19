# Rose Glass v2.3 — Obsidian feel + Settings menu

**Date:** 2026-06-19 · **Status:** design (brainstormed, awaiting user spec review) · **Predecessor:** v2.2 (`2470fb1`, tagged `v2.2` @ 0.2.0)

## Motivation

Two user asks, brainstormed into one staged milestone:

1. **"My Rose Glass vault looks a lot different from Obsidian."** RG already matches Obsidian on layout and degree-based node sizing (`r = 4 + 7·degree/max`, hubs flagged ≥66% of max). The visible gap is **interaction + display**, not layout. The user picked specific Obsidian behaviors (not a full austere repaint): hover-to-highlight, labels-on-hover, and showing unresolved links as ghost nodes.
2. **A categorized Settings menu** (General / Editor / Behavior / Advanced) with concrete actions — several of which require subsystems RG doesn't have yet (tabs, a reading mode).

## Decisions locked (from brainstorming)

- **Graph:** *Remove* the All/Focus toggle. **Hover** a node → highlight it + its 1-hop neighbors, dim the rest. **Labels** hidden until hover (then shown for the hovered node + neighbors). ~~**Ghost nodes:** render unresolved link targets as faded, non-openable nodes (Obsidian parity).~~ **DROPPED post-eyeball (2026-06-19):** on the real vault this produced ~1100 ghosts vs ~130 real nodes (the home-dir index has huge numbers of unresolved `[[link]]`-like targets) — far too noisy. The graph stays resolved-only. Revisit only behind an off-by-default toggle + an aggressive filter/cap if ever wanted.
- **Settings:** build the full categorized menu. The two tab-dependent settings require **tabs + a reading mode**, and the user chose to **build those subsystems too** (full parity).
- **Shape:** one staged spec, 5 legs, low-risk → high-risk order. Each leg builds + passes gates independently. Build leg-by-leg with user review between, matching how v2.0/v2.2 shipped.
- **Baked-in defaults (user-approved):** add `@replit/codemirror-vim` + `turndown`; reading-mode renderer = `markdown-it` + existing DOMPurify; Help = a generated `help.pdf` opened in RG's own in-app PDF viewer; Check-for-Updates = show version + open the GitHub releases page (NOT the Tauri auto-updater).

## Cross-cutting: settings architecture

A new `src/settings/` module, modeled on the existing `graph/config.ts` (interface + load/save-over-defaults + localStorage, forward-compatible).

- **`settings.ts`** — `interface Settings` (all 11 knobs), `DEFAULT_SETTINGS`, `loadSettings()`/`saveSettings()` (key `rose-glass:settings`, merge-over-defaults so new fields are forward-compatible). Pure, unit-tested (load merges partial/garbage onto defaults).
- **`SettingsContext.tsx`** — a small React context + `useSettings()` hook + `useSetSettings()`. Justified over prop-drilling: the settings have **multiple cross-cutting consumers** (CodeMirrorHost, EditorPane, Shell/tabs). Provider lives at the Shell root, seeded from `loadSettings()`, persists on change.
- **Settings UI** — restructure `SettingsPane.tsx` from its flat field list into **collapsible sections** (General / Editor / Behavior / Advanced). Reuse the existing `.sp-*` styles; add a reusable `<Toggle>` (on/off slider) and `<Select>` (dropdown) presentational component. Existing fields (Theme, Vault, Index, activity-hook) fold under the right sections (Theme → General/Appearance; Index + activity-hook → Advanced).
- **Editor settings → CodeMirror** via **Compartments** (the file already uses `editableCompartment`). Each toggle-able concern gets its own compartment, reconfigured live when settings change — **no editor remount**. CodeMirrorHost subscribes to `useSettings()` and dispatches `compartment.reconfigure(...)` in an effect keyed on the relevant fields.

## Leg 1 — Settings framework + Behavior/Advanced editor settings

*Self-contained; no tabs/reading needed. The categorized menu ships here; the two tab-dependent rows are added disabled and wired in legs 3/4.*

**Behavior (CM6 compartments):**
- **Spellcheck** — `EditorView.contentAttributes.of({ spellcheck, autocorrect, autocapitalize })` compartment (native browser spellcheck; no dep).
- **Auto-pair brackets** — `closeBrackets()` + `closeBracketsKeymap` from `@codemirror/autocomplete` (**new dep**), compartment on/off.
- **Auto-pair Markdown syntax** — same `closeBrackets`, configured to also pair `*`/`_`/`` ` ``/`~` (markdown emphasis/code). Separate toggle reconfigures the brackets set.
- **Smart lists** — a small custom keymap extension (`smartLists.ts`): Enter continues/renumbers the current `-`/`*`/`1.` list item (or exits on empty item); Tab/Shift-Tab indent/outdent the item. No standard package exists; pure logic, unit-tested. Compartment on/off.
- **Indent using tabs** — `indentUnit.of('\t')` vs `indentUnit.of('    ')` from `@codemirror/language` (**add explicitly**; `indentWithTab` is already in the keymap) compartment.

**Advanced:**
- **Vim keybindings** — `vim()` from `@replit/codemirror-vim` (**new dep**), as the FIRST extension via a compartment (vim wraps keymaps; ordering matters). On/off reconfigure.
- **Convert pasted HTML→Markdown** — an `EditorView.domEventHandlers({ paste })` extension: when the clipboard has `text/html`, the setting is on, and the event is NOT a raw-paste, convert via `turndown` (**new dep**) and insert Markdown instead of the default. **Ctrl/Cmd+Shift+V** = raw paste (a keymap sets a one-shot "paste raw" flag the handler reads). Applies to web drag-drop HTML too.

**Files:** `src/settings/{settings.ts,SettingsContext.tsx}`, `src/editor/smartLists.ts`, `src/editor/htmlPaste.ts`, edits to `CodeMirrorHost.tsx` (compartments) + `SettingsPane.tsx` (sections + Behavior/Advanced rows) + a `<Toggle>`/`<Select>` component.
**New deps:** `@codemirror/autocomplete`, `@codemirror/language` (explicit), `@replit/codemirror-vim`, `turndown` (+ `@types/turndown`).
**Gates:** tsc 0 · vitest (settings merge, smartLists logic, turndown-convert helper) · cargo unchanged · vite build 0.
**Ceilings (`ponytail:`):** smart-lists is a pragmatic keymap, not a full Markdown AST list engine — handles `-`/`*`/`1.` + indent; nested-ordered renumber across blank lines is best-effort.

## Leg 2 — Graph Obsidian behaviors

*Self-contained except the backend ghost-node emission.*

- **Remove Focus toggle** — delete the `scope` state, the All/Focus header buttons, and the `scope`/`activePath` focus effect in `GraphPane.tsx`. `activePath` prop stays (used elsewhere) but no longer drives graph focus.
- **Hover highlight** — in the existing `onMove` handler (drag.mode === 'none'), pick the node under the cursor and call `renderer.setFocus(node?.path ?? null)`; clear on `pointerleave`. Reuses `setFocus`/`focusSet`/`nodeAlpha`/`edgeAlpha` **verbatim** — the dimming already does "highlight set full, rest dimmed."
- **Labels on hover** — remove the always-on hub `fillText` in `GraphRenderer.draw()`. After the node pass, if `focusSet` is set, draw a name label under each focus-set node. No hover → no labels.
- **Ghost nodes** — backend: the Rust graph query emits **unresolved link targets** as ghost nodes (`is_ghost: true`, `link_count: 0`, synthetic path keyed by the unresolved target) plus edges to them. Frontend: `GraphNode.ghost?: boolean`; `fromPayload` keeps ghost nodes/edges (no longer drops edges to non-existent targets); `GraphRenderer` draws ghosts faded (low alpha, no aura/ring/orbit, muted/outline-only) and the click-open handler no-ops on a ghost (create-on-click deferred).

**Files:** `GraphPane.tsx`, `GraphRenderer.ts`, `graph/types.ts`, `graph/fromPayload.ts`, Rust graph query (`src-tauri/src/queries.rs` + `commands.rs` payload + the `GraphPayload` DTO in `src/ipc`).
**Gates:** tsc 0 · vitest (fromPayload keeps ghosts; hover→focusSet via existing tests) · cargo (graph query emits ghost targets — new unit test) · clippy 0 · vite build 0.
**Ceilings / carve-outs:** the opt-in **GPU** renderer already honors `setFocus` dimming, but (a) labels-only-for-hovered-set and (b) ghost-node styling in WGSL are **follow-up parity TODOs** — the default canvas-2D path gets the full behavior; GPU gaps documented, not blocking. Click-to-create a ghost note is deferred (Obsidian does it; YAGNI for v2.3).

## Leg 3 — Reading mode

- **`ReadingView.tsx`** — `markdown-it` (**new dep**) renders the doc to HTML → **DOMPurify** (already a dep, same config family as DocxView) → `dangerouslySetInnerHTML` in a `.reading-view` (read-only, themed). A small pre-pass rewrites `[[wikilinks]]` → anchors and `#tags` → spans; clicks route through the existing `onWikiClick`/`onOpenPath` so nav ≡ the editor's.
- **Edit/Read toggle** in the editor header (`EditorPane.tsx`) — swaps `CodeMirrorHost` ↔ `ReadingView` for the open note. Per-note (per-tab in leg 4) mode state; initial mode = the "Default view" setting.
- Wires the **"Default view for new tabs (editing/reading)"** Editor setting (the `<Select>` added disabled in leg 1 is enabled here).

**Files:** `src/editor/ReadingView.tsx`, `src/editor/mdRender.ts` (markdown-it + wikilink/tag pre-pass, pure + unit-tested), `EditorPane.tsx` (toggle + mode state), `SettingsPane.tsx` (enable Default-view select).
**New deps:** `markdown-it` (+ `@types/markdown-it`).
**Gates:** tsc 0 · vitest (mdRender: wikilink/tag rewrite, sanitization strips script/`javascript:`) · vite build 0 (markdown-it lazy-split off the critical path like the pdf/docx viewers).
**Ceilings:** reading view is render-only (no editing); RG's live-preview already renders inline while editing, so this is the "fully rendered, read-only" complement. No live scroll-sync between edit/read (YAGNI).

## Leg 4 — Tabs (biggest; **/council candidate at plan time**)

Restructures the editor area from single-document to multi-document.

- **Tab model in Shell** — `openTabs: { path: string; mode: 'edit' | 'read' }[]` + `activeTab: number`, replacing the single `openNote`/`binaryPath`. A `<TabBar>` above the editor (new/close/switch, overflow-scroll). Binary (pdf/docx) tabs supported (mode ignored).
- **Open-in-new-tab** — link clicks (wikilink/backlink/related/graph/command-palette) open in the active tab by default; modifier (Ctrl/Cmd-click) opens a new tab. **"Always focus new tabs"** controls whether a newly-opened tab becomes active immediately.
- **Per-tab reading mode** — each tab carries its `mode`; new tabs seed from the "Default view" setting.
- Wires **"Always focus new tabs"** (leg-1 disabled toggle → enabled here).

**Files:** `Shell.tsx` (state refactor — the largest change), `src/shell/TabBar.tsx`, `src/shell/tabs.ts` (pure tab-list ops: open/close/activate/dedupe-existing — unit-tested), edits to every open-path caller (EditorPane, GraphPane, command palette, NotesPane).
**Gates:** tsc 0 · vitest (`tabs.ts`: open dedupes an already-open path, close picks the right neighbor, focus-new honors the setting) · vite build 0.
**Risk / why council:** this is the one leg that **restructures shared Shell state** (single→multi doc) with many callers — exactly the "extending-systems-without-breaking" hazard. Run `/council` on the Shell-state approach (one tab-store reducer vs lifting an array; how binary tabs and the activity/graph wiring ride along) before planning leg 4.
**Ceilings:** no tab drag-reorder, no tab persistence across restart, no split-view (single editor pane, tabs switch it) — all deferrable.

## Leg 5 — General actions

- **Version + Check for Updates** — show the app version (`@tauri-apps/api/app` `getVersion()`, or the build-injected constant on web). "Check for Updates" button → `@tauri-apps/plugin-opener` (already a dep) opens `https://github.com/Vividness9816/rose-glass/releases`. (Private repo → can't embed an API token; honest minimal version. Auto-updater explicitly out of scope per the user's choice.)
- **Help PDF** — author `help.pdf` ("What Rose Glass is / How to use it / How it works") from the README + docs; bundle via **`bundle.resources`** in `tauri.conf.json`; a Help button resolves the bundled resource path (`@tauri-apps/api/path` `resolveResource`) and opens it in RG's **own in-app PdfView**. On the web build (no resource), the button links to the docs instead.

**Files:** `SettingsPane.tsx` (General section), a `help/help.pdf` source + `tauri.conf.json` `bundle.resources`, a small `openHelp()` IPC/path helper.
**Gates:** tsc 0 · vite build 0 · a signed `tauri build` (leg 5 touches bundle config) verifying the resource bundles + Help opens.
**Ceilings:** help.pdf is static (regenerated by hand when docs change); no in-app changelog.

## New dependencies (summary)

| Dep | Leg | Why | Lazier alternative considered |
|---|---|---|---|
| `@codemirror/autocomplete` | 1 | `closeBrackets` (auto-pair) | none — it's the CM6 home for bracket-closing |
| `@codemirror/language` (explicit) | 1 | `indentUnit` | already transitive; explicit for a direct import |
| `@replit/codemirror-vim` | 1 | Vim mode | hand-rolling vim = absurd; this is the standard |
| `turndown` (+types) | 1 | HTML→MD paste | regex HTML strip = lossy/unsafe |
| `markdown-it` (+types) | 3 | reading-mode render | react-markdown pulls more; markdown-it is lean + lazy-split |

DOMPurify, plugin-opener, plugin-dialog, plugin-clipboard-manager: already present, reused.

## Testing

Per-leg vitest for pure logic (settings merge, smart-lists keymap, turndown/markdown-it helpers, tabs ops, fromPayload ghosts) + Rust unit test for the ghost-node query. Live behaviors that need the app window (vim feel, hover highlight, reading render, tab UX, help PDF open, updates link) are **user eyeball** items per leg, listed in each leg's gate. No new e2e framework.

## Out of scope / deferred

Tauri auto-updater; ghost-node click-to-create; tab drag-reorder / persistence / split-view; GPU label-on-hover + ghost parity (2D is default); edit↔read scroll-sync; in-app changelog; attachments/tags as graph nodes.

## Build order & checkpoints

1 → 2 → 3 → 4 → 5. Legs 1 and 2 are independent and low-risk (start either first). Leg 3 before 4 (reading mode is simpler; "default view" depends on it). Leg 4 gets a `/council` pass before its plan. Each leg: plan → build → gates → commit → user eyeball → next. Version bumps to `0.3.0` when the milestone lands; tag `v2.3`.
