import { describe, expect, it } from 'vitest';
import {
  RIBBON_STRIDE,
  ribbonInto,
  sampleQuadratic,
  quadraticRibbonInto,
  type Vec2,
} from './ribbon';

const P = (x: number, y: number): Vec2 => ({ x, y });

describe('sampleQuadratic', () => {
  it('returns segments+1 points with exact endpoints', () => {
    const pts = sampleQuadratic(P(0, 0), P(5, 10), P(10, 0), 8);
    expect(pts).toHaveLength(9);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[8]).toEqual({ x: 10, y: 0 });
  });

  it('clamps a zero/negative segment count to 1 (still endpoints)', () => {
    const pts = sampleQuadratic(P(0, 0), P(1, 1), P(2, 0), 0);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[1]).toEqual({ x: 2, y: 0 });
  });

  it('midpoint of a symmetric quad sits at the bezier apex', () => {
    // t=0.5 of P0(0,0) ctrl(0,10) P1(10,0) = (2.5, 5)
    const pts = sampleQuadratic(P(0, 0), P(0, 10), P(10, 0), 2);
    expect(pts[1].x).toBeCloseTo(2.5, 6);
    expect(pts[1].y).toBeCloseTo(5, 6);
  });
});

describe('ribbonInto', () => {
  it('writes (n-1)*6 verts of stride 6 for an n-point polyline', () => {
    const out = new Float32Array(1000);
    const end = ribbonInto(out, 0, [P(0, 0), P(10, 0), P(20, 0)], 2, [1, 0, 0], 1);
    expect(end).toBe(2 * 6 * RIBBON_STRIDE); // 2 segments × 6 verts × stride
  });

  it('expands a horizontal line into a band of ±halfWidth (normal ⟂ to the line)', () => {
    const out = new Float32Array(100);
    ribbonInto(out, 0, [P(0, 0), P(10, 0)], 3, [0.2, 0.4, 0.6], 0.5);
    // collect the 6 emitted (x,y) and assert every y is ±3 and x ∈ {0,10}
    const ys: number[] = [];
    const xs: number[] = [];
    for (let i = 0; i < 6; i++) {
      xs.push(out[i * RIBBON_STRIDE]);
      ys.push(out[i * RIBBON_STRIDE + 1]);
    }
    for (const y of ys) expect(Math.abs(Math.abs(y) - 3)).toBeLessThan(1e-6);
    for (const x of xs) expect(x === 0 || x === 10).toBe(true);
    // colour/alpha carried through
    expect(out[2]).toBeCloseTo(0.2, 6);
    expect(out[5]).toBeCloseTo(0.5, 6);
  });

  it('skips a < 2-point polyline (no write)', () => {
    const out = new Float32Array(100);
    expect(ribbonInto(out, 0, [P(1, 1)], 2, [1, 1, 1], 1)).toBe(0);
  });

  it('respects the buffer cap — never writes past out.length', () => {
    const out = new Float32Array(6 * RIBBON_STRIDE); // room for exactly 1 segment
    const end = ribbonInto(out, 0, [P(0, 0), P(10, 0), P(20, 0), P(30, 0)], 1, [1, 1, 1], 1);
    expect(end).toBeLessThanOrEqual(out.length);
  });

  it('stays finite on a 180° reversal (degenerate miter falls back)', () => {
    const out = new Float32Array(200);
    const end = quadraticRibbonInto(out, 0, P(0, 0), P(10, 0), P(0, 0), 4, 2, [1, 1, 1], 1);
    for (let i = 0; i < end; i++) expect(Number.isFinite(out[i])).toBe(true);
  });
});
