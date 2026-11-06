// SPDX-License-Identifier: GPL-3.0-only
import { test, expect } from '@playwright/test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Visual inspection of the two zero-setup static HTML viewers shipped with the
 * examples. Loaded via file:// — asserts each renders its shell (title + heading).
 *
 * Structural (not pixel) on purpose: the viewers render a live, animated
 * "Connecting…" connection badge, so a full-page screenshot is non-deterministic
 * between runs. The deterministic pixel baseline lives in board-visual.spec.ts
 * (the React board); these confirm the static viewers load + render correctly.
 *
 * What runs in the viewer's script (connect, render, STOP ALL) needs a socket.io client, which the
 * viewers load from a CDN with an SRI hash. That is covered offline by viewers-control.spec.ts
 * (stub gateway, swapped client). Here, besides the shell, the page source is checked for what a
 * browser cannot be asked about: the security tags every viewer must carry.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const viewers = [
  { name: 'blog-team', file: 'examples/blog-team/viewer/board.html' },
  { name: 'global-research', file: 'examples/global-research/viewer/board.html' },
];
// The examples-repo copy is checked too when EXAMPLES_VIEWER_DIR points at it.
if (process.env.EXAMPLES_VIEWER_DIR) {
  viewers.push({ name: 'examples-repo', file: path.join(path.resolve(process.env.EXAMPLES_VIEWER_DIR), 'board.html') });
}
const fileOf = (v: { file: string }): string => (path.isAbsolute(v.file) ? v.file : path.join(ROOT, v.file));

test.describe('Example static viewers — visual inspection', () => {
  for (const v of viewers) {
    test(`${v.name} viewer renders its shell`, async ({ page }) => {
      await page.goto(pathToFileURL(fileOf(v)).href);
      await expect(page).toHaveTitle(/Kaiban Distributed/);
      await expect(page.locator('h1')).toContainText('Kaiban Distributed');
    });
  }

  for (const v of viewers) {
    test(`${v.name} viewer page source: CSP, referrer policy, SRI, no inline styles`, () => {
      const html = readFileSync(fileOf(v), 'utf8');
      expect(html).toMatch(/http-equiv="Content-Security-Policy"[^>]*script-src 'self' https:\/\/cdn\.socket\.io/);
      expect(html).toMatch(/<meta name="referrer" content="no-referrer">/);
      const cdnTag = /<script[^>]*src="https:\/\/cdn\.socket\.io[^>]*>/.exec(html)?.[0] ?? '';
      expect(cdnTag).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
      expect(cdnTag).toContain('crossorigin="anonymous"');
      // The CSP has style-src 'self': a style="" attribute would be blocked and logged on every load.
      expect(html).not.toMatch(/\sstyle="/);
      // Browsers ignore this header in a <meta> tag; it would only suggest a protection that is not there.
      expect(html).not.toMatch(/http-equiv="X-(Content-Type-Options|Frame-Options)"/);
    });
  }
});
