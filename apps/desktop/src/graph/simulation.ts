/* Phase 4 — the graph physics step, extracted as a pure, SEEDABLE function so both
   the canvas-2D and WebGPU renderers share one force model (the mockup's
   cohesion + repulsion + drift + boundary — the visual contract) and so it can be
   exercised deterministically (ADR-20260616: extract the seedable Simulation when
   the WebGPU renderer needs shared, deterministic positions).

   ponytail: this IS the spec's force-directed layout. We keep the mockup's own
   force model rather than importing d3-force, because the mockup is the locked
   visual contract and d3-force would change the look; see docs/decisions.md. */

import type { GraphNode } from './types';
import { DEFAULT_CONFIG, type GraphConfig } from './config';

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
    `rng` (defaults to Math.random). W/H are the logical (CSS-px) bounds. `cfg` supplies
    the user-tunable physics; DEFAULT_CONFIG reproduces the v1.0 hardcoded model exactly. */
export function stepSimulation(
  nodes: GraphNode[],
  W: number,
  H: number,
  rng: () => number = Math.random,
  cfg: GraphConfig = DEFAULT_CONFIG,
): void {
  // 'fixed' mode: kill the idle drift + noise and damp hard so nodes settle into their
  // gravity/repulsion equilibrium and HOLD (still draggable), instead of free-floating.
  const fixed = cfg.mode === 'fixed';
  const drift = fixed ? 0 : cfg.drift;
  const damping = fixed ? 0.6 : cfg.damping;
  nodes.forEach((n) => {
    // Continuous organic drift: each node wanders on its OWN seeded phase, so the whole
    // graph keeps gently flowing instead of settling into a frozen equilibrium. Two
    // incommensurate frequencies (1.0 / 0.7) make an organic Lissajous wander, not a straight
    // diagonal. `drift` is the user's "node movement" dial (0 in fixed mode).
    n.vx += Math.cos(n.phase) * drift;
    n.vy += Math.sin(n.phase * 0.7 + 1.3) * drift;
    if (!fixed) {
      n.vx += (rng() - 0.5) * 0.02; // a touch of noise so the wander isn't perfectly periodic
      n.vy += (rng() - 0.5) * 0.02;
    }
    // cohesion (the "gravity" dial) toward the live centroid of cluster mates (resize-safe)
    const mates = nodes.filter((m) => m.cluster === n.cluster && m.id !== n.id);
    if (mates.length) {
      const avgx = mates.reduce((s, m) => s + m.x, 0) / mates.length;
      const avgy = mates.reduce((s, m) => s + m.y, 0) / mates.length;
      n.vx += (avgx - n.x) * cfg.gravity;
      n.vy += (avgy - n.y) * cfg.gravity;
    }
    // collision / repulsion (the "node strength" dial)
    nodes.forEach((m) => {
      if (m.id === n.id) return;
      const dx = n.x - m.x;
      const dy = n.y - m.y;
      const d2 = dx * dx + dy * dy;
      const minD = 22 + n.r + m.r;
      if (d2 < minD * minD && d2 > 0.01) {
        const d = Math.sqrt(d2);
        n.vx += (dx / d) * (minD - d) * cfg.repulsion;
        n.vy += (dy / d) * (minD - d) * cfg.repulsion;
      }
    });
    n.vx *= damping;
    n.vy *= damping;
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
