/**
 * Live E2E global setup — starts the Global Research Swarm Docker stack.
 *
 * Lifecycle:
 *   setup()    → npm run build → docker compose up (global-research)
 *   teardown() → docker compose down
 *
 * Used by vitest.e2e.live.config.ts (test:e2e:live).
 */
import { execSync } from 'child_process';
import { resolve } from 'path';

function assertDockerAvailable(): void {
  try { execSync('docker --version', { stdio: 'pipe' }); }
  catch { throw new Error('[E2E Setup] Docker not found — install Docker Desktop and try again'); }
}

const ROOT         = resolve(__dirname, '../../..');
const COMPOSE_FILE = 'examples/global-research/docker-compose.yml';
const ENV_FILE     = '.env';

async function waitForGateway(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://localhost:3000/health');
      if (res.ok) return;
    } catch {
      // not ready yet — keep polling
    }
    await new Promise(r => setTimeout(r, 2_000));
  }
  throw new Error('[Live E2E] Gateway did not become healthy within timeout');
}

export async function setup(): Promise<void> {
  assertDockerAvailable();
  console.log('\n[Live E2E] ── Building TypeScript ─────────────────────────────');
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });

  console.log('[Live E2E] ── Starting Docker Compose (global-research) ─────────');
  execSync(
    `docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} up -d --build --remove-orphans`,
    { cwd: ROOT, stdio: 'inherit' },
  );

  console.log('[Live E2E] ── Waiting for gateway /health ──────────────────────');
  await waitForGateway();
  console.log('[Live E2E] ✓ Gateway healthy');

  // Allow agent workers extra time to subscribe to their queues
  console.log('[Live E2E] ── Waiting 12s for agents to register ───────────────');
  await new Promise(r => setTimeout(r, 12_000));
  console.log('[Live E2E] ✓ Stack ready\n');
}

export async function teardown(): Promise<void> {
  console.log('\n[Live E2E] ── Stopping Docker Compose ─────────────────────────');
  try {
    execSync(
      `docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} down`,
      { cwd: ROOT, stdio: 'inherit' },
    );
  } catch {
    // best-effort — don't mask test failures
  }
  console.log('[Live E2E] ✓ Stack stopped\n');
}
