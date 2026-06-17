import { defineConfig } from '@playwright/test';

/* A2 — visual-regression harness. Gates the deterministic shell chrome (titlebar / icon rail /
   graph-pane controls / editor pane / ⌘K palette / statusbar) in light + dark against committed
   baselines, so a token/layout/theme regression fails CI. The animated graph canvas is masked
   per-shot (rAF, non-deterministic); `reducedMotion: 'reduce'` renders the backdrop as its static
   token gradient (deterministic). Populated editor/search states need Tauri IPC (the web build
   shows empty states) and are covered by the live app-window eyeball, not this harness.

   Run: `pnpm --filter @rose-glass/desktop test:visual` (build first). Re-baseline: append
   `-- --update-snapshots`. Uses system Edge (the app's WebView2 engine) — no browser download. */
export default defineConfig({
  testDir: './tests/visual',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' },
  },
  use: {
    baseURL: 'http://localhost:4173',
    reducedMotion: 'reduce',
    viewport: { width: 1400, height: 900 },
    channel: 'msedge',
  },
  webServer: {
    command: 'pnpm exec vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
