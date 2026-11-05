// SPDX-License-Identifier: GPL-3.0-only
import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

/**
 * Emergency STOP ALL in the static HTML viewers (ADR-025, 2.1.1).
 *
 * Deterministic and offline: each test starts a stub gateway (a plain HTTP server
 * that serves the viewer and runs a socket.io server), so nothing touches the
 * network. The viewer's CDN <script> tag is swapped for the socket.io client the
 * stub serves itself. Runs without the board dev server: npm run test:visual -- viewers-control
 *
 * The examples-repo copy of the viewer is checked too when EXAMPLES_VIEWER_DIR points at it.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const TOKEN = 'test-token-not-a-secret';

const viewers: { name: string; dir: string }[] = [
  { name: 'blog-team', dir: path.join(ROOT, 'examples/blog-team/viewer') },
  { name: 'global-research', dir: path.join(ROOT, 'examples/global-research/viewer') },
];
if (process.env.EXAMPLES_VIEWER_DIR) {
  viewers.push({ name: 'examples-repo', dir: path.resolve(process.env.EXAMPLES_VIEWER_DIR) });
}

interface StubOptions {
  /** Snapshot `controlPlane`; omitted = control plane off. */
  controlPlane?: { enabled: true; acks: number; lastStop?: Record<string, unknown> };
  /** Require the board token in the handshake (BOARD_JWT_SECRET set). */
  requireToken?: boolean;
  /** How the stub answers control:stop-all. */
  /** `late`: confirms after the viewer's 8 s timeout has fired. */
  ack?: 'ok' | 'refuse' | 'none' | 'late';
  tasks?: Record<string, unknown>[];
}

interface Stub {
  url: string;
  handshakes: unknown[];
  stopPayloads: unknown[];
  io: Server;
  close: () => Promise<void>;
}

const CDN_TAG = /<script src="https:\/\/cdn\.socket\.io[^>]*><\/script>/;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

