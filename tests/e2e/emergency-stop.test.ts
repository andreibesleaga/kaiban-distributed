/**
 * E2E: emergency STOP ALL over real Redis + BullMQ (roadmap §6.10, ADR-025).
 * Requires: Redis via docker-compose (started by globalSetup).
 *
 * A1  a task running on a slow model is killed mid-call: the model request is
 *     aborted, the failure record says `emergency_stop`, the board sees STOPPED,
 *     the node acks within 5 s, and no second attempt reaches the model.
 * A2  a task sent before the stop and still queued is refused when delivered.
 * A3  a node started after the stop refuses old tasks and runs new ones.
 * A4  an orchestrator's step wait and a human-review wait end at once.
 * A9  the same command again is a noop; an older stop never replaces a newer one.
 */
import { randomUUID } from "crypto";
import { describe, it, expect, afterEach, afterAll } from "vitest";
import Redis from "ioredis";
import { BullMQDriver } from "../../src/infrastructure/messaging/bullmq-driver";
import { AgentActor } from "../../src/application/actor/AgentActor";
import { AgentStatePublisher } from "../../src/adapters/state/agent-state-publisher";
import { createKaibanTaskHandler } from "../../src/infrastructure/kaibanjs/kaiban-agent-bridge";
import {
  STOP_MOMENT_KEY,
  issueStopAll,
  readLastStop,
} from "../../src/infrastructure/control/control-channel";
import {
  attachEmergencyStop,
  createEmergencyStopSignal,
  createStopAllCommand,
  type EmergencyStopHandle,
} from "../../src/shared/emergency-stop";
import { CompletionRouter } from "../../src/shared/completion-router";
import { WorkflowOrchestrator, InMemoryCheckpointStore } from "../../src/shared/orchestrator";
import { waitForHITLDecision } from "../../src/shared/hitl";
import { EmergencyStopError } from "../../src/domain/errors/DomainError";
import type { MessagePayload } from "../../src/infrastructure/messaging/interfaces";
import { startMockModel, type MockModel } from "./helpers/mock-model";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const url = new URL(REDIS_URL);
const conn = { connection: { host: url.hostname, port: parseInt(url.port || "6379", 10) } };

const closers: Array<() => Promise<unknown>> = [];
const later = <T extends { disconnect?: () => Promise<unknown>; close?: () => Promise<unknown> }>(x: T): T => {
  closers.push(() => (x.close ? x.close() : x.disconnect!()));
  return x;
};

