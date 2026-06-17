const { chromium } = require('playwright');

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

  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
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
      return {
        ok: true,
        vendor: info.vendor || '?',
        architecture: info.architecture || '?',
        description: info.description || '?',
      };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  });
  console.log('WEBGPU_PROBE ' + JSON.stringify(gpu));

  const btn = page.locator('.graph-controls button', { hasText: /^(2D|GPU)$/ });
  const beforeText = await btn.textContent().catch(() => 'n/a');
  const disabled = await btn.isDisabled().catch(() => true);
  console.log('TOGGLE_BEFORE ' + JSON.stringify({ beforeText: (beforeText || '').trim(), disabled }));

  await page.screenshot({ path: 'shot-2d.png' });

  if (!disabled) {
    await btn.click();
    await page.waitForTimeout(2500); // let the WebGPU renderer build + paint frames
    const afterText = ((await btn.textContent().catch(() => 'n/a')) || '').trim();
    console.log('TOGGLE_AFTER ' + JSON.stringify({ afterText, builtGpu: afterText === 'GPU' }));
    await page.screenshot({ path: 'shot-gpu.png' });

    // Interaction on the GPU renderer (shared Camera): zoom-to-cursor over the graph.
    await page.mouse.move(360, 450);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -500); // deltaY<0 → zoom in
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'shot-gpu-zoom.png' });
    console.log('INTERACTION ' + JSON.stringify({ zoomedGpu: true }));
  } else {
    console.log('TOGGLE_AFTER ' + JSON.stringify({ afterText: '(toggle disabled — WebGPU unavailable here)' }));
  }

  console.log('CONSOLE_ERRORS ' + JSON.stringify(errors.slice(0, 25)));
  await browser.close();
})().catch((e) => {
  console.error('SCRIPT_ERROR ' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
