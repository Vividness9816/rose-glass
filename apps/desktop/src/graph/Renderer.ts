/* Phase 4 — the renderer seam (extracted now that WebGPU is the real second caller,
   per ADR-20260616). Both the canvas-2D `GraphRenderer` and `WebGpuGraphRenderer`
   implement this; `GraphPane`'s interaction wiring talks to the interface, so pan/
   zoom/drag/click-open work identically whichever backend is active. */

import type { Camera } from './camera';
import type { GraphNode } from './types';
import type { GraphTheme } from './themeColors';

export interface GraphRendererLike {
  start(): void;
  stop(): void;
  setSize(w: number, h: number, dpr?: number): void;
  setTheme(theme: GraphTheme): void;
  // Phase 4 interaction (screen coords = CSS px; camera maps to world)
  getCamera(): Camera;
  zoomAtScreen(sx: number, sy: number, factor: number): void;
  panByScreen(dx: number, dy: number): void;
  pickAtScreen(sx: number, sy: number): GraphNode | undefined;
  moveNodeToScreen(id: number, sx: number, sy: number): void;
  setDragging(id: number | null): void;
  // Phase 8 activity light-up
  pulse(rel: string, action: 'read' | 'modify'): void;
}
