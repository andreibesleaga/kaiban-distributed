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
import { NonRetryableError } from "../../../src/domain/errors/DomainError";
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
