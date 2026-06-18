/* Phase 4 GPU-parity verification (throwaway harness, re-runnable).
   Serves: `pnpm --filter @rose-glass/desktop exec vite preview --port 4173`.
   Drives headed Edge (= the app's WebView2 engine) on the RTX 5090 to eyeball
   that the WebGPU renderer now matches the canvas-2D look (auras / curved edges /
   hub rings / particles), that interaction (zoom) still works, and that the theme
   bullseye inversion renders on the GPU path (light theme). Captures the graph
   canvas crop for a clean 2D↔GPU comparison. */
const { chromium } = require('@playwright/test');

const clip = async (page, path) => {
  const el = page.locator('.graph-canvas');
  await el.screenshot({ path });
};

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: false, // headed = real GPU on the RTX 5090
    args: ['--enable-unsafe-webgpu'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  const toggle = () => page.locator('.graph-controls button', { hasText: /^(2D|GPU)$/ });

  await page.goto('http://localhost:4185/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const gpu = await page.evaluate(async () => {
    if (!navigator.gpu) return { ok: false, reason: 'no navigator.gpu' };
    try {
      const a = await navigator.gpu.requestAdapter();
      if (!a) return { ok: false, reason: 'no adapter' };
      let info = {};
      try {
        info = a.info ? a.info : a.requestAdapterInfo ? await a.requestAdapterInfo() : {};
      } catch {}
      return { ok: true, vendor: info.vendor || '?', architecture: info.architecture || '?' };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  });
  console.log('WEBGPU_PROBE ' + JSON.stringify(gpu));

  await clip(page, 'docs/proof/phase4-parity-2d.png');

  const disabled = await toggle().isDisabled().catch(() => true);
  if (disabled) {
    console.log('TOGGLE disabled — WebGPU unavailable here; cannot verify GPU parity');
    console.log('CONSOLE_ERRORS ' + JSON.stringify(errors.slice(0, 25)));
    await browser.close();
    return;
  }

  // dark-theme GPU render
  await toggle().click();
  await page.waitForTimeout(2500);
  const after = ((await toggle().textContent().catch(() => '')) || '').trim();
  console.log('TOGGLE_AFTER ' + JSON.stringify({ after, builtGpu: after === 'GPU' }));
  await clip(page, 'docs/proof/phase4-parity-gpu.png');

  // zoom-to-cursor on the GPU renderer
  await page.mouse.move(360, 450);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(500);
  await clip(page, 'docs/proof/phase4-parity-gpu-zoom.png');

  // light theme → confirm the bullseye inversion renders on the GPU path
  await page.evaluate(() => localStorage.setItem('app.theme', 'light'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await toggle().click(); // gpuOn resets on reload
  await page.waitForTimeout(2500);
  const afterLight = ((await toggle().textContent().catch(() => '')) || '').trim();
  console.log('LIGHT_GPU ' + JSON.stringify({ afterLight, builtGpu: afterLight === 'GPU' }));
  await clip(page, 'docs/proof/phase4-parity-gpu-light.png');

  console.log('CONSOLE_ERRORS ' + JSON.stringify(errors.slice(0, 25)));
  await browser.close();
})().catch((e) => {
  console.error('SCRIPT_ERROR ' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
