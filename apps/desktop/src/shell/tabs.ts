/* Pure tab-list transitions (ADR-20260619-rose-glass-v2.3-tabs-architecture). The single
   editable buffer + the path-keyed save machinery live in Shell UNCHANGED; this module only
   owns WHICH paths are open + the active cursor. splitLogic.ts shape: pure, unit-tested.
   Persistence (a validateTabs clamp-on-read) is deferred to the persistence leg. */

export type TabKind = 'note' | 'binary';
export interface Tab {
  id: number;
  kind: TabKind;
  path: string;
  mode: 'edit' | 'read';
}
export interface TabsState {
  tabs: Tab[];
  activeId: number | null;
}

export const EMPTY_TABS: TabsState = { tabs: [], activeId: null };

export function activeTab(state: TabsState): Tab | null {
  return state.tabs.find((t) => t.id === state.activeId) ?? null;
}

/** Open a path. Dedup: if already open, focus it (no new tab). Else append a tab; it becomes
    active when `focusNew` OR there is no active tab yet. `activate` = the id whose path the
    caller must load into the buffer (null = leave the active buffer alone — a background add). */
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
    the previous, else none). `activate` = id to load into the buffer (null = no tabs left →
    empty state). `wasActive` tells the caller whether the active buffer must change. */
export function closeTab(
  state: TabsState,
  id: number,
): { state: TabsState; activate: number | null; wasActive: boolean } {
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
