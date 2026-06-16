import { useEffect, useRef } from 'react';
import type { Theme } from '../appearance/theme';
import { buildMockGraph } from './mockGraph';
import { resolveGraphTheme } from './themeColors';
import { GraphRenderer } from './GraphRenderer';
import './graph.css';

/** Graph pane: mockup chrome + the live canvas-2D graph on mock data. */
export function GraphPane({ theme }: { theme: Theme }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: GraphRenderer | null = null;

    const ro = new ResizeObserver(() => {
      const w = Math.max(1, canvas.clientWidth);
      const h = Math.max(1, canvas.clientHeight);
      canvas.width = w;
      canvas.height = h;
      if (!renderer) {
        renderer = new GraphRenderer(canvas, buildMockGraph(w, h), resolveGraphTheme());
        rendererRef.current = renderer;
        renderer.start();
      } else {
        renderer.setSize(w, h);
      }
    });
    ro.observe(canvas);

    return () => {
      ro.disconnect();
      renderer?.stop();
      rendererRef.current = null;
    };
  }, []);

  // Re-resolve graph colors from tokens whenever the theme flips.
  useEffect(() => {
    rendererRef.current?.setTheme(resolveGraphTheme());
  }, [theme]);

  return (
    <div className="graph-pane">
      <div className="graph-header">
        <span className="graph-glyph">⬡</span>
        <span className="graph-title">knowledge graph</span>
        <div className="graph-controls">
          <button className="gc-btn active" type="button">All</button>
          <button className="gc-btn" type="button">Focus</button>
          <button className="gc-btn" type="button">Clusters</button>
        </div>
      </div>
      <canvas ref={canvasRef} className="graph-canvas" />
      <div className="graph-fade" />
    </div>
  );
}
