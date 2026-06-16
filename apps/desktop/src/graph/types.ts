/* CPU mirror of the graph. Nodes = notes, edges = resolved links.
   This is a VIEW of derived state (§8) — in v1.0 it is built from the
   indexer; in this increment it is built from mock data (mockGraph.ts). */

export interface GraphNode {
  id: number;
  name: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  cluster: number; // 0..3 → --cluster-N
  links: number;
  phase: number; // per-node breathing offset
  r: number; // radius (scales with link count)
  hub: boolean;
}

export interface GraphEdge {
  a: number; // node id
  b: number; // node id
  trail: number; // 0..1 edge strength / glow
  flow: number; // +1 / -1 particle direction
  activity: number; // 0..1
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
