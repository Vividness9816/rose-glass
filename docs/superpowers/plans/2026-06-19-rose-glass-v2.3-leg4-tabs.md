# Rose Glass v2.3 — Leg 4: Multi-document tabs — Implementation Plan

> Built against **ADR-20260619-rose-glass-v2.3-tabs-architecture**. TDD the pure `tabs.ts`; the Shell wiring is tsc+build+eyeball-verified (the unchanged save machinery keeps its existing `logic.test.ts` coverage).

**Goal:** A note/binary tab bar above the editor. The single editable buffer + path-keyed save machinery stay UNCHANGED; tabs are a thin list layer. "Always focus new tabs" + per-tab default view honored.

**Architecture (ADR):** `Tab = {id, kind:'note'|'binary', path, mode:'edit'|'read'}`; `TabsState = {tabs, activeId}` in plain `useState` in Shell. List transitions extracted to a pure tested `shell/tabs.ts` (splitLogic precedent). Activating a tab calls the existing `openNote(path)`/`openBinary(rel)` (flush-then-reread inside). Per-tab `mode` lives on the Tab; EditorPane takes it as a prop. Reject per-tab buffers/saver/reducer/context.

## Global Constraints
- Commands from `apps/desktop`. Gates: tsc 0 · vitest · vite build 0. Conventional commits + footers + ` # self-audit-ok`. Branch `feat/v2.3`. No new deps.
- **Binding (ADR):** R2 (MUST) closing the active tab flushes before the active path changes — satisfied because close computes the neighbor then calls `openNote(neighbor.path)` (flush is inside openNote). R1 (SHOULD) shutdown flush. R3 (SHOULD) awaitable flush.
- Deferred (NOT this leg): tab persistence (+ `validateTabs`), drag-reorder, split-view, per-tab cursor/undo.

## File structure
- Create `src/shell/tabs.ts` — `Tab`, `TabsState`, `openTab`/`closeTab`/`activateTab`/`setTabMode`/`activeTab`. Pure.
- Create `src/shell/tabs.test.ts`.
- Create `src/shell/TabBar.tsx` — the tab strip (reuses terminal-tab CSS vocabulary).
- Modify `src/shell/Shell.tsx` — tabs state + `openInTab`/`activate`/`close` wiring; route all open-callers through `openInTab`; render TabBar; pass active tab's `mode` to EditorPane; R1 shutdown flush.
- Modify `src/editor/logic.ts` — make `makeDebouncedSaver().flush()` return the in-flight write promise (R3).
- Modify `src/shell/EditorPane.tsx` — take `mode` + `onToggleMode` props; drop local mode state.
- Modify `src/shell/shell.css` — `.editor-tabs` strip (or reuse terminal-tab classes).

---

## Task 1: Pure `shell/tabs.ts` (TDD)

**Produces:** `Tab`, `TabKind`, `TabsState`, `EMPTY_TABS`, `openTab(state, spec, nextId, focusNew)`, `closeTab(state, id)`, `activateTab(state, id)`, `setTabMode(state, id, mode)`, `activeTab(state)`.

- [ ] Write `src/shell/tabs.test.ts` covering: openTab dedups by path (focuses existing, no new tab); openTab with focusNew=true activates the new tab; focusNew=false keeps the active tab (background add) but a first tab always activates; closeTab of the active tab picks the right neighbor (prefer the tab that shifts into its index, else the previous); closeTab of the last tab → activeId null; closeTab of a non-active tab keeps active; setTabMode flips only the target; activeTab returns the active record or null.
- [ ] Run → fail. Implement `tabs.ts`:

```ts
// src/shell/tabs.ts
/* Pure tab-list transitions (ADR-20260619). The single editable buffer + save machinery live
   in Shell unchanged; this module only owns WHICH paths are open + the active cursor.
   splitLogic.ts shape: pure, unit-tested. Persistence (validateTabs) deferred with that leg. */
export type TabKind = 'note' | 'binary';
export interface Tab { id: number; kind: TabKind; path: string; mode: 'edit' | 'read'; }
export interface TabsState { tabs: Tab[]; activeId: number | null; }
export const EMPTY_TABS: TabsState = { tabs: [], activeId: null };

export function activeTab(state: TabsState): Tab | null {
  return state.tabs.find((t) => t.id === state.activeId) ?? null;
}

/** Open a path. Dedup: if already open, focus it. Else append a tab; it becomes active when
    focusNew OR there's no active tab. `activate` = the id whose path the caller must load into
    the buffer (null = leave the active buffer alone, a background add). */
export function openTab(
  state: TabsState,
  spec: { path: string; kind: TabKind; mode: 'edit' | 'read' },
  nextId: number,
  focusNew: boolean,
): { state: TabsState; activate: number | null } {
  const existing = state.tabs.find((t) => t.path === spec.path);
  if (existing) return { state: { ...state, activeId: existing.id }, activate: existing.id };
  const tab: Tab = { id: nextId, kind: spec.kind, path: spec.path, mode: spec.mode };
  const tabs = [...state.tabs, tab];
  if (focusNew || state.activeId === null) return { state: { tabs, activeId: tab.id }, activate: tab.id };
  return { state: { tabs, activeId: state.activeId }, activate: null };
}

/** Close a tab. If it was active, pick the neighbor (the tab that shifts into its index, else
    the previous, else none). `activate` = id to load (null = no tabs → empty state). */
export function closeTab(state: TabsState, id: number): { state: TabsState; activate: number | null; wasActive: boolean } {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return { state, activate: null, wasActive: false };
  const wasActive = state.activeId === id;
  const tabs = state.tabs.filter((t) => t.id !== id);
  if (!wasActive) return { state: { tabs, activeId: state.activeId }, activate: null, wasActive: false };
  const neighbor = tabs[idx] ?? tabs[idx - 1] ?? null;
  return { state: { tabs, activeId: neighbor?.id ?? null }, activate: neighbor?.id ?? null, wasActive: true };
}

export function activateTab(state: TabsState, id: number): TabsState {
  return state.tabs.some((t) => t.id === id) ? { ...state, activeId: id } : state;
}
export function setTabMode(state: TabsState, id: number, mode: 'edit' | 'read'): TabsState {
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, mode } : t)) };
}
```
- [ ] Run → pass. Commit `tabs.ts` + `tabs.test.ts`.