async function startStub(viewerDir: string, opts: StubOptions): Promise<Stub> {
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    const name = pathname === '/' ? 'board.html' : path.basename(pathname);
    try {
      let body = readFileSync(path.join(viewerDir, name), 'utf8');
      if (name === 'board.html') body = body.replace(CDN_TAG, '<script src="/socket.io/socket.io.js"></script>');
      res.writeHead(200, { 'content-type': MIME[path.extname(name)] ?? 'text/plain' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  const io = new Server(server);
  const handshakes: unknown[] = [];
  const stopPayloads: unknown[] = [];

  io.use((socket, next) => {
    handshakes.push(socket.handshake.auth);
    if (opts.requireToken && socket.handshake.auth['token'] !== TOKEN) return next(new Error('Missing board token'));
    next();
  });
  io.on('connection', (socket) => {
    const snapshot = (): boolean =>
      socket.emit('state:update', {
        teamWorkflowStatus: 'RUNNING',
        agents: [],
        tasks: opts.tasks ?? [],
        ...(opts.controlPlane ? { controlPlane: opts.controlPlane } : {}),
      });
    snapshot();
    socket.on('state:request', snapshot);
    socket.on('control:stop-all', (payload: unknown, ack?: (r: unknown) => void) => {
      stopPayloads.push(payload);
      if (opts.ack === 'none') return;
      if (opts.ack === 'refuse') return ack?.({ ok: false, error: 'Missing board token' });
      if (opts.ack === 'late') {
        setTimeout(() => ack?.({ ok: true, commandId: 'cmd-12345678-aaaa' }), 9_500);
        return;
      }
      ack?.({ ok: true, commandId: 'cmd-12345678-aaaa' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    handshakes,
    stopPayloads,
    io,
    close: () =>
      new Promise<void>((resolve) => {
        void io.close(() => resolve());
      }),
  };
}

const PLANE_ON = { enabled: true as const, acks: 0 };

for (const v of viewers) {
  test.describe(`${v.name} viewer — emergency STOP ALL`, () => {
    let stub: Stub | undefined;
    test.afterEach(async () => {
      await stub?.close();
      stub = undefined;
    });

    async function open(page: Page, opts: StubOptions, hash = ''): Promise<void> {
      stub = await startStub(v.dir, opts);
      await page.goto(`${stub.url}/?gateway=${encodeURIComponent(stub.url)}${hash}`);
      await expect(page.locator('#conn-badge')).toContainText(/LIVE|Error/);
    }

    test('hides the button and the banner when the control plane is off', async ({ page }) => {
      await open(page, {});
      await expect(page.locator('#conn-badge')).toContainText('LIVE');
      await expect(page.getByRole('button', { name: 'STOP ALL' })).toHaveCount(0);
      await expect(page.locator('#banner-control')).toBeHidden();
    });

    test('shows the button when the control plane is on', async ({ page }) => {
      await open(page, { controlPlane: PLANE_ON });
      await expect(page.getByRole('button', { name: 'STOP ALL' })).toBeVisible();
    });

    test('is keyboard operable with a visible focus ring; Escape and Cancel send nothing', async ({ page }) => {
      await open(page, { controlPlane: PLANE_ON });
      const button = page.getByRole('button', { name: 'STOP ALL' });
      await expect(button).toBeVisible();
      // Reach the button by keyboard alone; how many Tab presses that takes depends on
      // where the browser puts the initial focus, so press until it lands (bounded).
      for (let i = 0; i < 10 && !(await button.evaluate((el) => el === document.activeElement)); i++) {
        await page.keyboard.press('Tab');
      }
      await expect(button).toBeFocused();
      expect(await button.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');

      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Stop everything now?' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Reason (optional)')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();

      await button.click();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      expect(stub!.stopPayloads).toEqual([]);
    });

    test('confirming emits control:stop-all with the reason and the handshake token; the ack banner follows', async ({ page }) => {
      await open(page, { controlPlane: PLANE_ON, requireToken: true }, `#token=${TOKEN}`);
      await expect(page.locator('#conn-badge')).toContainText('LIVE');
      expect(stub!.handshakes).toContainEqual({ token: TOKEN });

      await page.getByRole('button', { name: 'STOP ALL' }).click();
      const dialog = page.getByRole('dialog', { name: 'Stop everything now?' });
      await dialog.getByLabel('Reason (optional)').fill('  runaway loop  ');
      await dialog.getByRole('button', { name: 'Stop all' }).click();
      await expect(dialog).toBeHidden();
      await expect.poll(() => stub!.stopPayloads).toEqual([{ reason: 'runaway loop' }]);
      await expect(page.locator('#log-box')).toContainText('STOP ALL issued (command cmd-1234)');

      // The gateway announces the stop, then two nodes acknowledge it (control deltas).
      const base = { commandId: 'cmd-12345678-aaaa', issuedAt: Date.UTC(2026, 10, 4, 9, 30, 15), issuedBy: 'ops-1', reason: 'runaway loop' };
      stub!.io.emit('state:update', { control: { ...base, nodeId: 'gw', outcome: 'issued', aborted: 0, at: base.issuedAt } });
      stub!.io.emit('state:update', { control: { ...base, nodeId: 'n1', outcome: 'applied', aborted: 2, at: base.issuedAt } });
      stub!.io.emit('state:update', { control: { ...base, nodeId: 'n2', outcome: 'noop', aborted: 0, at: base.issuedAt } });
      const banner = page.locator('#banner-control');
      await expect(banner).toBeVisible();
      await expect(banner).toContainText('Emergency stop at');
      await expect(banner).toContainText('by ops-1');
      await expect(banner).toContainText('runaway loop');
      await expect(banner).toContainText('2 node acknowledgements');
    });

    test('the token is read from window.BOARD_TOKEN too', async ({ page }) => {
      await page.addInitScript((t) => {
        (window as unknown as { BOARD_TOKEN: string }).BOARD_TOKEN = t;
      }, TOKEN);
      await open(page, { controlPlane: PLANE_ON, requireToken: true });
      await expect(page.locator('#conn-badge')).toContainText('LIVE');
      expect(stub!.handshakes).toContainEqual({ token: TOKEN });
    });

    test('without a token a protected gateway refuses the connection; nothing is sent in the handshake', async ({ page }) => {
      await open(page, { controlPlane: PLANE_ON, requireToken: true });
      await expect(page.locator('#conn-badge')).toContainText('Error');
      expect(stub!.handshakes.every((h) => Object.keys(h as object).length === 0)).toBe(true);
    });

    test('removes the token from the address bar and never stores it', async ({ page }) => {
      await open(page, { controlPlane: PLANE_ON, requireToken: true }, `#token=${TOKEN}`);
      await expect(page.locator('#conn-badge')).toContainText('LIVE');
      expect(page.url()).not.toContain('token');
      expect(page.url()).not.toContain(TOKEN);
      const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]));
      expect(stored).not.toContain(TOKEN);
      await expect(page.locator('#log-box')).not.toContainText(TOKEN);
    });

    test('shows a visible error naming npm run stop-all when the gateway never answers', async ({ page }) => {
      test.setTimeout(30_000);
      await open(page, { controlPlane: PLANE_ON, ack: 'none' });
      await page.getByRole('button', { name: 'STOP ALL' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Stop all' }).click();
      const alert = page.getByRole('alert');
      await expect(alert).toBeHidden();
      await expect(alert).toContainText('npm run stop-all', { timeout: 15_000 });
      await expect(alert).toContainText('8s');
    });

    test('a confirmation that arrives after the timeout clears the alert and logs the stop', async ({ page }) => {
      test.setTimeout(30_000);
      await open(page, { controlPlane: PLANE_ON, ack: 'late' });
      await page.getByRole('button', { name: 'STOP ALL' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Stop all' }).click();
      const alert = page.getByRole('alert');
      await expect(alert).toContainText('npm run stop-all', { timeout: 15_000 });
      await expect(alert).toBeHidden({ timeout: 15_000 });
      await expect(page.locator('#log-box')).toContainText('STOP ALL issued (command cmd-1234)');
    });

    test('shows the gateway refusal', async ({ page }) => {
      await open(page, { controlPlane: PLANE_ON, ack: 'refuse' });
      await page.getByRole('button', { name: 'STOP ALL' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Stop all' }).click();
      await expect(page.getByRole('alert')).toContainText('STOP ALL refused: Missing board token');
    });

    test('shows the last stop from the snapshot and puts STOPPED tasks in Blocked with a Stopped badge', async ({ page }) => {
      await open(page, {
        controlPlane: { enabled: true, acks: 1, lastStop: { commandId: 'c1', issuedAt: Date.UTC(2026, 10, 4, 9, 0, 0), issuedBy: 'cli' } },
        tasks: [{ taskId: 't1', title: 'Draft the post', status: 'STOPPED', agent: { name: 'Writer' } }],
      });
      const blocked = page.locator('#col-blocked');
      await expect(blocked).toContainText('Draft the post');
      await expect(blocked.locator('.task-badge-stopped')).toHaveText(/Stopped/);
      await expect(page.locator('#cnt-blocked')).toHaveText('1');
      await expect(page.locator('#banner-control')).toContainText('by cli');
      await expect(page.locator('#banner-control')).toContainText('1 node acknowledgement');
      await expect(page.locator('#banner-control')).not.toContainText('acknowledgements');
    });
  });
}
