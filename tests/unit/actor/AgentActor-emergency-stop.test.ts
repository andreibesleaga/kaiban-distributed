/**
 * AgentActor — emergency STOP ALL (roadmap §6.10, ADR-025).
 *
 * ES-1  every running task is aborted, settled at once, never retried, and
 *       dead-lettered as `emergency_stop` (replayable).
 * ES-2  a task sent before the stop and delivered after it is refused.
 * ES-5  a task sent after the stop runs normally (there is no release).
 * ES-8  a stop no later than one already applied changes nothing (`noop`).
 * ES-12 a handler that ignores its signal does not keep the task alive, and
 *       its late result is never published.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../../src/shared/structured-logger", () => ({
  createStructuredLogger: (): typeof mockLog => mockLog,
  logger: mockLog,
  resolveLogLevel: (): string => "silent",
}));

import { AgentActor } from "../../../src/application/actor/AgentActor";
import type { TaskHandler } from "../../../src/application/actor/AgentActor";
import {
  EMERGENCY_STOP_REASON,
  EmergencyStopError,
  NonRetryableError,
} from "../../../src/domain/errors/DomainError";
import { DLQ_POISON_REASONS } from "../../../src/resilience/dlq-replay";
import type { ICircuitBreaker } from "../../../src/domain/security/circuit-breaker";
import type {
  IMessagingDriver,
  MessagePayload,
} from "../../../src/infrastructure/messaging/interfaces";

function makeCapturingDriver(): {
  driver: IMessagingDriver;
  deliver: (p: MessagePayload) => Promise<void>;
  published: (channel: string) => MessagePayload[];
} {
  let h!: (p: MessagePayload) => Promise<void>;
  const driver: IMessagingDriver = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((_q, handler) => {
      h = handler;
      return Promise.resolve();
    }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return {
    driver,
    deliver: (p) => h(p),
    published: (channel) =>
      (driver.publish as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: unknown[]) => c[0] === channel)
        .map((c: unknown[]) => c[1] as MessagePayload),
  };
}

const task = (taskId: string): MessagePayload => ({
  taskId,
  agentId: "agent-1",
  data: { instruction: "do" },
  timestamp: 0,
});

/** A handler that only settles when its signal aborts (an honest model call). */
const abortableHandler = (): ReturnType<typeof vi.fn<TaskHandler>> =>
  vi.fn<TaskHandler>(
    (_p: MessagePayload, signal?: AbortSignal) =>
      new Promise((_r, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason as Error));
      }),
  );

const breaker = (): ICircuitBreaker => ({
  isOpen: vi.fn().mockReturnValue(false),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EmergencyStopError", () => {
  it("is non-retryable with the stable reason code `emergency_stop`, which is replayable", () => {
    const err = new EmergencyStopError();
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(err.reasonCode).toBe("emergency_stop");
    expect(EMERGENCY_STOP_REASON).toBe("emergency_stop");
    expect(err.code).toBe("EMERGENCY_STOP");
    expect(err.message).toBe("Emergency stop");
    expect(new EmergencyStopError("held").message).toBe("held");
    expect(DLQ_POISON_REASONS.has(EMERGENCY_STOP_REASON)).toBe(false);
  });
});

