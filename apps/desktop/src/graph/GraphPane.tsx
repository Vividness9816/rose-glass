import { memo, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Theme } from '../appearance/theme';
import type { GraphData } from './types';
import { buildMockGraph } from './mockGraph';
import { resolveGraphTheme } from './themeColors';
import { loadConfig, saveConfig, type GraphConfig } from './config';
import { GraphConfigPanel } from './GraphConfigPanel';
import { GraphRenderer } from './GraphRenderer';
import type { GraphRendererLike } from './Renderer';
import { WebGpuGraphRenderer } from './webgpu/WebGpuGraphRenderer';
import { probeWebGpu } from './webgpu/probe';
import { Icon } from '../icons/Icon';
import './graph.css';

// Persisted GPU/2D renderer preference.
const GPU_KEY = 'rose-glass:graph-gpu';
function loadGpuPref(): boolean {
  try {
    return localStorage.getItem(GPU_KEY) === '1';
  } catch {
    return false;
  }
}
function saveGpuPref(on: boolean): void {
  try {
    localStorage.setItem(GPU_KEY, on ? '1' : '0');
  } catch {
    /* private mode / quota — preference just won't persist this session */
  }
}

/** Graph pane: mockup chrome + the live canvas-2D graph. Uses `data` (from the
 *  indexer) when given, else mock data. Rebuilds the renderer when `data` changes. */
