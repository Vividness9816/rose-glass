/* Phase 4 — pan/zoom camera for the graph (shared by the canvas-2D and WebGPU
   renderers). Pure transforms: world (graph) coords ↔ screen (CSS px) coords.
   screen = world * zoom + translate. No DOM, no canvas — unit-testable. */

export interface Camera {
  tx: number; // screen-px translate x
  ty: number; // screen-px translate y
  zoom: number;
}

export const IDENTITY_CAMERA: Camera = { tx: 0, ty: 0, zoom: 1 };

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 6;

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

export function worldToScreen(c: Camera, wx: number, wy: number): [number, number] {
  return [wx * c.zoom + c.tx, wy * c.zoom + c.ty];
}

export function screenToWorld(c: Camera, sx: number, sy: number): [number, number] {
  return [(sx - c.tx) / c.zoom, (sy - c.ty) / c.zoom];
}

/** Zoom by `factor` about a screen anchor, keeping the world point under the anchor
    fixed (zoom-to-cursor). Returns a new camera (clamped). */
export function zoomAt(c: Camera, sx: number, sy: number, factor: number): Camera {
  const zoom = clampZoom(c.zoom * factor);
  // world point currently under (sx,sy) must stay under (sx,sy) at the new zoom
  const [wx, wy] = screenToWorld(c, sx, sy);
  return { zoom, tx: sx - wx * zoom, ty: sy - wy * zoom };
}

export function panBy(c: Camera, dx: number, dy: number): Camera {
  return { ...c, tx: c.tx + dx, ty: c.ty + dy };
}
