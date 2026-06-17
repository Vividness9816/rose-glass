import { useEffect, useRef, type MutableRefObject } from 'react';
import type { Theme } from '../appearance/theme';
import type { GraphData } from './types';
import { buildMockGraph } from './mockGraph';
import { resolveGraphTheme } from './themeColors';
import { GraphRenderer } from './GraphRenderer';
import './graph.css';

/** Graph pane: mockup chrome + the live canvas-2D graph. Uses `data` (from the
 *  indexer) when given, else mock data. Rebuilds the renderer when `data` changes. */
export function GraphPane({
  theme,
  data,
  onOpenVault,
  lensOn,
  onToggleLens,
  onCluster,
  clustering,
  pulseRef,
  onOpenNode,
}: {
  theme: Theme;
  data?: GraphData;
  onOpenVault?: () => void;
  lensOn?: boolean;
  onToggleLens?: () => void;
  onCluster?: () => void;
  clustering?: boolean;
  /** Phase 8: Shell populates this with a node light-up fn (read=violet/modify=rose),
      reading the live renderer so it survives data-driven renderer rebuilds. */
  pulseRef?: MutableRefObject<((rel: string, action: 'read' | 'modify') => void) | null>;
  /** Phase 4: click a node → open its note (path is the vault-relative key). */
  onOpenNode?: (path: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);
  const onOpenNodeRef = useRef(onOpenNode);
  onOpenNodeRef.current = onOpenNode;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: GraphRenderer | null = null;
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

    const build = () => {
      const { w, h, dpr } = sizeCanvas();
      renderer = new GraphRenderer(canvas, data ?? buildMockGraph(w, h), resolveGraphTheme(), dpr);
      rendererRef.current = renderer;
      renderer.start();
    };

    const ro = new ResizeObserver(() => {
      const { w, h, dpr } = sizeCanvas();
      if (renderer) {
        renderer.setSize(w, h, dpr);
      } else {
        build();
      }
    });
    ro.observe(canvas);

    return () => {
      ro.disconnect();
      renderer?.stop();
      rendererRef.current = null;
      if (pulseRef) pulseRef.current = null;
    };
  }, [data, pulseRef]);

  useEffect(() => {
    rendererRef.current?.setTheme(resolveGraphTheme());
  }, [theme]);

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
  }, []);

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
          <button className="gc-btn active" type="button">All</button>
          <button className="gc-btn" type="button">Focus</button>
          <button
            className="gc-btn"
            type="button"
            onClick={onCluster}
            disabled={clustering || !onCluster}
            title="Embed notes (local AI) and group them into semantic clusters"
          >
            {clustering ? '…clustering' : 'Clusters'}
          </button>
          {onToggleLens && (
            <button
              className={`gc-btn${lensOn ? ' active' : ''}`}
              type="button"
              onClick={onToggleLens}
              aria-pressed={lensOn}
              title="Drag a liquid-glass lens over the graph"
            >
              ◎ Lens
            </button>
          )}
        </div>
      </div>
      <canvas ref={canvasRef} className="graph-canvas" />
      <div className="graph-fade" />
    </div>
  );
}
