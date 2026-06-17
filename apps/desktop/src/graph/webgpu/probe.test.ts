import { describe, expect, it } from 'vitest';
import { probeWebGpu } from './probe';

describe('webgpu probe', () => {
  it('reports unavailable (and never throws) when navigator.gpu is absent — drives the 2D fallback', async () => {
    // jsdom has no navigator.gpu → the probe must resolve ok:false, not reject.
    const c = await probeWebGpu();
    expect(c.ok).toBe(false);
    expect(typeof c.reason).toBe('string');
  });
});
