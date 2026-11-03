// SPDX-License-Identifier: GPL-3.0-only
import { test, expect } from '@playwright/test';

/**
 * Emergency STOP ALL on the live board (ADR-025). Needs a gateway started with
 * CONTROL_PLANE_ENABLED=true and BOARD_JWT_SECRET, the board dev server started
 * with VITE_BOARD_TOKEN, and one stop already issued (the banner shows it).
 * Run: BOARD_CONTROL_PLANE=1 npm run test:visual -- board-control
 */
test.describe('Kaiban board — emergency STOP ALL', () => {
  test.skip(!process.env.BOARD_CONTROL_PLANE, 'needs a gateway with CONTROL_PLANE_ENABLED=true');

  test('shows the STOP ALL button, the last stop, and a confirmation before stopping', async ({ page }) => {
    await page.goto('/');
    const button = page.getByRole('button', { name: 'STOP ALL' });
    await expect(button).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('status').filter({ hasText: 'Emergency stop at' })).toBeVisible();

    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Stop everything now?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Reason (optional)')).toBeVisible();
    await expect(dialog).toHaveScreenshot('stop-all-dialog.png');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });
});
