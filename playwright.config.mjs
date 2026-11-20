// Visual regression: render fixed views of the map on the PR's preview and on
// production, then diff the two. No stored baseline images - production is the
// baseline. See tests/visual.spec.mjs.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.mjs',
  workers: 3,
  // A single retry absorbs a slow tile server.
  retries: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    // Fixed viewport so the two screenshots are directly comparable.
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    navigationTimeout: 45_000,
    actionTimeout: 20_000,
  },
});
