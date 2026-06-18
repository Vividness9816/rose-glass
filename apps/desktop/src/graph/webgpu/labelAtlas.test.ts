import { describe, expect, it } from 'vitest';
import { layoutLabelAtlas, type LabelMetric } from './labelAtlas';

const m = (text: string, w: number, h = 14): LabelMetric => ({ text, w, h });

describe('layoutLabelAtlas', () => {
  it('returns one rect per label, preserving size', () => {
    const out = layoutLabelAtlas([m('a', 20), m('bb', 30)]);
    expect(out.rects).toHaveLength(2);
    expect(out.rects[0]).toMatchObject({ text: 'a', w: 20, h: 14 });
    expect(out.rects[1]).toMatchObject({ text: 'bb', w: 30, h: 14 });
  });

  it('keeps every rect within the atlas bounds', () => {
    const out = layoutLabelAtlas([m('x', 40), m('y', 50), m('z', 60)], 120);
    for (const r of out.rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(out.atlasW);
      expect(r.y + r.h).toBeLessThanOrEqual(out.atlasH);
    }
  });

  it('does not overlap labels packed on the same row', () => {
    const out = layoutLabelAtlas([m('a', 20), m('b', 20)], 1024);
    const [a, b] = out.rects;
    expect(a.y).toBe(b.y); // same row
    expect(a.x + a.w).toBeLessThanOrEqual(b.x); // a ends before b starts
  });

  it('wraps to a new row when maxW is exceeded', () => {
    // two 80px labels in a 120px atlas → the second wraps below the first
    const out = layoutLabelAtlas([m('one', 80), m('two', 80)], 120);
    expect(out.rects[1].y).toBeGreaterThan(out.rects[0].y);
    expect(out.rects[1].x).toBe(out.rects[0].x); // back to the left margin
  });

  it('gives an over-wide single label its own row (never drops it)', () => {
    const out = layoutLabelAtlas([m('verylong', 500)], 120);
    expect(out.rects).toHaveLength(1);
    expect(out.atlasW).toBeGreaterThanOrEqual(500);
  });

  it('handles the empty set as a 1×1 atlas', () => {
    const out = layoutLabelAtlas([]);
    expect(out.rects).toEqual([]);
    expect(out.atlasW).toBe(1);
    expect(out.atlasH).toBe(1);
  });
});
