/* Resolves graph colors from the token layer at runtime, so the canvas
   renders with var(--cluster-N)/var(--graph-*) and NEVER a hex literal.
   This is the de-hardcode fix the council required: re-theming the app
   re-themes the graph with zero renderer edits.

   getComputedStyle does not substitute var() chains for custom properties,
   so we resolve through a hidden probe element's `color` (always rgb()). */

export type RGB = [number, number, number];

export interface GraphTheme {
  bg: string;
  bgRgb: RGB; // same as bg, kept as a triple so the canvas can fill it translucent (let the §21 backdrop through)
  nodeCore: string;
  nodeCoreRgb: RGB; // the core colour as a triple, so the inverted bullseye can use it for rings
  invertNodes: boolean; // light theme: swap cluster-colour ↔ ink across the node bullseye
  clusters: { accent: string; rgb: RGB }[];
  crossEdge: RGB;
  label: RGB;
  activityRead: RGB; // Phase 8 — CC read lights a node (violet pulse)
  activityModify: RGB; // Phase 8 — CC modify lights a node (rose flare)
}

let probe: HTMLDivElement | null = null;

function resolve(expr: string): RGB {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;opacity:0;pointer-events:none;width:0;height:0';
    document.body.appendChild(probe);
  }
  probe.style.color = '';
  probe.style.color = expr;
  const m = getComputedStyle(probe).color.match(/[\d.]+/g);
  if (!m || m.length < 3) return [255, 255, 255];
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}

export function rgba(c: RGB, a: number): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

export function resolveGraphTheme(): GraphTheme {
  const clusters = [0, 1, 2, 3].map((i) => {
    const rgb = resolve(`var(--cluster-${i})`);
    return { accent: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`, rgb };
  });
  const bg = resolve('var(--graph-bg)');
  const core = resolve('var(--graph-node-core)');
  // numeric flag, so the bullseye inversion lives in the token layer (A10), not the renderer
  const invertNodes =
    getComputedStyle(document.documentElement).getPropertyValue('--graph-node-invert').trim() === '1';
  return {
    bg: `rgb(${bg[0]},${bg[1]},${bg[2]})`,
    bgRgb: bg,
    nodeCore: `rgb(${core[0]},${core[1]},${core[2]})`,
    nodeCoreRgb: core,
    invertNodes,
    clusters,
    crossEdge: resolve('var(--graph-cross-edge)'),
    label: resolve('var(--text-1)'),
    activityRead: resolve('var(--violet)'),
    activityModify: resolve('var(--rose)'),
  };
}
