/* Mock GraphData — the mockup's node/cluster/edge construction
   (vaultforge-design.html lines 949–984), returned as data instead of
   mutating globals. Drives the graph until the real indexer lands (Phase 2/4).
   ponytail: Math.random ambient seeding kept un-seeded — the physics is
   decorative motion, not a correctness surface. Seedable extraction lands
   when the WebGPU renderer needs deterministic shared positions. */

import type { GraphData, GraphEdge, GraphNode } from './types';

const NOTE_NAMES = [
  'synaptic pruning', 'neural plasticity', "Hebb's rule", 'long-term potentiation',
  'prefrontal cortex', 'critical period', 'memory consolidation', 'REM sleep',
  'free will', 'consciousness', 'qualia', 'emergence theory',
  'feedback loops', 'complex systems', 'strange attractors', 'chaos theory',
  'schizophrenia', 'autism spectrum', 'C4A gene', 'dopamine hypothesis',
];

function shuffle<T>(arr: T[]): T[] {
  const r = [...arr];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

export function buildMockGraph(W: number, H: number): GraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const cx = [W * 0.28, W * 0.62, W * 0.32, W * 0.68];
  const cy = [H * 0.38, H * 0.32, H * 0.68, H * 0.65];

  let ni = 0;
  for (let ci = 0; ci < 4; ci++) {
    const count = ci < 2 ? 6 : 5;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const r = 38 + Math.random() * 50;
      nodes.push({
        id: ni,
        path: `mock/${ni++}.md`, // synthetic — never matches a real activity rel
        name: NOTE_NAMES[(ci * 6 + i) % NOTE_NAMES.length],
        x: cx[ci] + Math.cos(a) * r + (Math.random() - 0.5) * 20,
        y: cy[ci] + Math.sin(a) * r + (Math.random() - 0.5) * 20,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        cluster: ci,
        links: Math.floor(Math.random() * 5),
        phase: Math.random() * Math.PI * 2,
        r: 4 + Math.random() * 3,
        hub: false,
      });
    }
  }

  const edgeEx = (a: number, b: number) =>
    edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));

  nodes.forEach((n) => {
    const mates = nodes.filter((m) => m.id !== n.id && m.cluster === n.cluster);
    shuffle(mates)
      .slice(0, 2 + Math.floor(Math.random() * 2))
      .forEach((m) => {
        if (!edgeEx(n.id, m.id)) {
          edges.push({
            a: n.id,
            b: m.id,
            trail: 0.3 + Math.random() * 0.4,
            flow: Math.random() < 0.6 ? 1 : -1,
            activity: 0.5 + Math.random() * 0.5,
          });
        }
      });
    if (Math.random() < 0.25) {
      const cross = nodes.filter((m) => m.cluster !== n.cluster);
      const t = cross[Math.floor(Math.random() * cross.length)];
      if (t && !edgeEx(n.id, t.id)) {
        edges.push({ a: n.id, b: t.id, trail: 0.15, flow: 1, activity: 0.3 });
      }
    }
  });

  // radius scales with link count; hubs are the densely-linked nodes
  nodes.forEach((n) => {
    n.r = n.links >= 4 ? 11 : 4 + n.links * 0.5;
    n.hub = n.links >= 4;
  });
  // guarantee two visible hubs (mockup override)
  [0, 6].forEach((id) => {
    if (nodes[id]) {
      nodes[id].hub = true;
      nodes[id].r = 11;
    }
  });

  return { nodes, edges };
}
