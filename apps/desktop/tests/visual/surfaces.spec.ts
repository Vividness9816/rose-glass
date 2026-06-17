import { expect, test } from '@playwright/test';

/* Capture the shell + ⌘K palette in both themes; diff against committed baselines.
   The graph canvas is masked (animated); the backdrop is static under reducedMotion. */

const THEMES = ['dark', 'light'] as const;
const maskGraph = (page: import('@playwright/test').Page) => [page.locator('.graph-pane canvas')];

async function ready(page: import('@playwright/test').Page, theme: string) {
  await page.addInitScript((t) => localStorage.setItem('app.theme', t), theme);
  await page.goto('/');
  await page.waitForSelector('.app-shell');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(400); // settle layout + the static backdrop gradient
}

for (const theme of THEMES) {
  test(`shell — ${theme}`, async ({ page }) => {
    await ready(page, theme);
    await expect(page).toHaveScreenshot(`shell-${theme}.png`, { mask: maskGraph(page) });
  });

  test(`command palette — ${theme}`, async ({ page }) => {
    await ready(page, theme);
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.cmd-palette');
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot(`palette-${theme}.png`, { mask: maskGraph(page) });
  });
}
