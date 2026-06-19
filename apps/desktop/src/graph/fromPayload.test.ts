import { describe, expect, it } from 'vitest';
import { payloadToGraphData } from './fromPayload';
import type { GraphPayload } from '../ipc';

describe('payloadToGraphData', () => {
  it('maps nodes + edges and resolves path → id', () => {
    const p: GraphPayload = {
      nodes: [
        { path: 'a.md', title: 'Alpha', cluster: null, link_count: 2 },
        { path: 'b.md', title: '', cluster: null, link_count: 0 },
      ],
      edges: [{ src: 'a.md', dst: 'b.md' }],
    };
    const g = payloadToGraphData(p);
    expect(g.nodes).toHaveLength(2);
    expect(g.nodes[0].name).toBe('Alpha');
    expect(g.nodes[1].name).toBe('b.md'); // empty title → path fallback
    expect(g.edges).toEqual([{ a: 0, b: 1, trail: 0.4, flow: 1, activity: 0.5 }]);
  });

  it('drops edges referencing unknown nodes', () => {
    const p: GraphPayload = {
      nodes: [{ path: 'a.md', title: 'A', cluster: null, link_count: 1 }],
      edges: [{ src: 'a.md', dst: 'ghost.md' }],
    };
    expect(payloadToGraphData(p).edges).toHaveLength(0);
  });

  it('carries ghost nodes and keeps edges pointing at them', () => {
    const p: GraphPayload = {
      nodes: [
        { path: 'a.md', title: 'A', cluster: null, link_count: 1, is_ghost: false },
        { path: 'Missing', title: 'Missing', cluster: null, link_count: 0, is_ghost: true },
      ],
      edges: [{ src: 'a.md', dst: 'Missing' }],
    };
    const gd = payloadToGraphData(p);
    const ghost = gd.nodes.find((n) => n.path === 'Missing')!;
    expect(ghost.ghost).toBe(true);
    expect(ghost.hub).toBe(false);
    expect(gd.nodes.find((n) => n.path === 'a.md')!.ghost).toBe(false);
    expect(gd.edges).toHaveLength(1); // edge to the ghost survives (ghost path is in idOf)
  });

  it('spreads clusters into 0..3 when payload clusters are null', () => {
    const nodes = Array.from({ length: 8 }, (_, i) => ({
      path: `n${i}.md`,
      title: `N${i}`,
      cluster: null,
      link_count: 0,
    }));
    const g = payloadToGraphData({ nodes, edges: [] });
    g.nodes.forEach((n) => {
      expect(n.cluster).toBeGreaterThanOrEqual(0);
      expect(n.cluster).toBeLessThan(4);
    });
    expect(new Set(g.nodes.map((n) => n.cluster))).toEqual(new Set([0, 1, 2, 3]));
  });
});
