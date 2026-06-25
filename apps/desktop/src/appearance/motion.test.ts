import { describe, it, expect } from 'vitest';
import { resolveReduceMotion } from './motion';

describe('resolveReduceMotion', () => {
  it("'on' forces full motion regardless of the OS signal", () => {
    expect(resolveReduceMotion('on', true)).toBe(false);
    expect(resolveReduceMotion('on', false)).toBe(false);
  });
  it("'off' forces reduced motion regardless of the OS signal", () => {
    expect(resolveReduceMotion('off', true)).toBe(true);
    expect(resolveReduceMotion('off', false)).toBe(true);
  });
  it("'system' follows the OS prefers-reduced-motion signal", () => {
    expect(resolveReduceMotion('system', true)).toBe(true);
    expect(resolveReduceMotion('system', false)).toBe(false);
  });
});