describe("AgentActor.emergencyStop — running tasks (ES-1)", () => {
  it("aborts every running task with EmergencyStopError: one attempt, DLQ `emergency_stop` with inputs, no completion", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const handler = abortableHandler();
    const signals: AbortSignal[] = [];
    handler.mockImplementation(
      (_p: MessagePayload, signal?: AbortSignal) =>
        new Promise((_r, reject) => {
          signals.push(signal!);
          signal?.addEventListener("abort", () => reject(signal.reason as Error));
        }),
    );
    const cb = breaker();
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      taskTimeoutMs: 60_000,
      circuitBreaker: cb,
    });
    await actor.start();
    const a = deliver(task("t-a"));
    const b = deliver(task("t-b"));
    await Promise.resolve();

    const result = actor.emergencyStop();
    await Promise.all([a, b]);

    expect(result).toEqual({ outcome: "applied", aborted: 2 });
    expect(signals.every((s) => s.reason instanceof EmergencyStopError)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(published("kaiban-events-completed")).toHaveLength(0);
    const dlq = published("kaiban-events-failed");
    expect(dlq.map((m) => m.taskId).sort()).toEqual(["t-a", "t-b"]);
    for (const m of dlq) {
      expect(m.data).toMatchObject({
        instruction: "do",
        status: "failed",
        error: "emergency_stop",
        reason: "Emergency stop",
      });
    }
    // Not a downstream fault: the breaker is not charged.
    expect(cb.recordFailure).not.toHaveBeenCalled();
  });

  it("settles at once when the handler ignores its signal, and never publishes the late result (ES-12)", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    let finishLate!: (v: string) => void;
    const handler = vi.fn(
      () => new Promise<string>((resolve) => (finishLate = resolve)),
    );
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      taskTimeoutMs: 60_000,
    });
    await actor.start();
    const running = deliver(task("t-deaf"));
    await Promise.resolve();

    actor.emergencyStop();
    await running; // resolves although the handler has not settled

    expect(published("kaiban-events-failed")[0]!.data).toMatchObject({
      error: "emergency_stop",
    });
    finishLate("late result");
    await new Promise((r) => setTimeout(r, 5));
    expect(published("kaiban-events-completed")).toHaveLength(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a stop during the wait between attempts: the next attempt never starts", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const handler = vi.fn().mockRejectedValue(new Error("transient"));
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    const running = deliver(task("t-gap"));
    await new Promise((r) => setTimeout(r, 20)); // in the 100 ms back-off
    expect(actor.emergencyStop()).toEqual({ outcome: "applied", aborted: 0 });
    await running;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(published("kaiban-events-failed")).toHaveLength(1);
    expect(published("kaiban-events-failed")[0]!.data).toMatchObject({
      error: "emergency_stop",
    });
  });

  it("a stop before the timeout ends the task as `emergency_stop`, even with retryOnTimeout", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const handler = vi.fn(() => new Promise(() => undefined));
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      taskTimeoutMs: 20,
      retryOnTimeout: true,
    });
    await actor.start();
    const running = deliver(task("t-timeout"));
    await new Promise((r) => setTimeout(r, 5));
    actor.emergencyStop(); // before the 20 ms timeout fires
    await running;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(published("kaiban-events-failed")).toHaveLength(1);
    expect(published("kaiban-events-failed")[0]!.data).toMatchObject({
      error: "emergency_stop",
    });
  });

  it("a plain error the handler throws after the stop is ended as `emergency_stop`, not retried", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    let fail!: (e: Error) => void;
    const handler = vi.fn(
      () => new Promise((_r, reject) => (fail = reject)),
    );
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      taskTimeoutMs: 60_000,
    });
    await actor.start();
    // The handler ignores its signal and fails on its own right after the stop.
    const running = deliver(task("t-race"));
    await Promise.resolve();
    actor.emergencyStop();
    fail(new Error("Request was aborted."));
    await running;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(published("kaiban-events-failed")).toHaveLength(1);
    expect(published("kaiban-events-failed")[0]!.data).toMatchObject({
      error: "emergency_stop",
    });
  });
});

