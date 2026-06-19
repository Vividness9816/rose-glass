/* v2.0 — user-tunable graph physics + colors. One config object feeds the SHARED
   stepSimulation, so both the canvas-2D and WebGPU renderers honor it identically.
   Persisted to localStorage. Defaults reproduce the v1.0 force model EXCEPT for v2.2's
   gentle centerPull (a small centripetal hold so the system orbits a fixed centre,
   "solar system", instead of drifting); set centerPull:0 for the exact v1.0 free-drift. */

export interface GraphConfig {
  /** Cohesion pull toward a node's cluster centroid (the "gravity" dial). v1.0: 0.003. */
  gravity: number;
  /** Collision push strength when nodes overlap (the "node strength" dial). v1.0: 0.12. */
  repulsion: number;
  /** Idle-wander amplitude — the graph's breathing (the "node movement" dial). v1.0: 0.06. */
  drift: number;
  /** Velocity retained per tick (higher = livelier/looser, lower = settles faster). v1.0: 0.88. */
  damping: number;
  /** v2.2 — centripetal pull toward the live canvas centre. Holds the whole system around a
      fixed point ("solar system") while drift/cohesion/collision keep nodes moving. 0 =
      v1.0 free-drift (only the boundary box held it in). Has no effect in 'fixed' mode. */
  centerPull: number;
  /** Per-cluster color overrides for --cluster-0..3 (hex; '' = keep the theme default). */
  clusterColors: [string, string, string, string];
  /** 'free' = live idle drift (v1.0). 'fixed' = no drift + heavy damping → settle and hold. */
  mode: 'free' | 'fixed';
}

export const DEFAULT_CONFIG: GraphConfig = {
  gravity: 0.003,
  repulsion: 0.12,
  drift: 0.06,
  damping: 0.88,
  centerPull: 0.0015,
  clusterColors: ['', '', '', ''],
  mode: 'free',
};

const KEY = 'rose-glass:graph-config';

function normalizeColors(c: unknown): [string, string, string, string] {
  const d = DEFAULT_CONFIG.clusterColors;
  if (!Array.isArray(c)) return [...d];
  return [0, 1, 2, 3].map((i) => (typeof c[i] === 'string' ? c[i] : d[i])) as [
    string,
    string,
    string,
    string,
  ];
}

/** Load the saved config, merged over defaults (forward-compatible with new fields). */
export function loadConfig(): GraphConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const p = JSON.parse(raw) as Partial<GraphConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...p,
      clusterColors: normalizeColors(p.clusterColors),
      mode: p.mode === 'fixed' ? 'fixed' : 'free',
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(c: GraphConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* private mode / quota — config just won't persist this session */
  }
}
