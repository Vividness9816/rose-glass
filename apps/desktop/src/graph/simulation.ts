/* Phase 4 — the graph physics step, extracted as a pure, SEEDABLE function so both
   the canvas-2D and WebGPU renderers share one force model (the mockup's
   cohesion + repulsion + drift + boundary — the visual contract) and so it can be
   exercised deterministically (ADR-20260616: extract the seedable Simulation when
   the WebGPU renderer needs shared, deterministic positions).

   ponytail: this IS the spec's force-directed layout. We keep the mockup's own
   force model rather than importing d3-force, because the mockup is the locked
   visual contract and d3-force would change the look; see docs/decisions.md. */

import type { GraphNode } from './types';

/** Idle-drift amplitude — the graph's continuous "breathing". Tuned so cohesion still
    holds clusters together while every node visibly wanders. */
const DRIFT = 0.06;

/** Deterministic RNG (mulberry32) — seed the jitter so a simulation run is
    reproducible in tests; production uses Math.random. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Advance the layout one tick, mutating node x/y/vx/vy/phase in place. Pure given
    `rng` (defaults to Math.random). W/H are the logical (CSS-px) bounds. */
export function stepSimulation(
  nodes: GraphNode[],
  W: number,
  H: number,
  rng: () => number = Math.random,
): void {
  nodes.forEach((n) => {
    // Continuous organic drift: each node wanders on its OWN seeded phase, so the whole
    // graph keeps gently flowing instead of settling into a frozen equilibrium. A coherent
    // sine survives the velocity damping below; the old ±random jitter averaged to zero and
    // damped out, which is exactly why the graph looked rigid until a node was dragged. Two
    // incommensurate frequencies (1.0 / 0.7) make an organic Lissajous wander, not a straight
    // diagonal. ponytail: DRIFT is the single liveliness dial — raise for more motion.
    n.vx += Math.cos(n.phase) * DRIFT;
    n.vy += Math.sin(n.phase * 0.7 + 1.3) * DRIFT;
    n.vx += (rng() - 0.5) * 0.02; // a touch of noise so the wander isn't perfectly periodic
    n.vy += (rng() - 0.5) * 0.02;
    // cohesion toward the live centroid of cluster mates (resize-safe)
    const mates = nodes.filter((m) => m.cluster === n.cluster && m.id !== n.id);
    if (mates.length) {
      const avgx = mates.reduce((s, m) => s + m.x, 0) / mates.length;
      const avgy = mates.reduce((s, m) => s + m.y, 0) / mates.length;
      n.vx += (avgx - n.x) * 0.003;
      n.vy += (avgy - n.y) * 0.003;
    }
    // collision / repulsion
    nodes.forEach((m) => {
      if (m.id === n.id) return;
      const dx = n.x - m.x;
      const dy = n.y - m.y;
      const d2 = dx * dx + dy * dy;
      const minD = 22 + n.r + m.r;
      if (d2 < minD * minD && d2 > 0.01) {
        const d = Math.sqrt(d2);
        n.vx += (dx / d) * (minD - d) * 0.12;
        n.vy += (dy / d) * (minD - d) * 0.12;
      }
    });
    n.vx *= 0.88;
    n.vy *= 0.88;
    n.x += n.vx;
    n.y += n.vy;
    const pad = 30;
    if (n.x < pad) n.vx += 0.3;
    if (n.x > W - pad) n.vx -= 0.3;
    if (n.y < pad) n.vy += 0.3;
    if (n.y > H - pad) n.vy -= 0.3;
    n.phase += 0.02;
  });
}
