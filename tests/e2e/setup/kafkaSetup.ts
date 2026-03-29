import { execSync, spawnSync } from 'child_process';

const COMPOSE_FILE = 'docker-compose.yml';

function assertDockerAvailable(): void {
  try { execSync('docker --version', { stdio: 'pipe' }); }
  catch { throw new Error('[E2E Setup] Docker not found — install Docker Desktop and try again'); }
}
const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 120000;

function isKafkaReady(): boolean {
  const result = spawnSync(
    'docker',
    ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'kafka',
      'kafka-topics', '--bootstrap-server', 'localhost:9092', '--list'],
    { encoding: 'utf8', timeout: 10000 },
  );
  return result.status === 0;
}

async function waitForKafka(): Promise<void> {
  const start = Date.now();
  console.log('[Kafka E2E] Waiting for Kafka to be ready...');
  while (Date.now() - start < MAX_WAIT_MS) {
    if (isKafkaReady()) {
      console.log('[Kafka E2E] Kafka ready.');
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('Kafka did not become healthy within timeout');
}

export async function setup(): Promise<void> {
  assertDockerAvailable();
  console.log('[Kafka E2E] Starting stack (Redis + Zookeeper + Kafka)...');
  execSync(`docker compose -f ${COMPOSE_FILE} up -d redis zookeeper kafka`, {
    stdio: 'inherit',
    timeout: 60000,
    env: { ...process.env, REDIS_PASSWORD: process.env['REDIS_PASSWORD'] || '' }
  });
  await waitForKafka();
}

export async function teardown(): Promise<void> {
  console.log('[Kafka E2E] Stopping services...');
  execSync(`docker compose -f ${COMPOSE_FILE} down`, {
    stdio: 'inherit',
    timeout: 30000,
    env: { ...process.env, REDIS_PASSWORD: process.env['REDIS_PASSWORD'] || '' }
  });
}
