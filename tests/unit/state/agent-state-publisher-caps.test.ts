/**
 * AgentStatePublisher — per-agent and per-task token caps (roadmap §7.2 item 2).
 *
 * The caps are checked BEFORE the handler runs (a task that finds a cap already
 * met is refused without a paid call) and after each result; a breach is a
 * non-retryable BudgetExceededError with a stable reasonCode.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentStatePublisher } from "../../../src/adapters/state/agent-state-publisher";
import { BudgetExceededError } from "../../../src/shared/budget";
import {
  FailedAttemptError,
  NonRetryableError,
} from "../../../src/domain/errors/DomainError";
import type { MessagePayload } from "../../../src/infrastructure/messaging/interfaces";

const mockPublish = vi.fn().mockResolvedValue(1);
const mockQuit = vi.fn().mockResolvedValue("OK");
vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { publish: mockPublish, quit: mockQuit };
  }),
}));

const payload = (taskId: string): MessagePayload => ({
  taskId,
  agentId: "a",
  timestamp: 0,
  data: { instruction: `task ${taskId}` },
});

/** A mock LLM provider: every handler call is one paid request. */
function makeProvider(tokensPerCall: number): {
  requests: number;
  handler: () => Promise<unknown>;
} {
  const provider = {
    requests: 0,
    handler: async (): Promise<unknown> => {
      provider.requests += 1;
      return {
        answer: "ok",
        inputTokens: tokensPerCall,
        outputTokens: 0,
        estimatedCost: 0.001,
      };
    },
  };
  return provider;
}

function publishedStatuses(): Array<{ agent?: string; task?: string }> {
  return (mockPublish.mock.calls as Array<[string, string]>).map(([, raw]) => {
    const parsed = JSON.parse(raw) as {
      agents?: Array<{ status: string }>;
      tasks?: Array<{ status: string }>;
    };
    return { agent: parsed.agents?.[0]?.status, task: parsed.tasks?.[0]?.status };
  });
}

