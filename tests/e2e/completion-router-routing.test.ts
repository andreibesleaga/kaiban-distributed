/**
 * E2E: CompletionRouter completion routing against real Redis/BullMQ.
 *
 * Regression for the competing-consumer hang fixed on feat/v2.0:
 *   Two CompletionRouters on one node (the gateway's A2A-executor router and an
 *   orchestrator's router) shared the durable BullMQ `kaiban-events-completed`
 *   queue as COMPETING consumers. The gateway router — which never dispatches in
 *   the examples — used to subscribe eagerly in its constructor and could win,
 *   then silently DROP, a completion meant for the orchestrator's router, hanging
 *   the real waiter until timeout.
 *   Fix (src/shared/completion-router.ts): subscribe LAZILY on the first wait(),
 *   so a router that never waits never creates a Worker and never consumes the
 *   queue. BullMQ is durable, so a completion published before the waiting router
 *   subscribes still waits in the queue for it.
 *
 * Unit coverage proves "no subscribe without wait()"; this proves the resulting
 * routing behaviour at the real broker. Runs against the Redis started by
 * tests/e2e/setup/globalSetup.ts. No real LLM — synthetic completion payloads.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { BullMQDriver } from "../../src/infrastructure/messaging/bullmq-driver";
import { CompletionRouter } from "../../src/shared/completion-router";
import type { MessagePayload } from "../../src/infrastructure/messaging/interfaces";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const COMPLETED = "kaiban-events-completed";
const FAILED = "kaiban-events-failed";

function connConfig(): { connection: { host: string; port: number } } {
  const url = new URL(REDIS_URL);
  return {
    connection: { host: url.hostname, port: parseInt(url.port || "6379", 10) },
  };
}

function completion(taskId: string, result: unknown): MessagePayload {
  return { taskId, agentId: "oracle", data: { result }, timestamp: Date.now() };
}
function failure(taskId: string, error: string): MessagePayload {
  return { taskId, agentId: "oracle", data: { error }, timestamp: Date.now() };
}

describe("CompletionRouter routing (real Redis/BullMQ)", () => {
  const drivers: BullMQDriver[] = [];

  afterEach(async () => {
    await Promise.all(drivers.map((d) => d.disconnect().catch(() => undefined)));
    drivers.length = 0;
  });

  function newDriver(): BullMQDriver {
    const d = new BullMQDriver(connConfig());
    drivers.push(d);
    return d;
  }

  it("resolves wait() when a completion is published to the completed queue", async () => {
    const router = new CompletionRouter(newDriver());
    const producer = newDriver();
    const taskId = randomUUID();

    const pending = router.wait(taskId, 20000, "single");
    await new Promise((r) => setTimeout(r, 400)); // let the lazy subscribe land
    await producer.publish(COMPLETED, completion(taskId, `DONE-${taskId}`));

    await expect(pending).resolves.toContain(`DONE-${taskId}`);
  });

  it("rejects wait() when a failure is published to the failed (DLQ) queue", async () => {
    const router = new CompletionRouter(newDriver());
    const producer = newDriver();
    const taskId = randomUUID();

    const pending = router.wait(taskId, 20000, "failing");
    await new Promise((r) => setTimeout(r, 400));
    await producer.publish(FAILED, failure(taskId, "synthetic-llm-error"));

    await expect(pending).rejects.toThrow(/synthetic-llm-error/);
  });

  it("a never-waiting router does NOT consume — completion still reaches the waiting router", async () => {
    // `idle` is constructed FIRST and shares the same completed queue but never
    // calls wait(). With eager subscribe (the old bug) it could have grabbed and
    // dropped the completion below, hanging `active` to timeout. Lazy subscribe
    // means `idle` never creates a Worker, so only `active` consumes.
    const idle = new CompletionRouter(newDriver());
    expect(idle).toBeInstanceOf(CompletionRouter); // constructed, never waits

    const active = new CompletionRouter(newDriver());
    const producer = newDriver();
    const taskId = randomUUID();

    const pending = active.wait(taskId, 20000, "active");
    await new Promise((r) => setTimeout(r, 400));
    await producer.publish(COMPLETED, completion(taskId, `ROUTED-${taskId}`));

    await expect(pending).resolves.toContain(`ROUTED-${taskId}`);
  });
});
