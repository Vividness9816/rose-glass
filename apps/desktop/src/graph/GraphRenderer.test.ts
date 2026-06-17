import { describe, expect, it } from 'vitest';
import { indexNodesByPath, lookupNodeByRel } from './GraphRenderer';
import type { GraphNode } from './types';

function node(path: string): GraphNode {
  return {
    id: 0,
    path,
    name: path,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    cluster: 0,
    links: 0,
    phase: 0,
    r: 4,
    hub: false,
  };
}

describe('activity node lookup (Phase 8 review fix F1)', () => {
  it('matches exact rel', () => {
    const idx = indexNodesByPath([node('Notes/Foo.md'), node('bar.md')]);
    expect(lookupNodeByRel(idx, 'Notes/Foo.md')?.path).toBe('Notes/Foo.md');
  });

  it('matches case-folded when CC reports a different casing than the index key', () => {
    // index has on-disk casing 'Notes/Foo.md'; CC logs 'notes/foo.md' (Windows FS)
    const idx = indexNodesByPath([node('Notes/Foo.md')]);
    expect(lookupNodeByRel(idx, 'notes/foo.md')?.path).toBe('Notes/Foo.md');
  });

  it('prefers an exact match over the folded fallback', () => {
    const idx = indexNodesByPath([node('a.md'), node('A.md')]);
    expect(lookupNodeByRel(idx, 'A.md')?.path).toBe('A.md');
    expect(lookupNodeByRel(idx, 'a.md')?.path).toBe('a.md');
  });

  it('returns undefined for a non-node rel (in-vault non-note file)', () => {
    const idx = indexNodesByPath([node('a.md')]);
    expect(lookupNodeByRel(idx, 'assets/pic.png')).toBeUndefined();
  });
});
