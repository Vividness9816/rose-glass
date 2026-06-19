/* v2.0 graph-config-panel polish verification (throwaway, re-runnable).
   Serve: `vite preview --port 4185` (from apps/desktop). Drives headed Edge (= the app's
   WebView2 engine) so the WebGL living backdrop renders behind the glass panel. Opens the
   panel, exercises a slider + a color swatch + fixed mode, and captures dark + light shots
   of the panel over the backdrop (the v2.0 impeccable polish: glass tokens, sliders icon,
   entrance, focus). */
const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: false });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto('http://localhost:4185/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const gear = page.locator('.gcfg-gear');
  const panel = page.locator('.gcfg-panel');

  // collapsed → the sliders glyph over the backdrop
  await page.locator('.graph-pane').screenshot({ path: 'docs/proof/v2-panel-collapsed.png' });
  console.log('GEAR_VISIBLE ' + (await gear.isVisible()));

  // open → panel entrance; capture the panel crop + the pane (panel over living backdrop)
  await gear.click();
  await page.waitForTimeout(450); // let the entrance animation settle
  console.log('PANEL_VISIBLE ' + (await panel.isVisible()));
  await panel.screenshot({ path: 'docs/proof/v2-panel-dark.png' });
  await page.locator('.graph-pane').screenshot({ path: 'docs/proof/v2-panel-dark-over-backdrop.png' });

  // exercise state: drag the first slider, set fixed mode, pick a cluster color
  await page.locator(".gcfg-modes button", { hasText: 'Fixed' }).click();
  const drift = page.locator(".gcfg-row input[type='range']").nth(2);
  await drift.evaluate((el) => console.log('DRIFT_DISABLED_IN_FIXED ' + el.disabled));
  await panel.screenshot({ path: 'docs/proof/v2-panel-fixed.png' });

  // light theme → confirm the glass + contrast hold on the light field
  await page.evaluate(() => localStorage.setItem('app.theme', 'light'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.locator('.gcfg-gear').click();
  await page.waitForTimeout(450);
  await page.locator('.gcfg-panel').screenshot({ path: 'docs/proof/v2-panel-light.png' });
  await page.locator('.graph-pane').screenshot({ path: 'docs/proof/v2-panel-light-over-backdrop.png' });

  console.log('CONSOLE_ERRORS ' + JSON.stringify(errors.slice(0, 25)));
  await browser.close();
})().catch((e) => {
  console.error('SCRIPT_ERROR ' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
