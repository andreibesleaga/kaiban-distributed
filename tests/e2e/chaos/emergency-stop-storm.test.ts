/**
 * Chaos: a storm of emergency STOP ALL commands while tasks keep arriving
 * (roadmap §6.10, ADR-025). Every task ends exactly once — completed, or failed
 * as `emergency_stop` — nothing is lost or run twice, and the workers still take
 * new work afterwards.
 * Requires: Redis via docker-compose (started by globalSetup).
 */
import { randomUUID } from "crypto";
import { describe, it, expect, afterAll } from "vitest";
import Redis from "ioredis";
import { BullMQDriver } from "../../../src/infrastructure/messaging/bullmq-driver";
import { AgentActor } from "../../../src/application/actor/AgentActor";
import { STOP_MOMENT_KEY, issueStopAll } from "../../../src/infrastructure/control/control-channel";
import { attachEmergencyStop, createStopAllCommand } from "../../../src/shared/emergency-stop";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const u = new URL(REDIS_URL);
const conn = { connection: { host: u.hostname, port: parseInt(u.port || "6379", 10) } };
const closers: Array<() => Promise<unknown>> = [];

afterAll(async () => {
  while (closers.length) await closers.pop()!().catch(() => undefined);
  const r = new Redis(REDIS_URL);
  await r.del(STOP_MOMENT_KEY);
  await r.quit();
});

/** Three competing workers on one queue, each attached to the control channel. */
async function startWorkers(agentId: string, queue: string, runs: Map<string, number>): Promise<void> {
  for (let w = 0; w < 3; w++) {
    const driver = new BullMQDriver(conn);
    closers.push(() => driver.disconnect());
    const actor = new AgentActor(
      agentId,
      driver,
      queue,
      (p, signal) => {
        runs.set(p.taskId, (runs.get(p.taskId) ?? 0) + 1);
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve("ok"), 50 + Math.floor(Math.random() * 150));
          signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason as Error)));
        });
      },
      { taskTimeoutMs: 10_000 },
    );
    const control = await attachEmergencyStop({ actor, redisUrl: REDIS_URL, agentId });
    closers.push(() => control.close());
    await actor.start();
    closers.push(() => actor.stop());
  }
}

/** Send 60 tasks, issuing a stop every 5th (and repeating every 10th). */
async function storm(agentId: string, queue: string): Promise<string[]> {
  const sender = new BullMQDriver(conn);
  closers.push(() => sender.disconnect());
  const redis = new Redis(REDIS_URL);
  closers.push(() => redis.quit());
  const ids: string[] = [];
  for (let i = 0; i < 60; i++) {
    const taskId = `storm-${i}-${randomUUID().slice(0, 6)}`;
    ids.push(taskId);
    await sender.publish(queue, { taskId, agentId, data: {}, timestamp: Date.now() });
    if (i % 5 === 0) {
      const stop = createStopAllCommand("storm", `wave ${i}`);
      await issueStopAll(redis, stop);
      if (i % 10 === 0) await issueStopAll(redis, stop); // a repeat (noop)
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return ids;
}

async function waitUntil(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

describe("Chaos: emergency STOP ALL storm", () => {
  it("60 tasks, 3 workers, 12 stops (with repeats): each task ends exactly once; workers still work after", async () => {
    const agentId = `storm-${randomUUID().slice(0, 8)}`;
    const queue = `kaiban-agents-${agentId}`;
    const runs = new Map<string, number>();
    await startWorkers(agentId, queue, runs);

    const ended = new Map<string, string[]>();
    const note = (taskId: string, how: string): void => void ended.set(taskId, [...(ended.get(taskId) ?? []), how]);
    const watcher = new BullMQDriver(conn);
    closers.push(() => watcher.disconnect());
    await watcher.subscribe("kaiban-events-completed", async (p) => note(p.taskId, "completed"));
    await watcher.subscribe("kaiban-events-failed", async (p) => note(p.taskId, String(p.data["error"])));

    const ids = await storm(agentId, queue);
    await waitUntil(() => ids.every((id) => ended.has(id)), 30_000);
    for (const id of ids) {
      expect(ended.get(id), id).toHaveLength(1);
      expect(["completed", "emergency_stop"]).toContain(ended.get(id)![0]);
      expect(runs.get(id) ?? 0, id).toBeLessThanOrEqual(1);
    }
    expect(ids.filter((id) => ended.get(id)![0] === "emergency_stop").length).toBeGreaterThan(0);

    const sender = new BullMQDriver(conn);
    closers.push(() => sender.disconnect());
    const after = `storm-after-${randomUUID()}`;
    await sender.publish(queue, { taskId: after, agentId, data: {}, timestamp: Date.now() + 5 });
    await waitUntil(() => ended.has(after), 10_000);
    expect(ended.get(after)).toEqual(["completed"]);
  }, 90_000);
});