---

## Task 2: `TabBar` component

**Produces:** `TabBar({ tabs, activeId, onActivate, onClose })`.

- [ ] Write `src/shell/TabBar.tsx` — a horizontal strip rendering each tab (name = `path.split('/').pop()`, an Icon by kind: `file` for note/binary; active class), click → onActivate(id), a close × → onClose(id) (stopPropagation). Reuse the terminal-tab CSS vocabulary (`.terminal-tab`/`.terminal-tab-close` analogues, new `.editor-tab*` classes). Empty tabs → render nothing.
- [ ] Add `.editor-tabs` strip CSS to `shell.css` (token-driven; mirror `.terminal-tabs`).
- [ ] tsc + build. Commit.

---

## Task 3: Awaitable flush (R3) + shutdown flush (R1)

- [ ] In `editor/logic.ts`, make `makeDebouncedSaver` expose `flush(): Promise<void>` that returns the in-flight `save()` promise (today `fire()` calls `save` without awaiting). Keep `schedule`/`cancel`. Update the one caller pattern (`saver.flush()` in `openNote`/`openBinary`) to `await saver.flush()` before the re-read.
- [ ] Extend `logic.test.ts`: `flush()` resolves after the pending write's promise settles.
- [ ] In Shell, register a Tauri `onCloseRequested` handler (lazy `@tauri-apps/api/window`) that `await saver.flush()` before allowing close (best-effort; guard non-Tauri). Commit.

---

## Task 4: Wire tabs into Shell

- [ ] Add `const [tabsState, setTabsState] = useState<TabsState>(EMPTY_TABS);` + `nextTabIdRef`. Read `settings.alwaysFocusNewTabs` + `settings.defaultView` via `useSettings` (Shell already has access through props? — import `useSettings`).
- [ ] Add `openInTab(path, kind)`: compute `openTab(tabsState, {path, kind, mode: kind==='note' ? settings.defaultView : 'edit'}, nextTabIdRef.current, settings.alwaysFocusNewTabs)`; bump nextTabIdRef when a new tab was added; `setTabsState(r.state)`; if `r.activate != null` and it maps to this path → `void openNote(path)` (note) / `openBinary(path)` (binary). Route ALL existing open-callers through `openInTab` (onWikiClick, onOpenGraphNode, NotesPane onOpen, palette onOpenNote, onOpenFile, ingest/drag-drop/OS-open results, onEditAsMarkdown sibling, onNewNote). `openNote`/`openBinary` themselves stay as the buffer-loaders.
- [ ] Add `activate(id)`: `setTabsState(activateTab(tabsState, id))`; find the tab; `void openNote(t.path)`/`openBinary(t.path)` by kind.
- [ ] Add `close(id)`: `const r = closeTab(tabsState, id); setTabsState(r.state); if (r.wasActive) { if (r.activate != null) { const t = r.state.tabs.find(x=>x.id===r.activate)!; load it } else { clear buffer to empty state — flush first via openNote-less path } }`. (Closing the active tab loads the neighbor through openNote, which flushes R2; closing the LAST tab must `await saver.flush()` then clear note/doc/binary to the empty state.)
- [ ] `index:note` delete branch: when the open note is deleted, also `closeTab` its tab.
- [ ] Render `<TabBar tabs={tabsState.tabs} activeId={tabsState.activeId} onActivate={activate} onClose={close} />` above the editor pane (only when railView is the editor view + tabs.length > 0).
- [ ] Pass the active tab's `mode` + an `onToggleMode` to EditorPane.
- [ ] tsc + vitest + build. Commit.

---

## Task 5: Per-tab mode in EditorPane

- [ ] EditorPane: replace local `mode` state + the seeding effect with `mode` + `onToggleMode` props (from the active tab). The Edit/Read button calls `onToggleMode`. tsc + build. Commit.

---

## Task 6: Leg gates + push
- [ ] `pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm exec vite build` green. Push.
- [ ] Eyeball (deferred to end-of-milestone per user): open several notes → tabs appear; click switches; × closes (neighbor activates); "Always focus new tabs" off → new opens stay background; per-tab Edit/Read sticks per tab; closing the last tab → empty state; no data loss on rapid switch/close.

## Self-Review
Covers ADR decision (single buffer + pure tabs.ts + mode-on-tab) + R1/R2/R3. Per-tab buffers/reducer/context correctly absent. Persistence/validateTabs/reorder deferred. The Shell wiring is the risk; the save machinery is untouched so `logic.test.ts` still guards it, and `tabs.ts` transitions are unit-tested.
