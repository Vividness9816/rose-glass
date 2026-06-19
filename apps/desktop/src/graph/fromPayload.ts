import type { GraphData, GraphEdge, GraphNode } from './types';
import type { GraphPayload } from '../ipc';

/** Map the backend's DERIVED graph meta to the renderer's GraphData. The backend
 *  owns derived facts (title, cluster, link_count); the frontend owns ALL render
 *  state (x/y/vx/vy/phase/r/hub) — seeded here, then driven by the physics loop. */
export function payloadToGraphData(p: GraphPayload): GraphData {
  const idOf = new Map<string, number>();
  const maxLinks = Math.max(1, ...p.nodes.map((n) => n.link_count));

  const nodes: GraphNode[] = p.nodes.map((n, i) => {
    idOf.set(n.path, i);
    const ghost = !!n.is_ghost;
    return {
      id: i,
      path: n.path,
      name: n.title || n.path,
      // scatter so physics doesn't start from a degenerate all-at-origin stack
      x: 100 + Math.random() * 600,
      y: 80 + Math.random() * 440,
      vx: 0,
      vy: 0,
      phase: Math.random() * Math.PI * 2,
      cluster: (n.cluster ?? i) % 4, // clusters empty this phase → spread 0..3 by index
      links: ghost ? 0 : n.link_count,
      r: ghost ? 4 : 4 + 7 * (n.link_count / maxLinks),
      hub: !ghost && n.link_count >= maxLinks * 0.66, // a ghost never renders as a hub
      ghost,
    };
  });

  const edges: GraphEdge[] = p.edges
    .filter((e) => idOf.has(e.src) && idOf.has(e.dst))
    .map((e) => ({
      a: idOf.get(e.src)!,
      b: idOf.get(e.dst)!,
      trail: 0.4,
      flow: 1,
      activity: 0.5,
    }));

  return { nodes, edges };
}
