import { describe, it, expect } from 'vitest';
import { clampFraction, clampPx, nextFraction, SPLIT_MIN, SPLIT_MAX } from './splitLogic';

describe('clampFraction — brick-proofs a corrupt persisted split', () => {
  it('passes a legal fraction through', () => {
    expect(clampFraction(0.6)).toBe(0.6);
  });
  it('clamps below min and above max (no pane collapses to nothing)', () => {
    expect(clampFraction(0)).toBe(SPLIT_MIN);
    expect(clampFraction(1)).toBe(SPLIT_MAX);
    expect(clampFraction(-5)).toBe(SPLIT_MIN);
  });
  it('non-finite (NaN/Infinity from a corrupt store) → fallback default', () => {
    expect(clampFraction(NaN)).toBe(0.5);
    expect(clampFraction(Infinity)).toBe(0.5);
    expect(clampFraction(NaN, 0.4)).toBe(0.4);
  });
});

describe('clampPx — drawer height', () => {
  it('clamps into [min,max]', () => {
    expect(clampPx(50, 300, 120, 800)).toBe(120);
    expect(clampPx(9999, 300, 120, 800)).toBe(800);
    expect(clampPx(400, 300, 120, 800)).toBe(400);
  });
  it('non-finite → fallback', () => {
    expect(clampPx(NaN, 300, 120, 800)).toBe(300);
  });
});

describe('nextFraction', () => {
  it('maps pointer position to a clamped fraction', () => {
    expect(nextFraction(500, 1000)).toBe(0.5);
    expect(nextFraction(100, 1000)).toBe(SPLIT_MIN); // 0.1 → clamped up to 0.15
    expect(nextFraction(950, 1000)).toBe(SPLIT_MAX); // 0.95 → clamped down to 0.85
  });
  it('guards a zero/degenerate container', () => {
    expect(nextFraction(10, 0)).toBe(0.5);
  });
});
