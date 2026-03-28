/**
 * Global setup for security E2E tests.
 *
 * Starts a standalone Redis container (not via docker-compose) with a password.
 * Using a dedicated container name avoids conflicts with the docker-compose redis.
 *
 * The password constant is duplicated in vitest.e2e.security.config.ts
 * because globalSetup runs in a separate process and cannot share env
 * injected by the Vitest `env` config block.
 */
import { execSync, spawnSync } from 'child_process';

/** Dedicated name — avoids conflicts with docker-compose redis containers. */
const SECURITY_REDIS_CONTAINER = 'kaiban-security-test-redis';
/** Use a separate port to avoid conflicts with any existing redis on 6379. */
const SECURITY_REDIS_PORT = 6380;

/** Must match the value in vitest.e2e.security.config.ts */
export const SECURITY_TEST_REDIS_PASSWORD = 'e2e-sec-redis-pass-32chars!!!!!';

function assertDockerAvailable(): void {
  try { execSync('docker --version', { stdio: 'pipe' }); }
  catch { throw new Error('[E2E Security] Docker not found — install Docker Desktop and try again'); }
}

const POLL_INTERVAL_MS = 500;
const MAX_WAIT_MS = 60_000;

function isRedisReady(): boolean {
  const result = spawnSync(
    'docker',
    [
      'exec', SECURITY_REDIS_CONTAINER,
      'redis-cli', '-a', SECURITY_TEST_REDIS_PASSWORD, '--no-auth-warning', 'ping',
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  return result.status === 0 && result.stdout.includes('PONG');
}

async function waitForRedis(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    if (isRedisReady()) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('[E2E Security] Redis did not become healthy within timeout');
}

function removeContainerIfExists(): void {
  // Force-stop and remove any existing container with the security test name
  spawnSync('docker', ['stop', SECURITY_REDIS_CONTAINER], { stdio: 'pipe', timeout: 10_000 });
  spawnSync('docker', ['rm', '-f', SECURITY_REDIS_CONTAINER], { stdio: 'pipe', timeout: 10_000 });
}

export async function setup(): Promise<void> {
  assertDockerAvailable();
  console.log('[E2E Security] Removing any leftover security-test Redis container...');
  removeContainerIfExists();
  // Brief pause to let Docker finish cleanup
  await new Promise((r) => setTimeout(r, 1000));

  console.log(`[E2E Security] Starting Redis on port ${SECURITY_REDIS_PORT} with password...`);
  execSync(
    [
      'docker run -d',
      `--name ${SECURITY_REDIS_CONTAINER}`,
      `-p 127.0.0.1:${SECURITY_REDIS_PORT}:6379`,
      'redis:7-alpine',
      `redis-server --requirepass ${SECURITY_TEST_REDIS_PASSWORD}`,
    ].join(' '),
    { stdio: 'pipe', timeout: 30_000 },
  );

  console.log('[E2E Security] Waiting for Redis (with password) to be ready...');
  await waitForRedis();
  console.log('[E2E Security] Redis ready.');
}

export async function teardown(): Promise<void> {
  console.log('[E2E Security] Removing security-test Redis container...');
  try {
    execSync(`docker stop ${SECURITY_REDIS_CONTAINER}`, { stdio: 'pipe', timeout: 10_000 });
    execSync(`docker rm -f ${SECURITY_REDIS_CONTAINER}`, { stdio: 'pipe', timeout: 10_000 });
  } catch { /* ignore */ }
  console.log('[E2E Security] Teardown complete.');
}