function GraphPaneInner({
  theme,
  data,
  onOpenVault,
  onCluster,
  clustering,
  clusterError,
  onRetryCluster,
  pulseRef,
  onOpenNode,
}: {
  theme: Theme;
  data?: GraphData;
  onOpenVault?: () => void;
  onCluster?: () => void;
  clustering?: boolean;
  /** v2.0: a failed embedding-model load (the ~90MB fetch) → show a Retry. */
  clusterError?: string | null;
  onRetryCluster?: () => void;
  /** Phase 8: Shell populates this with a node light-up fn (read=violet/modify=rose),
      reading the live renderer so it survives data-driven renderer rebuilds. */
  pulseRef?: MutableRefObject<((rel: string, action: 'read' | 'modify') => void) | null>;
  /** Phase 4: click a node → open its note (path is the vault-relative key). */
  onOpenNode?: (path: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GraphRendererLike | null>(null);
  const onOpenNodeRef = useRef(onOpenNode);
  onOpenNodeRef.current = onOpenNode;
  const [gpuOn, setGpuOn] = useState(false); // user intent: try the WebGPU path
  // Saved GPU pref, read once. We start 2D and restore this only AFTER the probe confirms
  // WebGPU is available (below), so a stored 'GPU' never strands us on a 2D-committed canvas.
  const wantGpuRef = useRef(loadGpuPref());
  const [gpuAvailable, setGpuAvailable] = useState<boolean | null>(null); // null = probing
  const [gpuReason, setGpuReason] = useState('probing…');
  // Read availability inside build() via a ref so the probe RESOLVING doesn't re-run
  // the build effect (which would needlessly tear down + reshuffle the mock layout).
  const gpuAvailableRef = useRef(gpuAvailable);
  gpuAvailableRef.current = gpuAvailable;

  // v2.0 user-tunable physics/colors (persisted). configRef lets build() apply the
  // current config to a freshly-built renderer without re-running the build effect.
  const [config, setConfig] = useState<GraphConfig>(() => loadConfig());
  const configRef = useRef(config);
  configRef.current = config;

  // Probe WebGPU once (adapter+device actually obtainable), not just navigator.gpu.
  useEffect(() => {
    let cancelled = false;
    void probeWebGpu().then((c) => {
      if (cancelled) return;
      setGpuAvailable(c.ok);
      setGpuReason(c.reason);
      // restore the saved GPU preference now that availability is known (build effect re-runs
      // on the gpuOn change and reads gpuAvailableRef = true → builds the GPU renderer).
      if (c.ok && wantGpuRef.current) setGpuOn(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: GraphRendererLike | null = null;
    let cancelled = false;
    let built = false;
    if (pulseRef) pulseRef.current = (rel, action) => rendererRef.current?.pulse(rel, action);

    // Backing store at device pixels (crisp text/graph on HiDPI/4K); renderer works in CSS px.
    const sizeCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, canvas.clientWidth);
      const h = Math.max(1, canvas.clientHeight);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      return { w, h, dpr };
    };

    const build = async () => {
      const { w, h, dpr } = sizeCanvas();
      const gd = data ?? buildMockGraph(w, h);
      const t = resolveGraphTheme();
      let r: GraphRendererLike | null = null;
      if (gpuOn && gpuAvailableRef.current) {
        // External device loss → flip the toggle off; the canvas `key` remounts a
        // fresh element and the effect re-runs on the canvas-2D path.
        const onLost = () => {
          if (!cancelled) setGpuOn(false);
        };
        r = await WebGpuGraphRenderer.create(canvas, gd, t, dpr, onLost); // null on any GPU failure
        if (!r) {
          // create() may have committed this canvas to 'webgpu' mode, so getContext('2d')
          // would now throw. DON'T build 2D here — flip gpuOn (remounts a clean canvas via
          // the JSX key) and let the effect re-run build the 2D path on the fresh element.
          if (!cancelled) setGpuOn(false);
          return;
        }
      }
      if (!r) r = new GraphRenderer(canvas, gd, t, dpr);
      if (cancelled) {
        r.stop();
        return;
      }
      renderer = r;
      rendererRef.current = r;
      const s = sizeCanvas(); // honor any resize that landed during the async build
      r.setSize(s.w, s.h, s.dpr);
      r.setFocus(null); // hover drives focus now; start un-dimmed
      r.setConfig(configRef.current); // re-apply the user's physics to the fresh renderer
      r.start();
    };

    const ro = new ResizeObserver(() => {
      const { w, h, dpr } = sizeCanvas();
      if (renderer) renderer.setSize(w, h, dpr);
      else if (!built) {
        built = true;
        void build().catch(() => {
          /* any build throw degrades to a no-op (never an unhandled rejection) */
        });
      }
    });
    ro.observe(canvas);

    return () => {
      cancelled = true;
      ro.disconnect();
      renderer?.stop();
      rendererRef.current = null;
      if (pulseRef) pulseRef.current = null;
    };
  }, [data, pulseRef, gpuOn]);

  useEffect(() => {
    rendererRef.current?.setTheme(resolveGraphTheme());
  }, [theme]);

  // v2.0: persist config + push the physics to the live renderer when the user tunes it.
  useEffect(() => {
    saveConfig(config);
    rendererRef.current?.setConfig(config);
  }, [config]);

  // v2.0: apply per-cluster color overrides to the token layer (so BOTH renderers pick
  // them up via resolveGraphTheme), or clear them back to the theme default. Keyed on the
  // joined colors so it only runs when a swatch actually changes.
  useEffect(() => {
    const root = document.documentElement;
    config.clusterColors.forEach((c, i) => {
      if (c) root.style.setProperty(`--cluster-${i}`, c);
      else root.style.removeProperty(`--cluster-${i}`);
    });
    rendererRef.current?.setTheme(resolveGraphTheme());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key on the color values, not the array identity
  }, [config.clusterColors.join('|')]);

  // Phase 4 — pan / zoom / drag / click-open. Native listeners (wheel needs
  // passive:false to preventDefault); all forward to the live renderer's camera.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const drag = { mode: 'none' as 'none' | 'pan' | 'node', id: -1, lastX: 0, lastY: 0, dx0: 0, dy0: 0, moved: false };
    const at = (e: PointerEvent | WheelEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = rendererRef.current;
      if (!r) return;
      const [sx, sy] = at(e);
      r.zoomAtScreen(sx, sy, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    const onDown = (e: PointerEvent) => {
      const r = rendererRef.current;
      if (!r) return;
      const [sx, sy] = at(e);
      const n = r.pickAtScreen(sx, sy);
      drag.mode = n ? 'node' : 'pan';
      drag.id = n ? n.id : -1;
      drag.lastX = sx;
      drag.lastY = sy;
      drag.dx0 = sx;
      drag.dy0 = sy;
      drag.moved = false;
      if (n) r.setDragging(n.id);
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = n ? 'grabbing' : 'move';
    };
    const onMove = (e: PointerEvent) => {
      const r = rendererRef.current;
      if (!r) return;
      const [sx, sy] = at(e);
      if (drag.mode === 'none') {
        canvas.style.cursor = r.pickAtScreen(sx, sy) ? 'pointer' : 'default'; // strict: pointer only when clickable
        const near = r.pickAtScreen(sx, sy, 22); // forgiving hover radius → highlight + label the nearest node
        r.setFocus(near ? near.path : null);
        return;
      }
      if (Math.abs(sx - drag.dx0) + Math.abs(sy - drag.dy0) > 3) drag.moved = true;
      if (drag.mode === 'pan') r.panByScreen(sx - drag.lastX, sy - drag.lastY);
      else r.moveNodeToScreen(drag.id, sx, sy);
      drag.lastX = sx;
      drag.lastY = sy;
    };
    const onUp = (e: PointerEvent) => {
      const r = rendererRef.current;
      if (r && drag.mode === 'node' && !drag.moved) {
        const [sx, sy] = at(e);
        const n = r.pickAtScreen(sx, sy);
        if (n) onOpenNodeRef.current?.(n.path); // click (no drag) → open
      }
      r?.setDragging(null);
      drag.mode = 'none';
      drag.id = -1;
      canvas.style.cursor = 'default';
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    };
    const onLeave = () => rendererRef.current?.setFocus(null); // leaving the canvas clears the hover highlight
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
    };
    // gpuOn re-runs this so listeners re-attach to the fresh canvas after the
    // backend toggle remounts it (via the JSX key).
  }, [gpuOn]);

  return (
    <div className="graph-pane">
      <div className="graph-header">
        <span className="graph-glyph">
          <Icon name="graph" size="sm" />
        </span>
        <span className="graph-title">knowledge graph</span>
        <div className="graph-controls">
          {onOpenVault && (
            <button className="gc-btn" type="button" onClick={onOpenVault}>
              Open vault…
            </button>
          )}
          <button
            className="gc-btn"
            type="button"
            onClick={onCluster}
            disabled={clustering || !onCluster}
            title="Embed notes (local AI) and group them into semantic clusters"
          >
            {clustering ? '…clustering' : 'Clusters'}
          </button>
          {clusterError && !clustering && (
            <button
              className="gc-btn"
              type="button"
              onClick={onRetryCluster}
              title={`Embedding model failed to load: ${clusterError}`}
              style={{ color: 'var(--rose, #e0607e)' }}
            >
              <Icon name="warning" size={12} /> Retry
            </button>
          )}
          <button
            className={`gc-btn${gpuOn ? ' active' : ''}`}
            type="button"
            onClick={() =>
              setGpuOn((v) => {
                const next = !v;
                saveGpuPref(next); // persist only on explicit user toggle (not device-loss fallback)
                return next;
              })
            }
            disabled={!gpuAvailable}
            aria-pressed={gpuOn}
            title={
              gpuAvailable === false
                ? `WebGPU unavailable — using canvas-2D (${gpuReason})`
                : 'Toggle the WebGPU renderer (canvas-2D is the fallback)'
            }
          >
            {gpuOn ? 'GPU' : '2D'}
          </button>
        </div>
      </div>
      {/* key by backend: toggling remounts a FRESH canvas so the 2D fallback never
          inherits a canvas already committed to 'webgpu' (getContext('2d') → null). */}
      <canvas key={gpuOn ? 'gpu' : '2d'} ref={canvasRef} className="graph-canvas" />
      <GraphConfigPanel config={config} onChange={setConfig} />
      <div className="graph-fade" />
    </div>
  );
}

/* v2.2 — memoized so a Shell re-render (e.g. the per-CC-event setActivity tick) doesn't
   re-enter GraphPane's render body. Effective ONLY because every prop Shell passes is
   referentially stable: data identity is stable between graph refreshes, the callbacks are
   useCallback (incl. onOpenNode as of v2.2), pulseRef is a ref, the rest are primitives. */
export const GraphPane = memo(GraphPaneInner);
