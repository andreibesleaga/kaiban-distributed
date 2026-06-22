import { test, expect } from '@playwright/test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Visual inspection of the two zero-setup static HTML viewers shipped with the
 * examples. Loaded via file:// — they render their shell (and attempt a socket
 * connection to the gateway), giving a stable baseline of the example UIs.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const viewers = [
  { name: 'blog-team', file: 'examples/blog-team/viewer/board.html' },
  { name: 'global-research', file: 'examples/global-research/viewer/board.html' },
];

test.describe('Example static viewers — visual inspection', () => {
  for (const v of viewers) {
    test(`${v.name} viewer renders`, async ({ page }) => {
      await page.goto(pathToFileURL(path.join(ROOT, v.file)).href);
      // Allow the socket-connect attempt + initial render to settle.
      await page.waitForTimeout(1500);
      await expect(page).toHaveScreenshot(`viewer-${v.name}.png`, {
        fullPage: true,
      });
    });
  }
});
