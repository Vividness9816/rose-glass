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
      cluster_count: 0,
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
      cluster_count: 0,
    };
    expect(payloadToGraphData(p).edges).toHaveLength(0);
  });

  it('spreads clusters into 0..3 when payload clusters are null', () => {
    const nodes = Array.from({ length: 8 }, (_, i) => ({
      path: `n${i}.md`,
      title: `N${i}`,
      cluster: null,
      link_count: 0,
    }));
    const g = payloadToGraphData({ nodes, edges: [], cluster_count: 0 });
    g.nodes.forEach((n) => {
      expect(n.cluster).toBeGreaterThanOrEqual(0);
      expect(n.cluster).toBeLessThan(4);
    });
    expect(new Set(g.nodes.map((n) => n.cluster))).toEqual(new Set([0, 1, 2, 3]));
  });
});
