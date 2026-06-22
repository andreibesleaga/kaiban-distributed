import { test, expect } from '@playwright/test';

/**
 * Visual + structural inspection of the live React board (the "main software" UI).
 * Requires the board dev server (:5173) connected to a running gateway.
 */
test.describe('Kaiban board — visual inspection', () => {
  test('renders the live board shell (title, kanban columns, panels)', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/Kaiban Distributed/);

    // Kanban columns are always present (the workflow read-model). Wait for the
    // first one — the React app + socket connection take a moment to render.
    await expect(page.getByText('To Do', { exact: false }).first()).toBeVisible({
      timeout: 15000,
    });
    for (const col of ['In Progress', 'Review', 'Done']) {
      await expect(page.getByText(col, { exact: false }).first()).toBeVisible();
    }

    // Event Log panel.
    await expect(
      page.getByText('Event Log', { exact: false }).first(),
    ).toBeVisible();

    // Full-page visual baseline.
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('board-full.png', { fullPage: true });
  });
});
