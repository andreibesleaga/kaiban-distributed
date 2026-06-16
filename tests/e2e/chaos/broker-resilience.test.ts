import { describe, it, expect, afterAll } from "vitest";
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import { BullMQDriver } from "../../../src/infrastructure/messaging/bullmq-driver";
import { AgentActor } from "../../../src/application/actor/AgentActor";

/**
 * Basic broker fault-injection (chaos) e2e — proves graceful degradation and
 * recovery when the Redis broker goes away mid-flight.
 *
 * Mechanism: `docker compose pause redis` freezes the broker (TCP stays
 * ESTABLISHED but unresponsive), so ioredis experiences a transient outage and
 * buffers in-flight commands instead of dropping them. `unpause` resumes the
 * broker; the buffered publishes flush and the worker drains every task — at
 * least once, zero dropped agent messages.
 *
 * Isolation guarantees (so this can never break the main e2e suite):
 *  - Runs only under `vitest.e2e.chaos.config.mts` (`test:e2e:chaos`); the main
 *    e2e config excludes `tests/e2e/chaos/**`.
 *  - Pause/unpause (not stop/start) keeps the container and its connections
 *    alive — far less disruptive than killing the process.
 *  - `afterAll` + a `finally` ALWAYS unpause the broker, even on assertion
 *    failure, so Redis is left healthy for any later run.
 */

const COMPOSE_FILE = "docker-compose.yml";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

function pauseRedis(): void {
  execSync(`docker compose -f ${COMPOSE_FILE} pause redis`, {
    stdio: "pipe",
    timeout: 15000,
  });
}

function unpauseRedis(): void {
  // Idempotent: `unpause` errors if the container is already running, which is
  // fine — we only care that it ends up unpaused.
  try {
    execSync(`docker compose -f ${COMPOSE_FILE} unpause redis`, {
      stdio: "pipe",
      timeout: 15000,
    });
  } catch {
    /* already running — nothing to do */
  }
}

function redisResponds(): boolean {
  try {
    const out = execSync(
      `docker compose -f ${COMPOSE_FILE} exec -T redis redis-cli ping`,
      { stdio: "pipe", timeout: 5000, encoding: "utf8" },
    );
    return out.includes("PONG");
  } catch {
    return false;
  }
}

async function waitForRedis(maxMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (redisResponds()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Redis did not recover within timeout");
}

describe("E2E Chaos: broker fault injection (Redis pause/unpause)", () => {
  // Safety net: whatever happens, leave the broker healthy for other suites.
  afterAll(() => {
    unpauseRedis();
  });

  it("buffers in-flight publishes during a broker outage and drains every task on recovery", async () => {
    const url = new URL(REDIS_URL);
    const connConfig = {
      connection: {
        host: url.hostname,
        port: parseInt(url.port || "6379", 10),
      },
    };

    const QUEUE_NAME = `e2e-chaos-queue-${randomUUID()}`;
    const AGENT_ID = "e2e-chaos-agent";
    const RUN_ID = randomUUID().slice(0, 8);

    const publisher = new BullMQDriver(connConfig);
    const consumerDriver = new BullMQDriver(connConfig);

    const received = new Set<string>();
    const handler = async (payload: {
      taskId?: unknown;
    }): Promise<unknown> => {
      if (typeof payload.taskId === "string") received.add(payload.taskId);
      return { ok: true };
    };
    const actor = new AgentActor(
      AGENT_ID,
      consumerDriver,
      QUEUE_NAME,
      handler as (payload: unknown) => Promise<unknown>,
    );

    try {
      await actor.start();
      // Let the worker attach before producing load.
      await new Promise((r) => setTimeout(r, 1000));

      const mkTask = (i: number): {
        taskId: string;
        agentId: string;
        data: { instruction: string };
        timestamp: number;
      } => ({
        taskId: `chaos-${RUN_ID}-${i}`,
        agentId: AGENT_ID,
        data: { instruction: `do work ${i}` },
        timestamp: Date.now(),
      });

      // 1) Healthy baseline — publish + drain a first batch.
      const PRE = 5;
      for (let i = 0; i < PRE; i++) await publisher.publish(QUEUE_NAME, mkTask(i));
      await waitFor(() => received.size >= PRE, 15000);
      expect(received.size).toBeGreaterThanOrEqual(PRE);

      // 2) Outage — freeze the broker, then fire a batch WITHOUT awaiting (the
      //    promises buffer in ioredis' offline queue while Redis is frozen).
      pauseRedis();
      const DURING = 8;
      const inFlight: Promise<void>[] = [];
      for (let i = PRE; i < PRE + DURING; i++) {
        inFlight.push(publisher.publish(QUEUE_NAME, mkTask(i)));
      }
      // Hold the outage briefly so the publishes genuinely hit a dead broker.
      await new Promise((r) => setTimeout(r, 2500));

      // 3) Recovery — resume the broker and wait for it to answer.
      unpauseRedis();
      await waitForRedis();

      // The buffered publishes must now resolve (none dropped/rejected).
      await Promise.all(inFlight);

      // 4) Every task — pre-outage and buffered-during-outage — is delivered.
      const TOTAL = PRE + DURING;
      await waitFor(() => received.size >= TOTAL, 20000);
      expect(received.size).toBe(TOTAL);
      for (let i = 0; i < TOTAL; i++) {
        expect(received.has(`chaos-${RUN_ID}-${i}`)).toBe(true);
      }
    } finally {
      unpauseRedis();
      await actor.stop().catch(() => undefined);
      await publisher.disconnect().catch(() => undefined);
      await consumerDriver.disconnect().catch(() => undefined);
    }
  }, 90000);
});

async function waitFor(
  predicate: () => boolean,
  maxMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}
