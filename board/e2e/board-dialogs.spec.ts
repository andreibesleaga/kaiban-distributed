// SPDX-License-Identifier: GPL-3.0-only
import { test, expect, type Page, type Locator } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { Server } from 'socket.io';

/**
 * Placement of the board's two native modal dialogs in a real browser.
 *
 * Tailwind's reset sets `margin: 0` on every element, which removes the browser's own
 * `margin: auto` that centres a modal <dialog>; without a margin class the dialog opens in the
 * top-left corner (both dialogs carry `m-auto`). jsdom does no layout, so only a browser can check this. The board runs on
 * Vite with a stub gateway (random ports, no network).
 * Run: npm run test:visual -- board-dialogs
 */
const BOARD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function expectCentred(page: Page, dialog: Locator): Promise<void> {
  const box = await dialog.boundingBox();
  const vp = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(Math.abs(box!.x + box!.width / 2 - vp.width / 2)).toBeLessThan(2);
  expect(Math.abs(box!.y + box!.height / 2 - vp.height / 2)).toBeLessThan(2);
}

test.describe('Kaiban board — modal dialogs are centred', () => {
  let vite: ViteDevServer | undefined;
  let io: Server | undefined;

  test.afterEach(async () => {
    await vite?.close();
    await io?.close();
  });

  test('the STOP ALL confirmation and the task detail open in the middle of the window', async ({ page }) => {
    const gateway = http.createServer();
    io = new Server(gateway, { cors: { origin: '*' } });
    io.on('connection', (socket) => {
      socket.emit('state:update', {
        teamWorkflowStatus: 'RUNNING',
        agents: [{ agentId: 'a1', name: 'Writer', role: 'writer', status: 'EXECUTING', currentTaskId: 't1' }],
        tasks: [{ taskId: 't1', title: 'Doing task', status: 'DOING', assignedToAgentId: 'a1', result: 'working' }],
        controlPlane: { enabled: true, acks: 0 },
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const gatewayUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
    vite = await createServer({ root: BOARD_DIR, server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
    await vite.listen();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${vite.resolvedUrls!.local[0]!}?gateway=${encodeURIComponent(gatewayUrl)}`);

    await page.getByRole('button', { name: 'STOP ALL' }).click();
    const stop = page.getByRole('dialog', { name: 'Stop everything now?' });
    await expect(stop).toBeVisible();
    await expectCentred(page, stop);
    await stop.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: /View details for task: Doing task/ }).click();
    const detail = page.getByRole('dialog');
    await expect(detail).toBeVisible();
    await expectCentred(page, detail);
  });
});
