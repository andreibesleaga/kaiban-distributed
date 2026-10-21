/**
 * WorkflowOrchestrator — the workflow cost cap enforced in the runtime.
 *
 * When the aggregated spend reaches MAX_WORKFLOW_COST_USD (default 0.50) the
 * orchestrator stops dispatching: every further runStep/memoize throws a
 * BudgetExceededError (reason `budget_exceeded`) BEFORE dispatch, so a mock
 * provider that counts requests sees zero further requests after the cap.
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

import {
  WorkflowOrchestrator,
  InMemoryCheckpointStore,
  spendOfHandlerResult,
  type RouterLike,
  type WorkflowStop,
} from "../../../src/shared/orchestrator";
import { BudgetExceededError, UNLIMITED } from "../../../src/shared/budget";

/**
 * A mock LLM provider behind a mock router: `dispatch` is one paid request and
 * the router resolves the structured handler result with its cost.
 */
function makeProvider(costPerRequest: number, tokensPerRequest = 100): {
  requests: number;
  router: RouterLike;
  dispatch: () => Promise<string>;
} {
  const provider = {
    requests: 0,
    router: {
      wait: (taskId: string): Promise<string> =>
        Promise.resolve(
          JSON.stringify({
            answer: `result of ${taskId}`,
            inputTokens: tokensPerRequest,
            outputTokens: 0,
            estimatedCost: costPerRequest,
          }),
        ),
    },
    dispatch: (): Promise<string> => {
      provider.requests += 1;
      return Promise.resolve(`task-${provider.requests}`);
    },
  };
  return provider;
}

