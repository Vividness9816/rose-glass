/* Phase 4 GPU parity — pure quadratic-bezier → triangle-ribbon tessellation.
   The canvas-2D path draws curved edges / slime / arrowheads with
   `ctx.quadraticCurveTo` + a variable `lineWidth`; WebGPU has NO curve primitive
   and `line-list` is a hardware-1px line, so to match the 2D look on the GPU we
   tessellate each quadratic into N segments on the CPU and expand the polyline to
   a constant-width triangle ribbon. Kept pure + unit-tested so the one genuinely
   non-trivial GPU-feeding math (winding / per-vertex normals / arrowheads) is
   verified headlessly — the WGSL then just draws the triangles it's handed. */

export type RGB01 = [number, number, number]; // 0..1 (normalized for the shader)

export interface Vec2 {
  x: number;
  y: number;
}

/** Per-vertex stride in the ribbon buffer: x, y, r, g, b, a. */
export const RIBBON_STRIDE = 6;

/** Sample a quadratic bezier P0 → ctrl → P1 at `segments`+1 points (t = 0..1),
    endpoints exact. `segments` is clamped to ≥1. */
export function sampleQuadratic(p0: Vec2, ctrl: Vec2, p1: Vec2, segments: number): Vec2[] {
  const n = Math.max(1, Math.floor(segments));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push({
      x: u * u * p0.x + 2 * u * t * ctrl.x + t * t * p1.x,
      y: u * u * p0.y + 2 * u * t * ctrl.y + t * t * p1.y,
    });
  }
  return out;
}

/** Per-vertex outward normals for a polyline (smooth/miter at interior vertices,
    single-segment normal at the ends). Degenerate (repeated) points reuse the last
    good normal, so a stalled point can't inject NaN. */
function vertexNormals(points: Vec2[]): Vec2[] {
  const n = points.length;
  // segment unit normals (rotate the direction +90°: (-dy, dx))
  const segN: Vec2[] = [];
  let last: Vec2 = { x: 0, y: 1 };
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dy = points[i + 1].y - points[i].y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      segN.push(last); // zero-length segment → carry the previous normal
    } else {
      last = { x: -dy / len, y: dx / len };
      segN.push(last);
    }
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    let nx: number;
    let ny: number;
    if (i === 0) {
      nx = segN[0].x;
      ny = segN[0].y;
    } else if (i === n - 1) {
      nx = segN[n - 2].x;
      ny = segN[n - 2].y;
    } else {
      // miter = normalized sum of the two incident segment normals; falls back to
      // one segment's normal at a 180° reversal (sum ≈ 0).
      nx = segN[i - 1].x + segN[i].x;
      ny = segN[i - 1].y + segN[i].y;
      const len = Math.hypot(nx, ny);
      if (len < 1e-6) {
        nx = segN[i].x;
        ny = segN[i].y;
      } else {
        nx /= len;
        ny /= len;
      }
    }
    out.push({ x: nx, y: ny });
  }
  return out;
}

/** Expand a polyline into a constant-width triangle ribbon, writing 6 verts (two
    triangles) per segment into `out` starting at float-offset `off`. Each vert is
    [x, y, r, g, b, a]. Returns the new float-offset. Writes nothing (returns `off`)
    when the polyline is < 2 points or `out` lacks room — the caller's capacity cap. */
export function ribbonInto(
  out: Float32Array,
  off: number,
  points: Vec2[],
  halfWidth: number,
  col: RGB01,
  alpha: number,
): number {
  if (points.length < 2) return off;
  const norm = vertexNormals(points);
  const [r, g, b] = col;
  let o = off;
  const push = (x: number, y: number) => {
    out[o] = x;
    out[o + 1] = y;
    out[o + 2] = r;
    out[o + 3] = g;
    out[o + 4] = b;
    out[o + 5] = alpha;
    o += RIBBON_STRIDE;
  };
  for (let i = 0; i < points.length - 1; i++) {
    // each segment skipped if it would overflow the buffer (slime cap — see renderer)
    if (o + 6 * RIBBON_STRIDE > out.length) break;
    const a = points[i];
    const c = points[i + 1];
    const na = norm[i];
    const nc = norm[i + 1];
    const alx = a.x + na.x * halfWidth;
    const aly = a.y + na.y * halfWidth;
    const arx = a.x - na.x * halfWidth;
    const ary = a.y - na.y * halfWidth;
    const clx = c.x + nc.x * halfWidth;
    const cly = c.y + nc.y * halfWidth;
    const crx = c.x - nc.x * halfWidth;
    const cry = c.y - nc.y * halfWidth;
    // tri 1: aL, aR, cL   tri 2: aR, cR, cL
    push(alx, aly);
    push(arx, ary);
    push(clx, cly);
    push(arx, ary);
    push(crx, cry);
    push(clx, cly);
  }
  return o;
}

/** Tessellate a quadratic bezier into a ribbon directly (sample → expand). */
export function quadraticRibbonInto(
  out: Float32Array,
  off: number,
  p0: Vec2,
  ctrl: Vec2,
  p1: Vec2,
  segments: number,
  halfWidth: number,
  col: RGB01,
  alpha: number,
): number {
  return ribbonInto(out, off, sampleQuadratic(p0, ctrl, p1, segments), halfWidth, col, alpha);
}
