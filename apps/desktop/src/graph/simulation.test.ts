import { describe, it, expect } from 'vitest';
import { makeRng, stepSimulation } from './simulation';
import { DEFAULT_CONFIG, type GraphConfig } from './config';
import type { GraphNode } from './types';

function node(id: number, x: number, y: number, cluster = 0): GraphNode {
  return { id, path: `n${id}`, name: `n${id}`, x, y, vx: 0, vy: 0, cluster, links: 0, phase: 0.5, r: 5, hub: false, ghost: false };
}

function run(nodes: GraphNode[], steps: number, cfg: GraphConfig, seed = 1): void {
  const rng = makeRng(seed);
  for (let i = 0; i < steps; i++) stepSimulation(nodes, 800, 600, rng, cfg);
}

describe('stepSimulation honors GraphConfig', () => {
  it('fixed mode holds a lone node still; free drifts it', () => {
    const fixed = [node(0, 400, 300)];
    run(fixed, 120, { ...DEFAULT_CONFIG, mode: 'fixed' });
    const dFixed = Math.hypot(fixed[0].x - 400, fixed[0].y - 300);

    const free = [node(0, 400, 300)];
    run(free, 120, DEFAULT_CONFIG);
    const dFree = Math.hypot(free[0].x - 400, free[0].y - 300);

    expect(dFixed).toBeLessThan(0.001); // no forces in fixed mode → it cannot move
    expect(dFree).toBeGreaterThan(dFixed);
  });

  it('centerPull holds an off-centre node near the centre while drift keeps it moving (hold, not freeze)', () => {
    // centre of an 800x600 field is (400,300); start far out at (740,80).
    const held = [node(0, 740, 80)];
    run(held, 240, { ...DEFAULT_CONFIG, centerPull: 0.003 });
    const dHeld = Math.hypot(held[0].x - 400, held[0].y - 300);

    const loose = [node(0, 740, 80)];
    run(loose, 240, { ...DEFAULT_CONFIG, centerPull: 0 });
    const dLoose = Math.hypot(loose[0].x - 400, loose[0].y - 300);

    expect(dHeld).toBeLessThan(dLoose); // the pull brings it back toward centre
    expect(dHeld).toBeLessThan(200); // and holds it reasonably near
    expect(Math.hypot(held[0].vx, held[0].vy)).toBeGreaterThan(0); // still moving — not frozen
  });

  it('repulsion 0 leaves overlapping nodes overlapping; nonzero pushes them apart', () => {
    const sep = (repulsion: number) => {
      const ns = [node(0, 400, 300), node(1, 402, 300)];
      // isolate the collision term: no drift/gravity/noise
      run(ns, 80, { ...DEFAULT_CONFIG, repulsion, drift: 0, gravity: 0, mode: 'fixed' });
      return Math.hypot(ns[0].x - ns[1].x, ns[0].y - ns[1].y);
    };
    expect(sep(0)).toBeLessThan(3); // started 2px apart, no push → still overlapping
    expect(sep(0.3)).toBeGreaterThan(20); // pushed out toward the min-distance
  });
});
