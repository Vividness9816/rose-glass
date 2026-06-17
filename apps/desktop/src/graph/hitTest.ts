/* Phase 4 — pure node hit-testing in WORLD coords (caller converts a screen point
   via camera.screenToWorld first). Returns the nearest node whose disc (radius +
   slack) contains the point, or undefined. No DOM — unit-testable. */

import type { GraphNode } from './types';

/** Nearest node under a world point, within its radius + `slack` px (slack eases
    clicking small nodes). Ties broken by smallest distance. */
export function nodeAtWorld(
  nodes: GraphNode[],
  wx: number,
  wy: number,
  slack = 5,
): GraphNode | undefined {
  let best: GraphNode | undefined;
  let bestD = Infinity;
  for (const n of nodes) {
    const d = Math.hypot(n.x - wx, n.y - wy);
    if (d <= n.r + slack && d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}