describe("AgentActor — the stop moment (ES-2, ES-5, ES-8)", () => {
  it("a task sent before the stop and delivered after it is refused without running", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue("ok");
    const onEmergencyStop = vi.fn();
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      onEmergencyStop,
    });
    await actor.start();
    actor.emergencyStop(1_000);
    await deliver({ ...task("t-queued"), timestamp: 1_000 }); // at the stop moment

    expect(handler).not.toHaveBeenCalled();
    expect(published("kaiban-events-failed")[0]!.data).toMatchObject({
      instruction: "do",
      error: "emergency_stop",
      reason: "Sent before an emergency stop",
    });
    expect(onEmergencyStop).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "t-queued" }),
    );
  });

  it("a task sent after the stop runs normally", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue("ok");
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    actor.emergencyStop(1_000);
    await deliver({ ...task("t-new"), timestamp: 1_001 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(published("kaiban-events-completed")).toHaveLength(1);
    expect(published("kaiban-events-failed")).toHaveLength(0);
  });

  it("a running task sent after a late-arriving stop's moment is not aborted", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    let finish!: (v: string) => void;
    const handler = vi.fn(() => new Promise<string>((r) => (finish = r)));
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      taskTimeoutMs: 60_000,
    });
    await actor.start();
    const running = deliver({ ...task("t-fresh"), timestamp: 2_000 });
    await Promise.resolve();
    expect(actor.emergencyStop(1_000)).toEqual({ outcome: "applied", aborted: 0 });
    finish("done");
    await running;

    expect(published("kaiban-events-completed")).toHaveLength(1);
    expect(published("kaiban-events-failed")).toHaveLength(0);
  });

  it("calls onEmergencyStop for each running task it ends", async () => {
    const { driver, deliver } = makeCapturingDriver();
    const onEmergencyStop = vi.fn();
    const actor = new AgentActor("agent-1", driver, "q", abortableHandler(), {
      taskTimeoutMs: 60_000,
      onEmergencyStop,
    });
    await actor.start();
    const running = deliver(task("t-run"));
    await Promise.resolve();
    actor.emergencyStop();
    await running;

    expect(onEmergencyStop).toHaveBeenCalledTimes(1);
    expect(onEmergencyStop).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "t-run" }),
    );
  });

  it("a stop no later than the applied one is a noop; a later one applies", () => {
    const actor = new AgentActor("agent-1", makeCapturingDriver().driver, "q", vi.fn());
    expect(actor.emergencyStop(1_000)).toEqual({ outcome: "applied", aborted: 0 });
    expect(actor.emergencyStop(1_000)).toEqual({ outcome: "noop", aborted: 0 });
    expect(actor.emergencyStop(900)).toEqual({ outcome: "noop", aborted: 0 });
    expect(actor.emergencyStop(2_000)).toEqual({ outcome: "applied", aborted: 0 });
  });

  it("a task that ended before the stop is not touched by it", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const onEmergencyStop = vi.fn();
    const actor = new AgentActor("agent-1", driver, "q", vi.fn().mockResolvedValue("ok"), {
      onEmergencyStop,
    });
    await actor.start();
    await deliver(task("t-done"));
    expect(actor.emergencyStop()).toEqual({ outcome: "applied", aborted: 0 });

    expect(published("kaiban-events-completed")).toHaveLength(1);
    expect(published("kaiban-events-failed")).toHaveLength(0);
    expect(onEmergencyStop).not.toHaveBeenCalled();
  });

  it("a task for another agent is ignored after a stop (no DLQ record)", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const actor = new AgentActor("agent-1", driver, "q", vi.fn());
    await actor.start();
    actor.emergencyStop();
    await deliver({ ...task("t-other"), agentId: "agent-2" });
    expect(published("kaiban-events-failed")).toHaveLength(0);
  });

  it("stopped and draining: a task sent before the stop is recorded as `emergency_stop`", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const actor = new AgentActor("agent-1", driver, "q", vi.fn());
    await actor.start();
    actor.emergencyStop();
    await actor.stop();
    await deliver(task("t-drain"));
    expect(published("kaiban-events-failed")[0]!.data).toMatchObject({
      error: "emergency_stop",
    });
  });
});

describe("AgentActor — a stop while the guards decide (Copilot finding, PR #178)", () => {
  it("a task allowed by a slow admission gate after the stop is never run", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue("ok");
    let allow!: () => void;
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      admissionGate: {
        evaluate: vi.fn(() => new Promise<{ allowed: true }>((r) => (allow = (): void => r({ allowed: true })))),
      },
    });
    await actor.start();
    const running = deliver({ ...task("t-gated"), timestamp: 1_000 });
    await Promise.resolve();
    actor.emergencyStop(2_000);
    allow();
    await running;

    expect(handler).not.toHaveBeenCalled();
    expect(published("kaiban-events-completed")).toHaveLength(0);
    expect(published("kaiban-events-failed")[0]!.data).toMatchObject({ error: "emergency_stop" });
  });

  it("stop() while the guards decide: the task is dead-lettered as actor_stopped, not run", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue("ok");
    let allow!: () => void;
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      admissionGate: {
        evaluate: vi.fn(() => new Promise<{ allowed: true }>((r) => (allow = (): void => r({ allowed: true })))),
      },
    });
    await actor.start();
    const running = deliver(task("t-gated-2"));
    await Promise.resolve();
    await actor.stop();
    allow();
    await running;
    expect(handler).not.toHaveBeenCalled();
    expect(published("kaiban-events-failed")[0]!.data).toMatchObject({ error: "actor_stopped" });
  });
});