async function until<T>(check: () => T | undefined, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Every failure record and state delta, collected for the assertions. */
async function watch(): Promise<{ failed: MessagePayload[]; deltas: Record<string, unknown>[] }> {
  const failed: MessagePayload[] = [];
  const deltas: Record<string, unknown>[] = [];
  const dlq = later(new BullMQDriver(conn));
  await dlq.subscribe("kaiban-events-failed", async (p) => void failed.push(p));
  const sub = new Redis(REDIS_URL);
  closers.push(() => sub.quit());
  sub.on("message", (_c: string, raw: string) => deltas.push(JSON.parse(raw) as Record<string, unknown>));
  await sub.subscribe("kaiban-state-events");
  return { failed, deltas };
}

const stopNow = async (reason?: string): Promise<{ commandId: string; issuedAt: number }> => {
  const redis = new Redis(REDIS_URL);
  try {
    const cmd = createStopAllCommand("e2e", reason);
    await issueStopAll(redis, cmd);
    return cmd;
  } finally {
    await redis.quit();
  }
};

const clearStop = async (): Promise<void> => {
  const redis = new Redis(REDIS_URL);
  await redis.del(STOP_MOMENT_KEY);
  await redis.quit();
};

afterEach(async () => {
  while (closers.length) await closers.pop()!().catch(() => undefined);
  await clearStop();
});
afterAll(clearStop);

describe("E2E: emergency STOP ALL (BullMQ + Redis)", () => {
  it("A1: kills a task mid model call — request aborted, DLQ emergency_stop, STOPPED, ack < 5 s, no retry", async () => {
    const model: MockModel = later(await startMockModel(60_000));
    const { failed, deltas } = await watch();
    const agentId = `e2e-stop-${randomUUID().slice(0, 8)}`;
    const queue = `kaiban-agents-${agentId}`;
    const driver = later(new BullMQDriver(conn));
    const publisher = later(new AgentStatePublisher(REDIS_URL, { agentId, name: "Stopper", role: "e2e" }));
    const handler = publisher.wrapHandler(
      createKaibanTaskHandler(
        {
          name: "Stopper",
          role: "e2e",
          goal: "answer",
          background: "e2e",
          maxIterations: 1,
          llmConfig: { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-e2e", apiBaseUrl: model.url } as never,
        },
        driver,
      ),
    );
    const actor = new AgentActor(agentId, driver, queue, handler, {
      taskTimeoutMs: 60_000,
      onEmergencyStop: (p): void => publisher.publishStopped(p),
    });
    await actor.start();
    later({ close: () => actor.stop() });
    const control: EmergencyStopHandle = later(
      await attachEmergencyStop({ actor, publisher, redisUrl: REDIS_URL, agentId }),
    );
    expect(control).toBeDefined();

    const taskId = `t-${randomUUID()}`;
    const sender = later(new BullMQDriver(conn));
    await sender.publish(queue, { taskId, agentId, data: { instruction: "Say hi", expectedOutput: "hi" }, timestamp: Date.now() });
    await model.waitForRequests(1, 20_000);

    const stoppedAt = Date.now();
    const cmd = await stopNow("e2e A1");
    await model.waitForAborts(1, 5_000);
    const record = await until(() => failed.find((p) => p.taskId === taskId), 5_000, "the failure record");
    expect(record.data["error"]).toBe("emergency_stop");
    const ack = await until(
      () => deltas.find((d) => (d["control"] as { commandId?: string } | undefined)?.commandId === cmd.commandId),
      5_000,
      "the node ack",
    );
    expect(ack["control"]).toMatchObject({ outcome: "applied", aborted: 1, agentId });
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    await until(
      () =>
        deltas.find((d) =>
          ((d["tasks"] as Array<{ taskId: string; status: string }> | undefined) ?? []).some(
            (t) => t.taskId === taskId && t.status === "STOPPED",
          ),
        ),
      5_000,
      "task STOPPED on the state channel",
    );
    await new Promise((r) => setTimeout(r, 1_000));
    expect(model.requests()).toBe(1); // never retried
  }, 60_000);

  it("A2 + A3: tasks sent before the stop are refused (also by a node started later); new ones run", async () => {
    const { failed } = await watch();
    const before = Date.now() - 10;
    await stopNow("e2e A2");

    const agentId = `e2e-late-${randomUUID().slice(0, 8)}`;
    const queue = `kaiban-agents-${agentId}`;
    const sender = later(new BullMQDriver(conn));
    const oldTask = `t-old-${randomUUID()}`;
    // Queued before the node exists, sent before the stop moment.
    await sender.publish(queue, { taskId: oldTask, agentId, data: { instruction: "old" }, timestamp: before });

    const ran: string[] = [];
    const driver = later(new BullMQDriver(conn));
    const actor = new AgentActor(agentId, driver, queue, async (p) => (ran.push(p.taskId), "ok"));
    // As startAgentNode does: read the saved stop before taking the first task.
    later(await attachEmergencyStop({ actor, redisUrl: REDIS_URL, agentId }));
    await actor.start();
    later({ close: () => actor.stop() });

    const completed: string[] = [];
    const done = later(new BullMQDriver(conn));
    await done.subscribe("kaiban-events-completed", async (p) => void completed.push(p.taskId));

    const refused = await until(() => failed.find((p) => p.taskId === oldTask), 10_000, "the refused task");
    expect(refused.data["error"]).toBe("emergency_stop");
    expect(ran).not.toContain(oldTask);

    const newTask = `t-new-${randomUUID()}`;
    await sender.publish(queue, { taskId: newTask, agentId, data: { instruction: "new" }, timestamp: Date.now() + 5 });
    await until(() => (completed.includes(newTask) ? true : undefined), 10_000, "the new task to complete");
    expect(ran).toEqual([newTask]);
  }, 40_000);

  it("A4: an orchestrator's step wait and a review wait end at once with EmergencyStopError", async () => {
    const agentId = `e2e-orch-${randomUUID().slice(0, 8)}`;
    const queue = `kaiban-agents-${agentId}`;
    const driver = later(new BullMQDriver(conn));
    // A worker without the control plane: only the orchestrator hears the stop.
    const actor = new AgentActor(agentId, driver, queue, () => new Promise(() => undefined), { taskTimeoutMs: 60_000 });
    await actor.start();
    later({ close: () => actor.stop() });

    const stop = later(await createEmergencyStopSignal(REDIS_URL));
    const routerDriver = later(new BullMQDriver(conn));
    const router = new CompletionRouter(routerDriver);
    const orch = new WorkflowOrchestrator({
      workflowId: `wf-${randomUUID()}`,
      router,
      store: new InMemoryCheckpointStore(),
      stopSignal: stop.signal,
    });
    const sender = later(new BullMQDriver(conn));
    const step = orch.runStep("research", {
      dispatch: async () => {
        const taskId = `t-${randomUUID()}`;
        await sender.publish(queue, { taskId, agentId, data: {}, timestamp: Date.now() });
        return taskId;
      },
      timeoutMs: 60_000,
    });
    const review = waitForHITLDecision({ taskId: `hitl-${randomUUID()}`, rl: null, redisUrl: REDIS_URL, signal: stop.signal });
    // Observe both outcomes before the stop, so neither rejection is ever unhandled.
    const stepOutcome = step.then(() => "resolved", (e: unknown) => e);
    const reviewOutcome = review.then(() => "resolved", (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 500));

    const t0 = Date.now();
    await stopNow("e2e A4");
    expect(await stepOutcome).toBeInstanceOf(EmergencyStopError);
    expect(await reviewOutcome).toBeInstanceOf(EmergencyStopError);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await expect(orch.runStep("write", { dispatch: async () => "never", timeoutMs: 1 })).rejects.toBeInstanceOf(
      EmergencyStopError,
    );
  }, 30_000);

  it("A9: the same command again is a noop; an older stop never replaces the saved newer one", async () => {
    const { deltas } = await watch();
    const agentId = `e2e-noop-${randomUUID().slice(0, 8)}`;
    const driver = later(new BullMQDriver(conn));
    const publisher = later(new AgentStatePublisher(REDIS_URL, { agentId, name: "N", role: "e2e" }));
    const actor = new AgentActor(agentId, driver, `kaiban-agents-${agentId}`, async () => "ok");
    await actor.start();
    later({ close: () => actor.stop() });
    later(await attachEmergencyStop({ actor, publisher, redisUrl: REDIS_URL, agentId }));

    const redis = new Redis(REDIS_URL);
    closers.push(() => redis.quit());
    const cmd = createStopAllCommand("e2e", "first");
    await expect(issueStopAll(redis, cmd)).resolves.toEqual({ saved: true });
    await expect(issueStopAll(redis, cmd)).resolves.toEqual({ saved: false });
    const acks = (): Array<{ outcome: string }> =>
      deltas
        .map((d) => d["control"] as { commandId: string; outcome: string } | undefined)
        .filter((c): c is { commandId: string; outcome: string } => c?.commandId === cmd.commandId);
    await until(() => (acks().length >= 2 ? true : undefined), 5_000, "two acks");
    expect(acks().map((a) => a.outcome)).toEqual(["applied", "noop"]);

    const older = { ...createStopAllCommand("e2e", "older"), issuedAt: cmd.issuedAt - 1_000 };
    await expect(issueStopAll(redis, older)).resolves.toEqual({ saved: false });
    await expect(readLastStop(redis)).resolves.toMatchObject({ commandId: cmd.commandId });
  }, 30_000);
});
