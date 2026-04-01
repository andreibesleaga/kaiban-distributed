import { execSync, spawnSync } from "child_process";

const COMPOSE_FILE = "docker-compose.yml";

function assertDockerAvailable(): void {
  try {
    execSync("docker --version", { stdio: "pipe" });
  } catch {
    throw new Error(
      "[E2E Setup] Docker not found — install Docker Desktop and try again",
    );
  }
}
const POLL_INTERVAL_MS = 1000;
const MAX_WAIT_MS = 60000;

function isRedisReady(): boolean {
  const result = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "exec", "-T", "redis", "redis-cli", "ping"],
    { encoding: "utf8", timeout: 5000 },
  );
  return result.status === 0 && result.stdout.includes("PONG");
}

async function waitForRedis(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    if (isRedisReady()) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("Redis did not become healthy within timeout");
}

export async function setup(): Promise<void> {
  assertDockerAvailable();
  console.log("[E2E] Starting Redis...");
  try {
    execSync(`docker compose -f ${COMPOSE_FILE} up -d redis`, {
      stdio: "pipe",
      timeout: 30000,
      env: {
        ...process.env,
        REDIS_PASSWORD: process.env["REDIS_PASSWORD"] || "",
      },
    });
  } catch {
    // Port already in use — Redis is already running (e.g. from another compose stack)
    console.log("[E2E] Redis already running, skipping start.");
  }
  console.log("[E2E] Waiting for Redis to be ready...");
  await waitForRedis();
  console.log("[E2E] Redis ready.");
}

export async function teardown(): Promise<void> {
  console.log("[E2E] Stopping Docker Compose services...");
  execSync(`docker compose -f ${COMPOSE_FILE} down`, {
    stdio: "inherit",
    timeout: 30000,
  });
}
