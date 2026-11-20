/**
 * Visual regression: the PR's Cloudflare Workers Preview vs production
 * (floaty.klaska.net). Run by the `visual` job in .github/workflows/deploy.yml.
 * Same setup as https://cfsite.klaska.net/checks/#visual, with map views instead of
 * pages.
 *
 * No committed baseline images: production is the baseline. A PR that changes the
 * map on purpose fails this check by design; the diffs page linked from the preview
 * comment is what a human looks at before merging.
 *
 * The map is live data, so both sides are pinned to the same state through the
 * URL hash: the same snapshot date (d=), the same view (m=zoom/lat/lng) and, for
 * one view, the change overlay (diff=1). Both sides read the snapshots from the
 * same place (raw.githubusercontent.com, main), and the base map tiles come from
 * the same tile servers, so pixel differences come from the code under review.
 *
 * Every view also writes visual-results/<name>.json (pass or fail, with the
 * numbers); tests/visual-report.mjs turns those into the job summary, the preview
 * comment row and, when something differs, one HTML page with the images.
 *
 * Named *.spec.mjs so `node --test` (the snapshot unit tests) does not pick it up.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const PREVIEW = (process.env.PREVIEW_URL || '').replace(/\/$/, '');
const PROD = (process.env.PROD_URL || 'https://floaty.klaska.net').replace(/\/$/, '');
// Two limits per view. The share of differing pixels catches broad changes (layout,
// colours); the most differing pixels within any 16x16 square catches compact ones,
// like one changed character in the legend. Identical renders score 0 on both, map
// tiles included (measured 2026-11-20 on all three views).
const MAX_DIFF_RATIO = Number(process.env.MAX_DIFF_RATIO || 0.002);
const WINDOW_SIZE = 16;
const MAX_WINDOW_PIXELS = Number(process.env.MAX_WINDOW_PIXELS || 10);
const DIFF_DIR = 'visual-diffs';
const RESULTS_DIR = 'visual-results';
const INDEX_URL = 'https://raw.githubusercontent.com/radimklaska/floaty_territory_history/main/index.json';

if (!PREVIEW) throw new Error('PREVIEW_URL is not set');

// The newest snapshot can be replaced while the test runs (the daily Action), so
// use the one before it; it no longer changes.
const days = (await (await fetch(INDEX_URL)).json()).days;
const DATE = days[Math.max(0, days.length - 2)].date;

const views = [
  { name: 'europe', hash: `d=${DATE}&m=5/50/12` },
  { name: 'europe-changes', hash: `d=${DATE}&diff=1&m=5/50/12` },
  { name: 'world', hash: `d=${DATE}&m=2/30/0` },
];

/**
 * Elements that legitimately differ between the two sites. Add a selector here
 * rather than raising MAX_DIFF_RATIO.
 */
const MASK_SELECTORS = [];

async function shoot(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  // Leaflet fades tiles in after they load.
  await page.waitForTimeout(1500);
  return page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    mask: MASK_SELECTORS.map((s) => page.locator(s)),
  });
}

test.describe('preview matches production', () => {
  for (const v of views) {
    test(`view ${v.name}`, async ({ page }) => {
      const a = PNG.sync.read(await shoot(page, `${PREVIEW}/#${v.hash}`));
      const b = PNG.sync.read(await shoot(page, `${PROD}/#${v.hash}`));
      // Viewport screenshots: both sides have the viewport's size.
      const { width, height } = a;
      const diff = new PNG({ width, height });
      const differing = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.2, includeAA: false });
      const ratio = differing / (width * height);
      const windowMax = pixelmatch(a.data, b.data, null, width, height,
        { threshold: 0.2, includeAA: false, windowSize: WINDOW_SIZE });
      const passed = ratio <= MAX_DIFF_RATIO && windowMax <= MAX_WINDOW_PIXELS;

      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      fs.writeFileSync(path.join(RESULTS_DIR, `${v.name}.json`), JSON.stringify({
        name: v.name, path: `/#${v.hash}`, passed, ratio, differing, pixels: width * height, windowMax,
        previewHeight: a.height, productionHeight: b.height,
      }));

      if (!passed) {
        fs.mkdirSync(DIFF_DIR, { recursive: true });
        fs.writeFileSync(path.join(DIFF_DIR, `${v.name}-diff.png`), PNG.sync.write(diff));
        fs.writeFileSync(path.join(DIFF_DIR, `${v.name}-preview.png`), PNG.sync.write(a));
        fs.writeFileSync(path.join(DIFF_DIR, `${v.name}-production.png`), PNG.sync.write(b));
      }

      expect.soft(windowMax, `${windowMax} pixels differ within one ${WINDOW_SIZE}x${WINDOW_SIZE} square on #${v.hash} - see the visual diffs page`)
        .toBeLessThanOrEqual(MAX_WINDOW_PIXELS);
      expect(
        ratio,
        `${differing} of ${width * height} pixels differ (${(ratio * 100).toFixed(3)}%) on #${v.hash} - see the visual diffs page`
      ).toBeLessThanOrEqual(MAX_DIFF_RATIO);
    });
  }
});