const info = { agentId: "a", name: "A", role: "Worker" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("per-agent cap (maxTokenBudget)", () => {
  it("pre-flight: once the agent cap is met, the next task is refused with ZERO provider requests", async () => {
    const pub = new AgentStatePublisher("redis://x", info, { maxTokenBudget: 100 });
    const provider = makeProvider(100);
    const handler = pub.wrapHandler(provider.handler);

    // First task reaches the cap on its (paid) result — non-retryable breach.
    await expect(handler(payload("t1"))).rejects.toBeInstanceOf(BudgetExceededError);
    expect(provider.requests).toBe(1);
    expect(pub.getTotalTokensUsed()).toBe(100);

    // Second task: refused before the handler — no request, no EXECUTING state.
    mockPublish.mockClear();
    const err = await handler(payload("t2")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect((err as BudgetExceededError).reasonCode).toBe("token_budget_exceeded");
    expect((err as Error).message).toContain("before task t2");
    expect(provider.requests).toBe(1);
    expect(publishedStatuses()).toEqual([{ agent: "ERROR", task: "BLOCKED" }]);
  });

  it("the post-call breach carries reasonCode token_budget_exceeded", async () => {
    const pub = new AgentStatePublisher("redis://x", info, { maxTokenBudget: 150 });
    const handler = pub.wrapHandler(makeProvider(100).handler);
    await handler(payload("t1"));
    const err = await handler(payload("t2")).catch((e: unknown) => e);
    expect((err as BudgetExceededError).reasonCode).toBe("token_budget_exceeded");
    expect((err as Error).message).toMatch(/Token budget exceeded: 200 >= 150/);
  });

  it("Infinity (the `unlimited` sentinel) and 0 / undefined do not cap", async () => {
    for (const cap of [Number.POSITIVE_INFINITY, 0, undefined]) {
      const pub = new AgentStatePublisher("redis://x", info, {
        maxTokenBudget: cap,
        maxTaskTokenBudget: cap,
      });
      const provider = makeProvider(1_000_000);
      const handler = pub.wrapHandler(provider.handler);
      await expect(handler(payload("big-1"))).resolves.toBeDefined();
      await expect(handler(payload("big-2"))).resolves.toBeDefined();
      expect(provider.requests).toBe(2);
    }
  });
});

describe("per-task cap (maxTaskTokenBudget)", () => {
  it("a task whose result reaches the task cap fails non-retryably (task_token_budget_exceeded)", async () => {
    const pub = new AgentStatePublisher("redis://x", info, {
      maxTaskTokenBudget: 50,
    });
    const provider = makeProvider(60);
    const handler = pub.wrapHandler(provider.handler);
    const err = await handler(payload("t1")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).reasonCode).toBe("task_token_budget_exceeded");
    expect((err as Error).message).toMatch(/Task token budget exceeded: 60 >= 50/);
    expect(publishedStatuses().at(-1)).toEqual({ agent: "ERROR", task: "BLOCKED" });
  });

  it("pre-flight: a redelivery of a task that already met its cap makes no further request", async () => {
    const pub = new AgentStatePublisher("redis://x", info, {
      maxTaskTokenBudget: 50,
    });
    const provider = makeProvider(60);
    const handler = pub.wrapHandler(provider.handler);
    await handler(payload("t1")).catch(() => undefined);
    expect(provider.requests).toBe(1);

    const err = await handler(payload("t1")).catch((e: unknown) => e);
    expect((err as BudgetExceededError).reasonCode).toBe("task_token_budget_exceeded");
    expect((err as Error).message).toContain("before task t1");
    expect(provider.requests).toBe(1);

    // A different task is unaffected by t1's tally.
    const provider2 = makeProvider(10);
    await expect(pub.wrapHandler(provider2.handler)(payload("t2"))).resolves.toBeDefined();
    expect(provider2.requests).toBe(1);
  });

  it("the task tally accumulates across deliveries of the same taskId", async () => {
    const pub = new AgentStatePublisher("redis://x", info, {
      maxTaskTokenBudget: 100,
    });
    const handler = pub.wrapHandler(makeProvider(40).handler);
    await handler(payload("t1")); // 40
    await handler(payload("t1")); // 80
    const err = await handler(payload("t1")).catch((e: unknown) => e); // 120 >= 100
    expect((err as BudgetExceededError).reasonCode).toBe("task_token_budget_exceeded");
  });

  it("keeps a bounded number of task tallies (oldest evicted beyond 1000)", async () => {
    const pub = new AgentStatePublisher("redis://x", info, {
      maxTaskTokenBudget: 100,
    });
    const handler = pub.wrapHandler(makeProvider(60).handler);
    await handler(payload("first")); // 60 of 100
    for (let i = 0; i < 1000; i++) await handler(payload(`t${i}`));
    // "first" was evicted, so its tally restarts: 60 again is under the cap.
    await expect(handler(payload("first"))).resolves.toBeDefined();
  });

  it("results without usage metadata are not counted against either cap", async () => {
    const pub = new AgentStatePublisher("redis://x", info, {
      maxTokenBudget: 1,
      maxTaskTokenBudget: 1,
    });
    const handler = pub.wrapHandler(async () => "plain text, no usage");
    await expect(handler(payload("t1"))).resolves.toBe("plain text, no usage");
    expect(pub.getTotalTokensUsed()).toBe(0);
  });
});

describe("failed attempts count against the caps (FailedAttemptError usage)", () => {
  /** A mock provider whose every call is paid and then fails. */
  function makeFailingProvider(tokensPerCall: number): {
    requests: number;
    handler: () => Promise<unknown>;
  } {
    const provider = {
      requests: 0,
      handler: async (): Promise<unknown> => {
        provider.requests += 1;
        throw new FailedAttemptError("KaibanJS workflow errored: boom", {
          inputTokens: tokensPerCall,
          outputTokens: 0,
          estimatedCost: 0.001,
        });
      },
    };
    return provider;
  }

  it("a failed attempt that reaches the task cap raises a non-retryable breach", async () => {
    const pub = new AgentStatePublisher("redis://x", info, { maxTaskTokenBudget: 50 });
    const provider = makeFailingProvider(60);
    const handler = pub.wrapHandler(provider.handler);
    const err = await handler(payload("t1")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).reasonCode).toBe("task_token_budget_exceeded");
    expect((err as Error).message).toMatch(/Task token budget exceeded: 60 >= 50/);
    expect(pub.getTotalTokensUsed()).toBe(60);
    expect(publishedStatuses().at(-1)).toEqual({ agent: "ERROR", task: "BLOCKED" });

    // A redelivery is refused pre-flight: no further provider request.
    const again = await handler(payload("t1")).catch((e: unknown) => e);
    expect((again as Error).message).toContain("before task t1");
    expect(provider.requests).toBe(1);
  });

  it("a failed attempt that reaches the agent cap raises token_budget_exceeded", async () => {
    const pub = new AgentStatePublisher("redis://x", info, { maxTokenBudget: 50 });
    const err = await pub
      .wrapHandler(makeFailingProvider(50).handler)(payload("t1"))
      .catch((e: unknown) => e);
    expect((err as BudgetExceededError).reasonCode).toBe("token_budget_exceeded");
  });

  it("under the caps the original (retryable) failure propagates, with its usage counted", async () => {
    const pub = new AgentStatePublisher("redis://x", info, { maxTaskTokenBudget: 100 });
    const handler = pub.wrapHandler(makeFailingProvider(40).handler);
    const err = await handler(payload("t1")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FailedAttemptError);
    expect(err).not.toBeInstanceOf(NonRetryableError);
    expect(pub.getTotalTokensUsed()).toBe(40);
    await handler(payload("t1")).catch(() => undefined); // 80
    const third = await handler(payload("t1")).catch((e: unknown) => e); // 120 >= 100
    expect((third as BudgetExceededError).reasonCode).toBe("task_token_budget_exceeded");
  });

  it("invalid usage numbers (non-finite, negative, missing) count as 0 and cannot switch the caps off", async () => {
    const pub = new AgentStatePublisher("redis://x", info, { maxTokenBudget: 100 });
    const failWith = (usage: unknown): ((p: MessagePayload) => Promise<unknown>) =>
      pub.wrapHandler(async () => {
        throw new FailedAttemptError("KaibanJS workflow errored: boom", usage as never);
      });
    await failWith(undefined)(payload("t0")).catch(() => undefined); // no usage object at all
    await failWith({ inputTokens: 5 })(payload("t1")).catch(() => undefined); // outputTokens missing
    await failWith({ inputTokens: Number.NaN, outputTokens: 7 })(payload("t2")).catch(() => undefined);
    await failWith({ inputTokens: Infinity, outputTokens: -50 })(payload("t3")).catch(() => undefined);
    await failWith({ inputTokens: "3", outputTokens: "x" })(payload("t4")).catch(() => undefined);
    expect(pub.getTotalTokensUsed()).toBe(15); // 5 + 7 + 0 + 3

    // The tally stayed a finite number, so a large success still breaches the cap.
    const err = await pub
      .wrapHandler(makeProvider(1000).handler)(payload("t5"))
      .catch((e: unknown) => e);
    expect((err as BudgetExceededError).reasonCode).toBe("token_budget_exceeded");
  });

  it("a plain Error carries no usage and is not counted", async () => {
    const pub = new AgentStatePublisher("redis://x", info, { maxTaskTokenBudget: 1 });
    const err = await pub
      .wrapHandler(async () => {
        throw new Error("network down");
      })(payload("t1"))
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe("network down");
    expect(pub.getTotalTokensUsed()).toBe(0);
  });
});

