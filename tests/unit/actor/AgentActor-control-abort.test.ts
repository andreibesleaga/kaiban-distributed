/**
 * AgentActor — a task that was cut short (timed out, or the actor is stopping)
 * is never retried: a retry would pay the provider again for work nobody will
 * read. The DLQ record keeps the inputs and uses a replayable code
 * (`task_timeout` / `actor_stopped`), so an operator can replay it later.
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

const breaker = (): ICircuitBreaker => ({
  isOpen: vi.fn().mockReturnValue(false),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentActor — timeouts are not retried", () => {
  it("one handler call, one DLQ record `task_timeout` with the message as reason, one breaker failure", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const cb = breaker();
    const handler = vi.fn(() => new Promise(() => undefined)); // never settles
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      taskTimeoutMs: 20,
      circuitBreaker: cb,
    });
    await actor.start();
    await deliver(task("t-slow"));

    expect(handler).toHaveBeenCalledTimes(1);
    const dlq = published("kaiban-events-failed");
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.data).toMatchObject({
      instruction: "do",
      status: "failed",
      error: "task_timeout",
      reason: "Task timed out after 20ms",
    });
    expect(cb.recordFailure).toHaveBeenCalledTimes(1);
    expect(DLQ_POISON_REASONS.has("task_timeout")).toBe(false); // replayable
  });
});

describe("AgentActor — stopping ends the task without another paid attempt", () => {
  it("stop() during an attempt: no retry, DLQ `actor_stopped` with the inputs, no completion", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const handler = vi.fn(
      (_p: MessagePayload, signal?: AbortSignal) =>
        new Promise((_r, reject) => {
          signal?.addEventListener("abort", () =>
            reject(signal.reason as Error),
          );
        }),
    );
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      taskTimeoutMs: 60_000,
    });
    await actor.start();
    const running = deliver(task("t-stop"));
    await Promise.resolve();
    await actor.stop();
    await running;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(published("kaiban-events-completed")).toHaveLength(0);
    const dlq = published("kaiban-events-failed");
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.data).toMatchObject({
      instruction: "do",
      error: "actor_stopped",
    });
    expect(DLQ_POISON_REASONS.has("actor_stopped")).toBe(false); // replayable
  });

  it("stop() during the wait between attempts: the next attempt never starts", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const handler = vi.fn().mockRejectedValue(new Error("transient"));
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    const running = deliver(task("t-gap"));
    await new Promise((r) => setTimeout(r, 20)); // first attempt failed; now in the 100 ms back-off
    await actor.stop();
    await running;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(published("kaiban-events-failed")[0]!.data).toMatchObject({
      error: "actor_stopped",
    });
  });

  it("a task delivered after stop() is not run", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue("ok");
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    await actor.stop();
    await deliver(task("t-late"));

    expect(handler).not.toHaveBeenCalled();
    expect(published("kaiban-events-failed")[0]!.data).toMatchObject({
      instruction: "do",
      error: "actor_stopped",
    });
  });

  it("a plain error thrown by the handler after stop() (e.g. an SDK abort error) is not retried either", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const handler = vi.fn(
      (_p: MessagePayload, signal?: AbortSignal) =>
        new Promise((_r, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new Error("Request was aborted.")),
          );
        }),
    );
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      taskTimeoutMs: 60_000,
    });
    await actor.start();
    const running = deliver(task("t-sdk"));
    await Promise.resolve();
    await actor.stop();
    await running;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(published("kaiban-events-failed")[0]!.data).toMatchObject({
      error: "actor_stopped",
    });
  });
});
