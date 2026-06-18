import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Theme } from '../appearance/theme';
import type { GraphData } from './types';
import { buildMockGraph } from './mockGraph';
import { resolveGraphTheme } from './themeColors';
import { GraphRenderer } from './GraphRenderer';
import type { GraphRendererLike } from './Renderer';
import { WebGpuGraphRenderer } from './webgpu/WebGpuGraphRenderer';
import { probeWebGpu } from './webgpu/probe';
import './graph.css';

/** Graph pane: mockup chrome + the live canvas-2D graph. Uses `data` (from the
 *  indexer) when given, else mock data. Rebuilds the renderer when `data` changes. */
export function GraphPane({
  theme,
  data,
  onOpenVault,
  onCluster,
  clustering,
  pulseRef,
  onOpenNode,
  activePath,
}: {
  theme: Theme;
  data?: GraphData;
  onOpenVault?: () => void;
  /** The open note's path — the centre of "Focus" (local-graph) scope. */
  activePath?: string | null;
  onCluster?: () => void;
  clustering?: boolean;
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
  const [scope, setScope] = useState<'all' | 'focus'>('all'); // graph scope: whole graph vs local
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const [gpuOn, setGpuOn] = useState(false); // user intent: try the WebGPU path
  const [gpuAvailable, setGpuAvailable] = useState<boolean | null>(null); // null = probing
  const [gpuReason, setGpuReason] = useState('probing…');
  // Read availability inside build() via a ref so the probe RESOLVING doesn't re-run
  // the build effect (which would needlessly tear down + reshuffle the mock layout).
  const gpuAvailableRef = useRef(gpuAvailable);
  gpuAvailableRef.current = gpuAvailable;

  // Probe WebGPU once (adapter+device actually obtainable), not just navigator.gpu.
  useEffect(() => {
    let cancelled = false;
    void probeWebGpu().then((c) => {
      if (cancelled) return;
      setGpuAvailable(c.ok);
      setGpuReason(c.reason);
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
      r.setFocus(scopeRef.current === 'focus' ? (activePathRef.current ?? null) : null); // re-apply focus after a rebuild
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

  // Local-graph focus: dim everything but the open note + its neighbours (or clear it).
  useEffect(() => {
    rendererRef.current?.setFocus(scope === 'focus' ? (activePath ?? null) : null);
  }, [scope, activePath]);

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
        canvas.style.cursor = r.pickAtScreen(sx, sy) ? 'pointer' : 'default';
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
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };
    // gpuOn re-runs this so listeners re-attach to the fresh canvas after the
    // backend toggle remounts it (via the JSX key).
  }, [gpuOn]);

  return (
    <div className="graph-pane">
      <div className="graph-header">
        <span className="graph-glyph">⬡</span>
        <span className="graph-title">knowledge graph</span>
        <div className="graph-controls">
          {onOpenVault && (
            <button className="gc-btn" type="button" onClick={onOpenVault}>
              Open vault…
            </button>
          )}
          <button
            className={`gc-btn${scope === 'all' ? ' active' : ''}`}
            type="button"
            onClick={() => setScope('all')}
            aria-pressed={scope === 'all'}
            title="Show the whole graph"
          >
            All
          </button>
          <button
            className={`gc-btn${scope === 'focus' ? ' active' : ''}`}
            type="button"
            onClick={() => setScope('focus')}
            disabled={!activePath}
            aria-pressed={scope === 'focus'}
            title={activePath ? 'Focus the open note + its links' : 'Open a note to focus its local graph'}
          >
            Focus
          </button>
          <button
            className="gc-btn"
            type="button"
            onClick={onCluster}
            disabled={clustering || !onCluster}
            title="Embed notes (local AI) and group them into semantic clusters"
          >
            {clustering ? '…clustering' : 'Clusters'}
          </button>
          <button
            className={`gc-btn${gpuOn ? ' active' : ''}`}
            type="button"
            onClick={() => setGpuOn((v) => !v)}
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
      <div className="graph-fade" />
    </div>
  );
}
