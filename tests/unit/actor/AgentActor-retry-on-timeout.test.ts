/**
 * AgentActor — RETRY_ON_TIMEOUT opt-in. With `retryOnTimeout` a timed-out task
 * goes through the normal retry path (3 attempts, linear back-off); the last
 * timeout still dead-letters as `task_timeout` and counts once on the breaker.
 * A stop and a budget breach are never retried. Fake timers throughout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
import { BudgetExceededError } from "../../../src/shared/budget";
import type { ICircuitBreaker } from "../../../src/domain/security/circuit-breaker";
import type {
  IMessagingDriver,
  MessagePayload,
} from "../../../src/infrastructure/messaging/interfaces";

function makeDriver(): {
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

const hang = (): Promise<never> => new Promise<never>(() => {});

const makeBreaker = (): ICircuitBreaker =>
  ({
    isOpen: vi.fn().mockReturnValue(false),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  }) as unknown as ICircuitBreaker;

describe("AgentActor — retryOnTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a timeout and completes when the second attempt answers", async () => {
    const { driver, deliver, published } = makeDriver();
    const handler = vi
      .fn()
      .mockImplementationOnce(hang)
      .mockResolvedValueOnce("ok");
    const breaker = makeBreaker();
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      taskTimeoutMs: 20,
      retryOnTimeout: true,
      circuitBreaker: breaker,
    });
    await actor.start();

    const done = deliver(task("t-1"));
    await vi.advanceTimersByTimeAsync(20 + 100);
    await done;

    expect(handler).toHaveBeenCalledTimes(2);
    expect(published("kaiban-events-completed")).toHaveLength(1);
    expect(published("kaiban-events-failed")).toHaveLength(0);
    expect(breaker.recordFailure).not.toHaveBeenCalled();
  });

  it("dead-letters as task_timeout after 3 timed-out attempts, one breaker failure", async () => {
    const { driver, deliver, published } = makeDriver();
    const handler = vi.fn().mockImplementation(hang);
    const breaker = makeBreaker();
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      taskTimeoutMs: 20,
      retryOnTimeout: true,
      circuitBreaker: breaker,
    });
    await actor.start();

    const done = deliver(task("t-2"));
    await vi.advanceTimersByTimeAsync(3 * 20 + 100 + 200);
    await done;

    expect(handler).toHaveBeenCalledTimes(3);
    const dlq = published("kaiban-events-failed");
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.data["error"]).toBe("task_timeout");
    expect(breaker.recordFailure).toHaveBeenCalledTimes(1);
  });

  it("does not retry a timeout when the flag is off or false", async () => {
    for (const deps of [{}, { retryOnTimeout: false }]) {
      const { driver, deliver, published } = makeDriver();
      const handler = vi.fn().mockImplementation(hang);
      const actor = new AgentActor("agent-1", driver, "q", handler, {
        taskTimeoutMs: 20,
        ...deps,
      });
      await actor.start();
      const done = deliver(task("t-3"));
      await vi.advanceTimersByTimeAsync(20);
      await done;
      expect(handler).toHaveBeenCalledTimes(1);
      expect(published("kaiban-events-failed")[0]!.data["error"]).toBe(
        "task_timeout",
      );
    }
  });

  it("stop() during the back-off ends the task as actor_stopped without another attempt", async () => {
    const { driver, deliver, published } = makeDriver();
    const handler = vi.fn().mockImplementation(hang);
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      taskTimeoutMs: 20,
      retryOnTimeout: true,
    });
    await actor.start();

    const done = deliver(task("t-4"));
    await vi.advanceTimersByTimeAsync(20 + 10); // inside the 100 ms back-off
    const stopped = actor.stop();
    await vi.advanceTimersByTimeAsync(200);
    await stopped;
    await done;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(published("kaiban-events-failed")[0]!.data["error"]).toBe(
      "actor_stopped",
    );
  });

  it("stop() during an attempt is not retried either", async () => {
    const { driver, deliver, published } = makeDriver();
    const handler = vi
      .fn()
      .mockImplementation(
        (_p: MessagePayload, signal?: AbortSignal) =>
          new Promise<never>((_res, rej) =>
            signal?.addEventListener("abort", () => rej(signal.reason)),
          ),
      );
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      taskTimeoutMs: 1000,
      retryOnTimeout: true,
    });
    await actor.start();

    const done = deliver(task("t-5"));
    await vi.advanceTimersByTimeAsync(10);
    const stopped = actor.stop();
    await vi.advanceTimersByTimeAsync(500);
    await stopped;
    await done;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(published("kaiban-events-failed")[0]!.data["error"]).toBe(
      "actor_stopped",
    );
  });

  it("a budget breach stays a single attempt with the flag on", async () => {
    const { driver, deliver, published } = makeDriver();
    const handler = vi
      .fn()
      .mockRejectedValue(
        new BudgetExceededError("cap reached", "token_budget_exceeded"),
      );
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      taskTimeoutMs: 20,
      retryOnTimeout: true,
    });
    await actor.start();

    await deliver(task("t-6"));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(published("kaiban-events-failed")).toHaveLength(1);
  });
});
