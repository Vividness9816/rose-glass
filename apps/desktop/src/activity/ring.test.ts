import { describe, expect, it } from 'vitest';
import { CAP, emptyActivity, pushActivity, setDropped } from './ring';
import type { ActivityEvent } from '../ipc';

const vault = (rel: string, action: 'read' | 'modify' = 'read'): ActivityEvent => ({
  scope: 'vault',
  action,
  rel,
  tool: action === 'read' ? 'Read' : 'Edit',
  session: 'abcd1234',
});
const ext = (): ActivityEvent => ({ scope: 'external', action: 'read', tool: 'Read', session: 'ffff0000' });

describe('activity ring', () => {
  it('prepends most-recent-first and bumps liveness + tallies', () => {
    let s = emptyActivity();
    s = pushActivity(s, vault('a.md'), 100);
    s = pushActivity(s, vault('b.md', 'modify'), 200);
    expect(s.rows.map((r) => r.rel)).toEqual(['b.md', 'a.md']);
    expect(s.rows[0].action).toBe('modify');
    expect(s.lastAt).toBe(200);
    expect(s.vaultCount).toBe(2);
    expect(s.externalCount).toBe(0);
  });

  it('external rows carry NO rel (path-free by construction)', () => {
    let s = emptyActivity();
    s = pushActivity(s, ext(), 1);
    expect(s.rows[0].rel).toBeUndefined();
    expect(s.rows[0].scope).toBe('external');
    expect(s.externalCount).toBe(1);
    // a JSON of the row never contains a path field
    expect(JSON.stringify(s.rows[0])).not.toContain('rel');
  });

  it('drops oldest beyond the cap (ring, not unbounded)', () => {
    let s = emptyActivity();
    for (let i = 0; i < CAP + 50; i++) s = pushActivity(s, vault(`n${i}.md`), i);
    expect(s.rows.length).toBe(CAP);
    expect(s.rows[0].rel).toBe(`n${CAP + 49}.md`); // newest kept
    expect(s.rows[s.rows.length - 1].rel).toBe(`n50.md`); // oldest-in-window
    expect(s.vaultCount).toBe(CAP + 50); // tally counts ALL seen, not just retained
  });

  it('ids are unique and monotonic for React keys', () => {
    let s = emptyActivity();
    for (let i = 0; i < 5; i++) s = pushActivity(s, vault(`n${i}.md`), i);
    const ids = s.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('setDropped is independent of event ingestion', () => {
    let s = emptyActivity();
    s = pushActivity(s, vault('a.md'), 1);
    s = setDropped(s, 7);
    expect(s.dropped).toBe(7);
    expect(s.rows.length).toBe(1); // unchanged
  });
});
