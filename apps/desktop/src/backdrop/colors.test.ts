import { describe, it, expect } from 'vitest';
import { backdropColors } from './colors';

describe('backdropColors', () => {
  it('returns distinct theme-aware palettes (never dark-only — anti-pattern #7)', () => {
    const dark = backdropColors('dark');
    const light = backdropColors('light');
    expect(dark).not.toEqual(light);
    // every stop is a concrete hex (a WebGL shader can't read CSS vars)
    for (const c of [...Object.values(dark), ...Object.values(light)]) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
    // dark base is near-black, light base is near-white — the wash inverts with theme
    expect(dark.color1).toBe('#0a0408');
    expect(light.color1).toBe('#fdf2f4');
  });
});
