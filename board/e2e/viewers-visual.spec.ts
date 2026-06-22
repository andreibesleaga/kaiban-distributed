import { test, expect } from '@playwright/test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Visual inspection of the two zero-setup static HTML viewers shipped with the
 * examples. Loaded via file:// — asserts each renders its shell (title + heading).
 *
 * Structural (not pixel) on purpose: the viewers render a live, animated
 * "Connecting…" connection badge, so a full-page screenshot is non-deterministic
 * between runs. The deterministic pixel baseline lives in board-visual.spec.ts
 * (the React board); these confirm the static viewers load + render correctly.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const viewers = [
  { name: 'blog-team', file: 'examples/blog-team/viewer/board.html' },
  { name: 'global-research', file: 'examples/global-research/viewer/board.html' },
];

test.describe('Example static viewers — visual inspection', () => {
  for (const v of viewers) {
    test(`${v.name} viewer renders its shell`, async ({ page }) => {
      await page.goto(pathToFileURL(path.join(ROOT, v.file)).href);
      await expect(page).toHaveTitle(/Kaiban Distributed/);
      await expect(page.locator('h1')).toContainText('Kaiban Distributed');
    });
  }
});
