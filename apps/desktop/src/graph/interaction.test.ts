import { describe, expect, it } from 'vitest';
import {
  IDENTITY_CAMERA,
  ZOOM_MAX,
  ZOOM_MIN,
  panBy,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from './camera';
import { nodeAtWorld } from './hitTest';
import { makeRng, stepSimulation } from './simulation';
import type { GraphNode } from './types';

function node(id: number, x: number, y: number, r = 6, cluster = 0): GraphNode {
  return { id, path: `n${id}.md`, name: `n${id}`, x, y, vx: 0, vy: 0, cluster, links: 0, phase: 0, r, hub: false };
}

describe('camera', () => {
  it('world↔screen round-trips', () => {
    const c = { tx: 40, ty: -10, zoom: 1.5 };
    const [sx, sy] = worldToScreen(c, 100, 200);
    expect(screenToWorld(c, sx, sy)).toEqual([100, 200]);
  });

  it('zoomAt keeps the world point under the cursor fixed', () => {
    const c = IDENTITY_CAMERA;
    const [ax, ay] = [300, 150];
    const before = screenToWorld(c, ax, ay);
    const z = zoomAt(c, ax, ay, 2);
    const after = screenToWorld(z, ax, ay);
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
    expect(z.zoom).toBe(2);
  });

  it('clamps zoom to [MIN, MAX]', () => {
    expect(zoomAt(IDENTITY_CAMERA, 0, 0, 100).zoom).toBe(ZOOM_MAX);
    expect(zoomAt(IDENTITY_CAMERA, 0, 0, 0.0001).zoom).toBe(ZOOM_MIN);
  });

  it('panBy translates', () => {
    expect(panBy({ tx: 5, ty: 5, zoom: 1 }, 10, -3)).toEqual({ tx: 15, ty: 2, zoom: 1 });
  });
});

describe('hitTest', () => {
  const nodes = [node(0, 100, 100, 6), node(1, 130, 100, 6)];
  it('returns the node whose disc contains the point', () => {
    expect(nodeAtWorld(nodes, 102, 101)?.id).toBe(0);
  });
  it('returns undefined on empty space', () => {
    expect(nodeAtWorld(nodes, 500, 500)).toBeUndefined();
  });
  it('picks the nearer node when two overlap the slack', () => {
    expect(nodeAtWorld(nodes, 128, 100, 10)?.id).toBe(1);
  });
});

describe('simulation', () => {
  it('is deterministic for a fixed seed (seedable Simulation)', () => {
    const a = [node(0, 100, 100), node(1, 200, 120, 6, 0), node(2, 400, 300, 6, 1)];
    const b = a.map((n) => ({ ...n }));
    const ra = makeRng(42);
    const rb = makeRng(42);
    for (let i = 0; i < 30; i++) {
      stepSimulation(a, 800, 600, ra);
      stepSimulation(b, 800, 600, rb);
    }
    expect(a.map((n) => [n.x, n.y])).toEqual(b.map((n) => [n.x, n.y]));
  });

  it('keeps nodes from flying off (boundary nudge)', () => {
    const nodes = [node(0, -500, -500), node(1, 5000, 5000)];
    const rng = makeRng(1);
    for (let i = 0; i < 200; i++) stepSimulation(nodes, 800, 600, rng);
    // velocities stay finite / bounded (no NaN blow-up)
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });
});