const savedEnv = { ...process.env };
beforeEach(() => {
  delete process.env["MAX_WORKFLOW_COST_USD"];
  delete process.env["MAX_WORKFLOW_TOKENS"];
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("WorkflowOrchestrator — cost cap", () => {
  it("stops dispatching once the aggregated cost reaches the cap: zero further requests", async () => {
    const provider = makeProvider(0.3);
    const stops: WorkflowStop[] = [];
    const orch = new WorkflowOrchestrator({
      workflowId: "wf",
      router: provider.router,
      store: new InMemoryCheckpointStore(),
      budget: { maxTokens: UNLIMITED, maxCostUsd: 0.5 },
      onStopped: (s): number => stops.push(s),
    });

    await orch.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 }); // 0.30
    expect(orch.getStop()).toBeNull();
    await orch.runStep("s2", { dispatch: provider.dispatch, timeoutMs: 10 }); // 0.60 ≥ 0.50
    expect(provider.requests).toBe(2);

    const stop = orch.getStop();
    expect(stop).toMatchObject({ reason: "budget_exceeded" });
    expect(stop?.detail).toContain("cost budget exceeded");
    expect(stop?.totals.estimatedCost).toBeCloseTo(0.6, 10);
    expect(stops).toHaveLength(1);
    expect(orch.getSpend()).toEqual({ totalTokens: 200, estimatedCost: 0.6 });

    // Every further step is refused BEFORE dispatch — the provider sees nothing.
    for (const name of ["s3", "s4", "s5"]) {
      const err = await orch
        .runStep(name, { dispatch: provider.dispatch, timeoutMs: 10 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect((err as BudgetExceededError).reasonCode).toBe("budget_exceeded");
      expect((err as Error).message).toContain("workflow wf stopped");
    }
    const memo = vi.fn().mockResolvedValue({ x: 1 });
    await expect(orch.memoize("m1", memo)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(memo).not.toHaveBeenCalled();
    expect(provider.requests).toBe(2);
    expect(stops).toHaveLength(1); // onStopped fires once
  });

  it("defaults to MAX_WORKFLOW_COST_USD from the environment (0.50 when unset)", async () => {
    const provider = makeProvider(0.25);
    const orch = new WorkflowOrchestrator({
      workflowId: "wf-env",
      router: provider.router,
      store: new InMemoryCheckpointStore(),
    });
    await orch.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 });
    await orch.runStep("s2", { dispatch: provider.dispatch, timeoutMs: 10 }); // 0.50 reached
    await expect(
      orch.runStep("s3", { dispatch: provider.dispatch, timeoutMs: 10 }),
    ).rejects.toThrow(/cost budget exceeded \(\$0\.5000 >= \$0\.50\)/);
    expect(provider.requests).toBe(2);
  });

  it("`unlimited` in the environment removes the cap", async () => {
    process.env["MAX_WORKFLOW_COST_USD"] = "unlimited";
    const provider = makeProvider(100);
    const orch = new WorkflowOrchestrator({
      workflowId: "wf-unl",
      router: provider.router,
      store: new InMemoryCheckpointStore(),
    });
    for (let i = 0; i < 5; i++) {
      await orch.runStep(`s${i}`, { dispatch: provider.dispatch, timeoutMs: 10 });
    }
    expect(provider.requests).toBe(5);
    expect(orch.getStop()).toBeNull();
  });

  it("enforces the token ceiling too (MAX_WORKFLOW_TOKENS)", async () => {
    const provider = makeProvider(0, 400);
    const orch = new WorkflowOrchestrator({
      workflowId: "wf-tok",
      router: provider.router,
      store: new InMemoryCheckpointStore(),
      budget: { maxTokens: 1000, maxCostUsd: UNLIMITED },
    });
    await orch.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 }); // 400
    await orch.runStep("s2", { dispatch: provider.dispatch, timeoutMs: 10 }); // 800
    await orch.runStep("s3", { dispatch: provider.dispatch, timeoutMs: 10 }); // 1200 ≥ 1000
    await expect(
      orch.runStep("s4", { dispatch: provider.dispatch, timeoutMs: 10 }),
    ).rejects.toThrow(/token budget exceeded/);
    expect(provider.requests).toBe(3);
  });

  it("checkpointed steps still replay after a stop (they cost nothing); the next new step is refused", async () => {
    const store = new InMemoryCheckpointStore();
    const provider = makeProvider(0.6);
    const first = new WorkflowOrchestrator({
      workflowId: "wf-cp",
      router: provider.router,
      store,
      budget: { maxTokens: UNLIMITED, maxCostUsd: 0.5 },
    });
    await first.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 }); // 0.6 → stopped
    expect(first.getStop()?.reason).toBe("budget_exceeded");

    // A resumed instance replays s1 from the checkpoint without dispatching.
    const resumed = new WorkflowOrchestrator({
      workflowId: "wf-cp",
      router: provider.router,
      store,
      budget: { maxTokens: UNLIMITED, maxCostUsd: 0.5 },
    });
    await expect(
      resumed.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 }),
    ).resolves.toContain("result of task-1");
    expect(provider.requests).toBe(1);
    // Totals are per instance (not persisted): the resumed run starts at zero.
    expect(resumed.getSpend()).toEqual({ totalTokens: 0, estimatedCost: 0 });
  });

  it("a deduplicated taskId is not accounted twice", async () => {
    const provider = makeProvider(0.3);
    const orch = new WorkflowOrchestrator({
      workflowId: "wf-dedup",
      router: provider.router,
      store: new InMemoryCheckpointStore(),
      budget: { maxTokens: UNLIMITED, maxCostUsd: 0.5 },
    });
    await orch.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 });
    // Same taskId as s1 → reuses the result, no wait, no spend.
    await orch.runStep("s1-again", { dispatch: () => Promise.resolve("task-1"), timeoutMs: 10 });
    expect(orch.getSpend().estimatedCost).toBeCloseTo(0.3, 10);
    expect(orch.getStop()).toBeNull();
  });

  it("memoize accounts a structured producer value and recordSpend feeds external totals", async () => {
    const stops: WorkflowStop[] = [];
    const orch = new WorkflowOrchestrator({
      workflowId: "wf-memo",
      router: makeProvider(0).router,
      store: new InMemoryCheckpointStore(),
      budget: { maxTokens: UNLIMITED, maxCostUsd: 0.5 },
      onStopped: (s): number => stops.push(s),
    });
    const value = await orch.memoize("phase", async () => ({
      answer: "x",
      inputTokens: 10,
      outputTokens: 5,
      estimatedCost: 0.2,
    }));
    expect(value.answer).toBe("x");
    expect(orch.getSpend()).toEqual({ totalTokens: 15, estimatedCost: 0.2 });

    // A producer value without usage fields counts as zero spend.
    await orch.memoize("plain", async () => ({ summary: "no usage here" }));
    expect(orch.getSpend().estimatedCost).toBeCloseTo(0.2, 10);

    orch.recordSpend({ totalTokens: 0, estimatedCost: 0.3 }); // 0.5 reached
    expect(stops).toHaveLength(1);
    orch.recordSpend({ totalTokens: 1, estimatedCost: 1 }); // still counted, no second stop
    expect(stops).toHaveLength(1);
    expect(orch.getSpend()).toEqual({ totalTokens: 16, estimatedCost: 1.5 });
    await expect(orch.memoize("next", async () => 1)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it("a custom spendOf extractor replaces the default", async () => {
    const provider = makeProvider(0.01);
    const orch = new WorkflowOrchestrator({
      workflowId: "wf-custom",
      router: provider.router,
      store: new InMemoryCheckpointStore(),
      budget: { maxTokens: UNLIMITED, maxCostUsd: 0.5 },
      spendOf: (): { totalTokens: number; estimatedCost: number } => ({ totalTokens: 0, estimatedCost: 0.5 }),
    });
    await orch.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 });
    expect(orch.getStop()?.reason).toBe("budget_exceeded");
  });
});

describe("spendOfHandlerResult", () => {
  it("reads the structured handler-result shape from a JSON string or an object", () => {
    expect(
      spendOfHandlerResult(
        JSON.stringify({ answer: "a", inputTokens: 7, outputTokens: 3, estimatedCost: 0.02 }),
      ),
    ).toEqual({ totalTokens: 10, estimatedCost: 0.02 });
    expect(spendOfHandlerResult({ estimatedCost: 1 })).toEqual({
      totalTokens: 0,
      estimatedCost: 1,
    });
    expect(spendOfHandlerResult({ inputTokens: "4", outputTokens: "x" })).toEqual({
      totalTokens: 4,
      estimatedCost: 0,
    });
  });

  it("returns undefined for plain text, null, primitives and objects without usage fields", () => {
    expect(spendOfHandlerResult("plain text result")).toBeUndefined();
    expect(spendOfHandlerResult(null)).toBeUndefined();
    expect(spendOfHandlerResult(42)).toBeUndefined();
    expect(spendOfHandlerResult("123")).toBeUndefined();
    expect(spendOfHandlerResult({ answer: "no usage" })).toBeUndefined();
  });
});
