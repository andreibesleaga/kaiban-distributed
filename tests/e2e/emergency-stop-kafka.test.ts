/**
 * E2E: emergency STOP ALL on a Kafka deployment (roadmap §6.10 ES-11, ADR-025).
 * Tasks travel over Kafka; the control channel is Redis Pub/Sub, as for state.
 * Requires: Redis + Kafka via docker-compose (started by kafkaSetup).
 */
import { randomUUID } from "crypto";
import { describe, it, expect, afterEach } from "vitest";
import Redis from "ioredis";
import { KafkaDriver } from "../../src/infrastructure/messaging/kafka-driver";
import { AgentActor } from "../../src/application/actor/AgentActor";
import { STOP_MOMENT_KEY, issueStopAll } from "../../src/infrastructure/control/control-channel";
import { attachEmergencyStop, createStopAllCommand } from "../../src/shared/emergency-stop";
import type { MessagePayload } from "../../src/infrastructure/messaging/interfaces";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const BROKERS = (process.env["KAFKA_BROKERS"] ?? "localhost:9092").split(",");
const closers: Array<() => Promise<unknown>> = [];
const kafka = (name: string): KafkaDriver => {
  const d = new KafkaDriver({ brokers: BROKERS, clientId: `e2e-${name}`, groupId: `e2e-${name}-${randomUUID()}` });
  closers.push(() => d.disconnect());
  return d;
};

async function until<T>(check: () => T | undefined, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

afterEach(async () => {
  while (closers.length) await closers.pop()!().catch(() => undefined);
  const redis = new Redis(REDIS_URL);
  await redis.del(STOP_MOMENT_KEY);
  await redis.quit();
});

describe("E2E: emergency STOP ALL (Kafka + Redis control channel)", () => {
  it("kills a running task and refuses a task sent before the stop; a new task runs", async () => {
    const agentId = `kstop-${randomUUID().slice(0, 8)}`;
    const queue = `kaiban-agents-${agentId}`;
    const failed: MessagePayload[] = [];
    const completed: string[] = [];
    await kafka("dlq").subscribe("kaiban-events-failed", async (p) => void failed.push(p));

    let started = 0;
    const handler = (p: MessagePayload, signal?: AbortSignal): Promise<unknown> => {
      started++;
      if (p.data["quick"]) return Promise.resolve("ok");
      return new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(signal.reason as Error)));
    };
    const worker = kafka("worker");
    const actor = new AgentActor(agentId, worker, queue, handler, { taskTimeoutMs: 60_000 });
    const control = await attachEmergencyStop({ actor, redisUrl: REDIS_URL, agentId });
    closers.push(() => control.close());
    await actor.start();
    closers.push(() => actor.stop());
    await kafka("done").subscribe("kaiban-events-completed", async (p) => void completed.push(p.taskId));
    await new Promise((r) => setTimeout(r, 6_000)); // consumer groups join

    const producer = kafka("producer");
    const running = `t-run-${randomUUID()}`;
    await producer.publish(queue, { taskId: running, agentId, data: {}, timestamp: Date.now() });
    await until(() => (started >= 1 ? true : undefined), 20_000, "the task to start");

    const redis = new Redis(REDIS_URL);
    closers.push(() => redis.quit());
    const cmd = createStopAllCommand("e2e-kafka", "kafka");
    await issueStopAll(redis, cmd);

    const killed = await until(() => failed.find((p) => p.taskId === running), 15_000, "the killed task's record");
    expect(killed.data["error"]).toBe("emergency_stop");

    const old = `t-old-${randomUUID()}`;
    await producer.publish(queue, { taskId: old, agentId, data: { quick: true }, timestamp: cmd.issuedAt - 1 });
    const refused = await until(() => failed.find((p) => p.taskId === old), 15_000, "the refused task's record");
    expect(refused.data["error"]).toBe("emergency_stop");

    const fresh = `t-new-${randomUUID()}`;
    await producer.publish(queue, { taskId: fresh, agentId, data: { quick: true }, timestamp: Date.now() + 5 });
    await until(() => (completed.includes(fresh) ? true : undefined), 15_000, "the new task to complete");
    expect(started).toBe(2); // the running task and the new one; the old one never ran
  }, 90_000);
});
