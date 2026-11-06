// SPDX-License-Identifier: GPL-3.0-only
import { test, expect } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer, type ViteDevServer } from 'vite';
import { Server } from 'socket.io';

/**
 * Text contrast of the React board in a real browser (WCAG AA, 4.5:1).
 *
 * The jsdom axe tests under src/__tests__ cannot judge contrast (jsdom loads no CSS, so axe reports
 * "incomplete"). This spec starts the board on a random port with Vite, feeds it a stub gateway
 * (random port, no network), and runs axe's color-contrast rule on the rendered page.
 * Run: npm run test:visual -- board-contrast
 */
const require = createRequire(import.meta.url);
const BOARD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TASKS = [
  { taskId: 't1', title: 'Todo task', status: 'TODO', assignedToAgentId: 'a1' },
  { taskId: 't2', title: 'Doing task', status: 'DOING', assignedToAgentId: 'a1', result: 'working' },
  { taskId: 't3', title: 'Review task', status: 'AWAITING_VALIDATION', assignedToAgentId: 'a1', result: 'needs a human' },
  { taskId: 't4', title: 'Done task', status: 'DONE', assignedToAgentId: 'a1', result: 'ok', tokens: 12, cost: 0.001 },
  { taskId: 't5', title: 'Stopped task', status: 'STOPPED', assignedToAgentId: 'a1' },
];

test.describe('Kaiban board — text contrast (real browser)', () => {
  let vite: ViteDevServer | undefined;
  let gateway: http.Server | undefined;
  let io: Server | undefined;

  test.afterEach(async () => {
    await vite?.close();
    await io?.close();
    gateway = undefined;
  });

  test('meets WCAG AA with every column, an agent, the log and a STOP ALL error on screen', async ({ page }) => {
    gateway = http.createServer();
    io = new Server(gateway, { cors: { origin: '*' } });
    io.on('connection', (socket) => {
      socket.emit('state:update', {
        teamWorkflowStatus: 'RUNNING',
        inputs: { topic: 'Contrast check' },
        agents: [{ agentId: 'a1', name: 'Writer', role: 'writer', status: 'EXECUTING', currentTaskId: 't2' }],
        tasks: TASKS,
        metadata: { startTime: Date.UTC(2026, 10, 4, 9, 0, 0), totalTokens: 10, estimatedCost: 0.01 },
        controlPlane: { enabled: true, acks: 0 },
      });
      socket.on('control:stop-all', (_payload: unknown, ack?: (r: unknown) => void) => ack?.({ ok: false, error: 'Missing board token' }));
    });
    await new Promise<void>((resolve) => gateway!.listen(0, '127.0.0.1', resolve));
    const gatewayUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;

    vite = await createServer({ root: BOARD_DIR, server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
    await vite.listen();
    const boardUrl = vite.resolvedUrls!.local[0]!;

    await page.goto(`${boardUrl}?gateway=${encodeURIComponent(gatewayUrl)}`);
    await expect(page.getByRole('button', { name: /View details for task: Doing task/ })).toBeVisible();
    await page.getByRole('button', { name: 'STOP ALL' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Stop all' }).click();
    await expect(page.getByRole('alert')).toContainText('STOP ALL refused: Missing board token');

    await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
    const failures = await page.evaluate(async () => {
      type Node = { html: string; any: { data: { contrastRatio: number; fgColor: string; bgColor: string } }[] };
      const axe = (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: { nodes: Node[] }[] }> } }).axe;
      const result = await axe.run(document, { runOnly: ['color-contrast'] });
      return result.violations.flatMap((v) =>
        v.nodes.map((n) => `${n.html.slice(0, 90)} -> ${n.any[0]?.data.contrastRatio}:1 (${n.any[0]?.data.fgColor} on ${n.any[0]?.data.bgColor})`),
      );
    });
    expect(failures).toEqual([]);
  });
});