describe("success-path usage is cleaned like failed-attempt usage", () => {
  it("a non-numeric or negative usage field counts as 0 and cannot switch the agent cap off", async () => {
    const pub = new AgentStatePublisher("redis://x", info, { maxTokenBudget: 100 });
    const succeedWith = (usage: Record<string, unknown>): ((p: MessagePayload) => Promise<unknown>) =>
      pub.wrapHandler(async () => ({ answer: "ok", estimatedCost: 0, ...usage }));
    await succeedWith({ inputTokens: "n/a", outputTokens: 1 })(payload("t1"));
    await succeedWith({ inputTokens: 4, outputTokens: -1 })(payload("t2")); // a -1 "unknown" sentinel
    await succeedWith({ inputTokens: Number.NaN, outputTokens: Infinity })(payload("t3"));
    expect(pub.getTotalTokensUsed()).toBe(5); // 0 + 1 + 4 + 0 + 0 + 0

    const err = await pub
      .wrapHandler(makeProvider(1000).handler)(payload("t4"))
      .catch((e: unknown) => e);
    expect((err as BudgetExceededError).reasonCode).toBe("token_budget_exceeded");
  });
});

describe("one sanitiser for every spend number (success path, failed attempts, the board)", () => {
  /** Every task delta published to the board, parsed. */
  function publishedTasks(): Array<Record<string, unknown>> {
    return (mockPublish.mock.calls as Array<[string, string]>).flatMap(([, raw]) => {
      const parsed = JSON.parse(raw) as { tasks?: Array<Record<string, unknown>> };
      return parsed.tasks ?? [];
    });
  }

  it("-1 counts and a negative estimatedCost cannot lower the spend, and nothing negative reaches the board", async () => {
    const pub = new AgentStatePublisher("redis://x", info, { maxTokenBudget: 100 });
    await pub.wrapHandler(makeProvider(40).handler)(payload("t1")); // 40
    await pub.wrapHandler(async () => ({
      answer: "ok",
      inputTokens: -1,
      outputTokens: -1,
      estimatedCost: -1, // KaibanJS's cost for a model missing from its price table
    }))(payload("t2"));
    await pub.wrapHandler(async () => ({
      answer: "ok",
      inputTokens: -1_000,
      outputTokens: 5,
      estimatedCost: Number.NaN,
    }))(payload("t3"));
    expect(pub.getTotalTokensUsed()).toBe(45); // 40 + 0 + 5

    const done = publishedTasks().filter((t) => t["status"] === "DONE");
    expect(done.map((t) => [t["taskId"], t["tokens"], t["cost"]])).toEqual([
      ["t1", 40, 0.001],
      ["t2", 0, 0],
      ["t3", 5, 0],
    ]);
    for (const [, raw] of mockPublish.mock.calls as Array<[string, string]>) {
      // A negative number, or NaN (which JSON renders as null), never appears.
      expect(raw).not.toMatch(/"(tokens|cost|totalTokens|estimatedCost)":(-|null)/);
    }

    // The cap still binds on real usage.
    const err = await pub
      .wrapHandler(makeProvider(60).handler)(payload("t4"))
      .catch((e: unknown) => e);
    expect((err as BudgetExceededError).reasonCode).toBe("token_budget_exceeded");
  });

  it("a failed attempt with negative usage cannot lower the tally", async () => {
    const pub = new AgentStatePublisher("redis://x", info, { maxTaskTokenBudget: 100 });
    await pub.wrapHandler(makeProvider(60).handler)(payload("t1")); // 60
    await pub
      .wrapHandler(async () => {
        throw new FailedAttemptError("KaibanJS workflow blocked: x", {
          inputTokens: -1,
          outputTokens: -500,
          estimatedCost: -1,
        });
      })(payload("t1"))
      .catch(() => undefined);
    expect(pub.getTotalTokensUsed()).toBe(60);
    const err = await pub
      .wrapHandler(makeProvider(40).handler)(payload("t1"))
      .catch((e: unknown) => e); // 100 >= 100
    expect((err as BudgetExceededError).reasonCode).toBe("task_token_budget_exceeded");
  });
});

