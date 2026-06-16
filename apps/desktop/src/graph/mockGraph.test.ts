import { describe, expect, it } from 'vitest';
import { buildMockGraph } from './mockGraph';

describe('buildMockGraph', () => {
  it('builds 22 nodes across 4 clusters (6,6,5,5)', () => {
    const g = buildMockGraph(1000, 800);
    expect(g.nodes).toHaveLength(22);
    const counts = [0, 0, 0, 0];
    g.nodes.forEach((n) => counts[n.cluster]++);
    expect(counts).toEqual([6, 6, 5, 5]);
  });

  it('assigns unique sequential ids', () => {
    const g = buildMockGraph(1000, 800);
    const ids = g.nodes.map((n) => n.id).sort((a, b) => a - b);
    expect(ids).toEqual([...Array(22).keys()]);
  });

  it('produces only valid, non-self edges', () => {
    const g = buildMockGraph(1000, 800);
    expect(g.edges.length).toBeGreaterThan(0);
    g.edges.forEach((e) => {
      expect(e.a).not.toBe(e.b);
      expect(g.nodes[e.a]).toBeDefined();
      expect(g.nodes[e.b]).toBeDefined();
    });
  });

  it('guarantees at least the two override hubs', () => {
    const g = buildMockGraph(1000, 800);
    expect(g.nodes[0].hub).toBe(true);
    expect(g.nodes[6].hub).toBe(true);
  });
});
