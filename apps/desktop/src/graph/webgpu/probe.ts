/* Phase 4 — WebGPU availability probe. Returns true ONLY if an adapter + device can
   actually be acquired (not just `navigator.gpu` existing) — the honest gate before
   we hand the graph to the GPU path. Any failure ⇒ false ⇒ caller keeps canvas-2D
   (§17: a driver hiccup must fall back, never blank the graph). Never throws. */

export interface WebGpuCheck {
  ok: boolean;
  reason: string; // human-readable; surfaced in the toggle tooltip / health
}

export async function probeWebGpu(): Promise<WebGpuCheck> {
  try {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) return { ok: false, reason: 'navigator.gpu unavailable (no WebGPU)' };
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'no GPU adapter' };
    const device = await adapter.requestDevice();
    if (!device) return { ok: false, reason: 'no GPU device' };
    device.destroy(); // probe only — the renderer requests its own device
    return { ok: true, reason: 'WebGPU ready' };
  } catch (e) {
    return { ok: false, reason: `WebGPU probe threw: ${String(e)}` };
  }
}
