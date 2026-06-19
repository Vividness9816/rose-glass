import { describe, it, expect } from 'vitest';
import { EMPTY_TABS, openTab, closeTab, activateTab, setTabMode, activeTab, type TabsState } from './tabs';

const note = (path: string, mode: 'edit' | 'read' = 'edit') =>
  ({ path, kind: 'note' as const, mode });

describe('openTab', () => {
  it('adds + activates the first tab regardless of focusNew', () => {
    const r = openTab(EMPTY_TABS, note('a.md'), 1, false);
    expect(r.state.tabs.map((t) => t.path)).toEqual(['a.md']);
    expect(r.state.activeId).toBe(1);
    expect(r.activate).toBe(1);
  });

  it('dedups by path: opening an already-open path focuses it (no new tab)', () => {
    const s1 = openTab(EMPTY_TABS, note('a.md'), 1, true).state;
    const s2 = openTab(s1, note('b.md'), 2, true).state;
    const r = openTab(s2, note('a.md'), 3, true);
    expect(r.state.tabs).toHaveLength(2); // no third tab
    expect(r.state.activeId).toBe(1);
    expect(r.activate).toBe(1);
  });

  it('focusNew=true activates the new tab; focusNew=false keeps the active one (background add)', () => {
    const s1 = openTab(EMPTY_TABS, note('a.md'), 1, true).state;
    const focus = openTab(s1, note('b.md'), 2, true);
    expect(focus.state.activeId).toBe(2);
    expect(focus.activate).toBe(2);
    const bg = openTab(s1, note('c.md'), 3, false);
    expect(bg.state.activeId).toBe(1); // stays on a.md
    expect(bg.activate).toBeNull(); // don't load the background tab
    expect(bg.state.tabs).toHaveLength(2);
  });
});

describe('closeTab', () => {
  const three = (): TabsState => {
    let s = openTab(EMPTY_TABS, note('a.md'), 1, true).state;
    s = openTab(s, note('b.md'), 2, true).state;
    s = openTab(s, note('c.md'), 3, true).state; // active = c (id 3)
    return s;
  };

  it('closing the active tab activates the right neighbor (the one that shifts into its index)', () => {
    let s = three();
    s = activateTab(s, 2); // active = b (middle)
    const r = closeTab(s, 2);
    expect(r.wasActive).toBe(true);
    expect(r.state.tabs.map((t) => t.path)).toEqual(['a.md', 'c.md']);
    expect(r.activate).toBe(3); // c shifted into b's index
    expect(r.state.activeId).toBe(3);
  });

  it('closing the active LAST tab falls back to the previous', () => {
    const r = closeTab(three(), 3); // active was c (last)
    expect(r.activate).toBe(2); // b
  });

  it('closing the only tab → activeId null (empty state)', () => {
    const s = openTab(EMPTY_TABS, note('a.md'), 1, true).state;
    const r = closeTab(s, 1);
    expect(r.wasActive).toBe(true);
    expect(r.state.tabs).toHaveLength(0);
    expect(r.activate).toBeNull();
    expect(r.state.activeId).toBeNull();
  });

  it('closing a NON-active tab keeps the active one and does not reload', () => {
    const r = closeTab(three(), 1); // close a.md while c is active
    expect(r.wasActive).toBe(false);
    expect(r.activate).toBeNull();
    expect(r.state.activeId).toBe(3);
    expect(r.state.tabs.map((t) => t.path)).toEqual(['b.md', 'c.md']);
  });
});

describe('setTabMode / activeTab', () => {
  it('setTabMode flips only the target tab', () => {
    let s = openTab(EMPTY_TABS, note('a.md'), 1, true).state;
    s = openTab(s, note('b.md'), 2, true).state;
    s = setTabMode(s, 1, 'read');
    expect(s.tabs.find((t) => t.id === 1)!.mode).toBe('read');
    expect(s.tabs.find((t) => t.id === 2)!.mode).toBe('edit');
  });

  it('activeTab returns the active record or null', () => {
    const s = openTab(EMPTY_TABS, note('a.md'), 1, true).state;
    expect(activeTab(s)!.path).toBe('a.md');
    expect(activeTab(EMPTY_TABS)).toBeNull();
  });
});