describe("a failed attempt that reaches a cap keeps the original failure", () => {
  const failing = (tokens: number): (() => Promise<unknown>) => async () => {
    throw new FailedAttemptError("KaibanJS workflow blocked: tool quota exhausted", {
      inputTokens: tokens,
      outputTokens: 0,
      estimatedCost: 0.001,
    });
  };

  it("task cap: the breach message ends with the failure text and its cause is the original error", async () => {
    const pub = new AgentStatePublisher("redis://x", info, { maxTaskTokenBudget: 50 });
    const err = await pub.wrapHandler(failing(60))(payload("t1")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).code).toBe("BUDGET_EXCEEDED");
    expect((err as BudgetExceededError).reasonCode).toBe("task_token_budget_exceeded");
    expect((err as Error).message).toBe(
      "Task token budget exceeded: 60 >= 50 (failed attempt: KaibanJS workflow blocked: tool quota exhausted)",
    );
    expect((err as Error).cause).toBeInstanceOf(FailedAttemptError);
    expect(((err as Error).cause as Error).message).toBe(
      "KaibanJS workflow blocked: tool quota exhausted",
    );
  });

  it("agent cap: same, with reasonCode token_budget_exceeded", async () => {
    const pub = new AgentStatePublisher("redis://x", info, { maxTokenBudget: 50 });
    const err = await pub.wrapHandler(failing(50))(payload("t1")).catch((e: unknown) => e);
    expect((err as BudgetExceededError).reasonCode).toBe("token_budget_exceeded");
    expect((err as Error).message).toBe(
      "Token budget exceeded: 50 >= 50 (failed attempt: KaibanJS workflow blocked: tool quota exhausted)",
    );
    expect((err as Error).cause).toBeInstanceOf(FailedAttemptError);
  });

  it("a success-path breach carries no failure detail and no cause", async () => {
    const pub = new AgentStatePublisher("redis://x", info, { maxTaskTokenBudget: 50 });
    const err = await pub.wrapHandler(makeProvider(60).handler)(payload("t1")).catch((e: unknown) => e);
    expect((err as Error).message).toBe("Task token budget exceeded: 60 >= 50");
    expect((err as Error).cause).toBeUndefined();
  });
});
