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
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);

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
