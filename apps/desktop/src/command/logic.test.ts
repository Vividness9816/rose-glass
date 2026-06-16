import { describe, expect, it } from 'vitest';
import { clampIndex } from './logic';

describe('clampIndex', () => {
  it('wraps around both ends', () => {
    expect(clampIndex(0, 3)).toBe(0);
    expect(clampIndex(1, 3)).toBe(1);
    expect(clampIndex(3, 3)).toBe(0); // past end → first
    expect(clampIndex(-1, 3)).toBe(2); // before start → last
  });
  it('is safe on an empty list', () => {
    expect(clampIndex(0, 0)).toBe(0);
    expect(clampIndex(-1, 0)).toBe(0);
  });
});
