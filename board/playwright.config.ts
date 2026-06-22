import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright visual-inspection config for the Kaiban board.
 *
 * Requires the board dev server (`npm run dev` → :5173) and a running gateway.
 * Run:  npm run test:visual            (compare against committed baselines)
 *       npm run test:visual:update     (regenerate baselines)
 *
 * BOARD_URL overrides the dev-server URL.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BOARD_URL ?? 'http://localhost:5173',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  expect: {
    // Visual baselines tolerate minor anti-aliasing / dynamic-content drift.
    toHaveScreenshot: { maxDiffPixelRatio: 0.1, animations: 'disabled' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
