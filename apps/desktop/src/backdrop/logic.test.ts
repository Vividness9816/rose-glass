import { describe, it, expect } from 'vitest';
import { prefersStaticBackdrop, hasWebGL2 } from './logic';

describe('backdrop §17 fallback gate', () => {
  it('uses static when motion is reduced OR WebGL2 is unavailable', () => {
    expect(prefersStaticBackdrop(false, true)).toBe(false); // animate the shader
    expect(prefersStaticBackdrop(true, true)).toBe(true); // reduced-motion → static
    expect(prefersStaticBackdrop(false, false)).toBe(true); // no WebGL2 → static (the §17 case)
    expect(prefersStaticBackdrop(true, false)).toBe(true);
  });

  it('detects absent WebGL2 in a headless/jsdom env and degrades safely', () => {
    // jsdom has no WebGL2 context → the probe must report false (→ static, never blank)
    expect(hasWebGL2()).toBe(false);
  });
});
