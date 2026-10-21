/**
 * AgentActor — NonRetryableError ends a task after one attempt (roadmap §7.2
 * items 1–2 groundwork). A BudgetExceededError from the handler is NOT retried:
 * exactly one handler call, no completion, one DLQ record whose `error` is the
 * stable reasonCode (poison for replay) and whose `reason` is the message.
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

const mockRedisPublish = vi.fn().mockResolvedValue(1);
vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { publish: mockRedisPublish, quit: vi.fn().mockResolvedValue("OK") };
  }),
}));

import { AgentActor } from "../../../src/application/actor/AgentActor";
import { AgentStatePublisher } from "../../../src/adapters/state/agent-state-publisher";
import { BudgetExceededError } from "../../../src/shared/budget";
import { FailedAttemptError } from "../../../src/domain/errors/DomainError";
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentActor — non-retryable errors", () => {
  it("a BudgetExceededError is not retried: one handler call, one DLQ record, no completion", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const breaker: ICircuitBreaker = {
      isOpen: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const handler = vi
      .fn()
      .mockRejectedValue(
        new BudgetExceededError("Token budget exceeded: 600 >= 500", "token_budget_exceeded"),
      );
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      circuitBreaker: breaker,
    });
    await actor.start();

    await deliver(task("t-budget"));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(published("kaiban-events-completed")).toHaveLength(0);
    const dlq = published("kaiban-events-failed");
    expect(dlq).toHaveLength(1);
    expect(dlq[0]).toMatchObject({
      taskId: "t-budget",
      agentId: "agent-1",
      data: {
        status: "failed",
        error: "token_budget_exceeded",
        reason: "Token budget exceeded: 600 >= 500",
      },
    });
    // Not a downstream fault: the breaker is untouched.
    expect(breaker.recordFailure).not.toHaveBeenCalled();
    expect(breaker.recordSuccess).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "t-budget", reasonCode: "token_budget_exceeded" }),
      expect.stringContaining("non-retryable"),
    );
  });

  it("the DLQ reason codes of a budget breach are poison for replayDlq", () => {
    for (const code of ["budget_exceeded", "token_budget_exceeded", "task_token_budget_exceeded"]) {
      expect(DLQ_POISON_REASONS.has(code)).toBe(true);
    }
  });

  it("an ordinary Error still gets the three attempts (unchanged behaviour)", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const handler = vi.fn().mockRejectedValue(new Error("transient"));
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    await deliver(task("t-plain"));
    expect(handler).toHaveBeenCalledTimes(3);
    expect(published("kaiban-events-failed")[0]?.data).toMatchObject({
      status: "failed",
      error: "transient",
    });
  });

  it("end to end with the state publisher: after the agent cap is met, a later task costs ZERO provider requests", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const provider = { requests: 0 };
    const llm = async (): Promise<unknown> => {
      provider.requests += 1;
      return { answer: "ok", inputTokens: 300, outputTokens: 0, estimatedCost: 0.01 };
    };
    const publisher = new AgentStatePublisher(
      "redis://x",
      { agentId: "agent-1", name: "A", role: "W" },
      { maxTokenBudget: 500 },
    );
    const actor = new AgentActor("agent-1", driver, "q", publisher.wrapHandler(llm));
    await actor.start();

    await deliver(task("t1")); // 300 < 500 → completed
    await deliver(task("t2")); // 600 >= 500 → paid once, then non-retryable breach
    await deliver(task("t3")); // refused pre-flight → no request at all
    await deliver(task("t4"));

    expect(provider.requests).toBe(2);
    expect(published("kaiban-events-completed").map((p) => p.taskId)).toEqual(["t1"]);
    const dlq = published("kaiban-events-failed");
    expect(dlq.map((p) => p.taskId)).toEqual(["t2", "t3", "t4"]);
    for (const record of dlq) {
      expect(record.data["error"]).toBe("token_budget_exceeded");
    }
    expect(String(dlq[1]?.data["reason"])).toContain("before task t3");
  });

  it("end to end: failed paid attempts count against the task cap — no further provider request once it is reached", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const provider = { requests: 0, tokens: 60 };
    const llm = async (): Promise<unknown> => {
      provider.requests += 1;
      throw new FailedAttemptError("KaibanJS workflow errored: boom", {
        inputTokens: provider.tokens,
        outputTokens: 0,
        estimatedCost: 0.01,
      });
    };
    const publisher = new AgentStatePublisher(
      "redis://x",
      { agentId: "agent-1", name: "A", role: "W" },
      { maxTaskTokenBudget: 50 },
    );
    const actor = new AgentActor("agent-1", driver, "q", publisher.wrapHandler(llm));
    await actor.start();

    // The first failed attempt already spends 60 >= 50: no retry at all.
    await deliver(task("t-fail"));
    expect(provider.requests).toBe(1);
    const dlq = published("kaiban-events-failed");
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.data["error"]).toBe("task_token_budget_exceeded");

    // 30 per failed attempt: attempt 1 (30) is retried, attempt 2 (60) stops —
    // two paid requests instead of the three a plain failure gets.
    provider.tokens = 30;
    await deliver(task("t-fail-2"));
    expect(provider.requests).toBe(3);
    expect(published("kaiban-events-failed")[1]?.data["error"]).toBe(
      "task_token_budget_exceeded",
    );
    expect(published("kaiban-events-completed")).toHaveLength(0);
  });
});
