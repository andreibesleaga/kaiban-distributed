/**
 * WorkflowOrchestrator — workflow spend survives a restart, and is accounted
 * before the checkpoint is saved.
 *
 * The running totals and the stop record are saved with every checkpoint (one
 * reserved entry in the same record) and restored once when a fresh instance
 * with the same workflowId first loads it. Spend fed in from outside through
 * `recordSpend` is saved too. A step's spend is recorded BEFORE `store.save`
 * is awaited, so a failed save can neither lose the spend nor let a retry slip
 * past the cap.
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

import {
  WorkflowOrchestrator,
  InMemoryCheckpointStore,
  type CheckpointStore,
  type RouterLike,
  type WorkflowCheckpoint,
  type WorkflowStop,
} from "../../../src/shared/orchestrator";
import { BudgetExceededError, UNLIMITED } from "../../../src/shared/budget";

/** The reserved checkpoint entry that carries the workflow spend. */
const SPEND_KEY = "__workflow_spend__";

const BUDGET = { maxTokens: UNLIMITED, maxCostUsd: 0.5 };

/** A mock provider: each `dispatch` is one paid request costing `cost` USD. */
function makeProvider(cost: number): {
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
            inputTokens: 100,
            outputTokens: 0,
            estimatedCost: cost,
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

/** Let fire-and-forget saves (from `recordSpend`) settle. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/** An in-memory store whose next `failSaves` saves reject. */
class FlakyStore implements CheckpointStore {
  readonly inner = new InMemoryCheckpointStore();
  saves = 0;
  constructor(private failSaves: number) {}
  load(id: string): Promise<WorkflowCheckpoint | null> {
    return this.inner.load(id);
  }
  save(id: string, cp: WorkflowCheckpoint): Promise<void> {
    this.saves += 1;
    if (this.failSaves > 0) {
      this.failSaves -= 1;
      return Promise.reject(new Error("redis down"));
    }
    return this.inner.save(id, cp);
  }
  clear(id: string): Promise<void> {
    return this.inner.clear(id);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WorkflowOrchestrator — spend persisted with the checkpoint", () => {
  it("saves totals + stop in one reserved entry that steps never see", async () => {
    const store = new InMemoryCheckpointStore();
    const provider = makeProvider(0.6);
    const orch = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });
    await orch.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 });

    const raw = await store.load("wf");
    expect(Object.keys(raw ?? {}).sort()).toEqual([SPEND_KEY, "s1"]);
    expect(JSON.parse(raw![SPEND_KEY]!.result)).toEqual({
      totalTokens: 100,
      estimatedCost: 0.6,
      stop: { reason: "budget_exceeded", detail: orch.getStop()?.detail },
    });

    // A resumed instance counts only real steps as "resuming".
    const resumed = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });
    expect(await resumed.isResuming()).toBe(true);
    const spendOnly = new InMemoryCheckpointStore();
    await spendOnly.save("wf", { [SPEND_KEY]: raw![SPEND_KEY]! });
    const fresh = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store: spendOnly, budget: BUDGET });
    expect(await fresh.isResuming()).toBe(false);
    expect(fresh.getStop()?.reason).toBe("budget_exceeded");
  });

  it("restores spend under the cap and stops once a new step reaches it (onStopped fires then)", async () => {
    const store = new InMemoryCheckpointStore();
    const provider = makeProvider(0.3);
    const first = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });
    await first.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 }); // 0.30
    expect(first.getStop()).toBeNull();

    const stops: WorkflowStop[] = [];
    const resumed = new WorkflowOrchestrator({
      workflowId: "wf",
      router: provider.router,
      store,
      budget: BUDGET,
      onStopped: (s): number => stops.push(s),
    });
    await resumed.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 }); // replay, free
    expect(resumed.getSpend().estimatedCost).toBeCloseTo(0.3, 10);
    await resumed.runStep("s2", { dispatch: provider.dispatch, timeoutMs: 10 }); // 0.60 ≥ 0.50
    expect(stops).toHaveLength(1);
    expect(stops[0]?.totals.estimatedCost).toBeCloseTo(0.6, 10);
    await expect(
      resumed.runStep("s3", { dispatch: provider.dispatch, timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(provider.requests).toBe(2);
  });

  it("recordSpend is saved without waiting for a next step, so its stop survives a restart", async () => {
    const store = new InMemoryCheckpointStore();
    const provider = makeProvider(0.1);
    const first = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });
    await first.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 }); // 0.10
    first.recordSpend({ totalTokens: 7, estimatedCost: 0.45 }); // 0.55 → stopped
    expect(first.getStop()?.reason).toBe("budget_exceeded");
    await settle();

    const resumed = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });
    await expect(
      resumed.runStep("s2", { dispatch: provider.dispatch, timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(provider.requests).toBe(1);
    expect(resumed.getSpend().totalTokens).toBe(107);
    expect(resumed.getSpend().estimatedCost).toBeCloseTo(0.55, 10);
  });

  it("spend recorded before the first load is added to the restored totals, once", async () => {
    const store = new InMemoryCheckpointStore();
    const provider = makeProvider(0.2);
    const first = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });
    await first.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 }); // 0.20

    const stops: WorkflowStop[] = [];
    const resumed = new WorkflowOrchestrator({
      workflowId: "wf",
      router: provider.router,
      store,
      budget: BUDGET,
      onStopped: (s): number => stops.push(s),
    });
    resumed.recordSpend({ totalTokens: 0, estimatedCost: 0.35 }); // alone: under the cap
    expect(resumed.getStop()).toBeNull();
    await resumed.isResuming(); // first load: 0.20 restored + 0.35 = 0.55
    await resumed.isResuming(); // second call does not restore again
    await settle();
    expect(resumed.getSpend().estimatedCost).toBeCloseTo(0.55, 10);
    expect(stops).toHaveLength(1); // the merge reached the cap → newly stopped

    // The merged totals were saved: a third instance sees 0.55 too.
    const third = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });
    await third.isResuming();
    expect(third.getSpend().estimatedCost).toBeCloseTo(0.55, 10);
  });

  it("a larger cap on resume lifts a restored stop (spend is kept, the cap is re-checked)", async () => {
    const store = new InMemoryCheckpointStore();
    const provider = makeProvider(0.6);
    const first = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });
    await first.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 });

    const raised = new WorkflowOrchestrator({
      workflowId: "wf",
      router: provider.router,
      store,
      budget: { maxTokens: UNLIMITED, maxCostUsd: 2 },
    });
    await raised.runStep("s2", { dispatch: provider.dispatch, timeoutMs: 10 });
    expect(raised.getStop()).toBeNull();
    expect(raised.getSpend().estimatedCost).toBeCloseTo(1.2, 10);
    expect(provider.requests).toBe(2);
  });

  it("a corrupt or partial spend entry restores as zero spend", async () => {
    for (const result of [
      "not json",
      "null",
      JSON.stringify({ totalTokens: "x", stop: { reason: "other" } }),
      JSON.stringify({ stop: { reason: "budget_exceeded" } }), // no detail, no spend
      JSON.stringify({ totalTokens: -500, estimatedCost: -1 }), // negative cannot loosen the cap
    ]) {
      const store = new InMemoryCheckpointStore();
      await store.save("wf", {
        [SPEND_KEY]: { taskId: SPEND_KEY, result },
        s1: { taskId: "t1", result: "done" },
      });
      const orch = new WorkflowOrchestrator({ workflowId: "wf", router: makeProvider(0).router, store, budget: BUDGET });
      expect(await orch.isResuming()).toBe(true);
      expect(orch.getSpend()).toEqual({ totalTokens: 0, estimatedCost: 0 });
      expect(orch.getStop()).toBeNull();
    }
  });

  it("refuses the reserved step name in runStep and memoize", async () => {
    const provider = makeProvider(0);
    const orch = new WorkflowOrchestrator({
      workflowId: "wf",
      router: provider.router,
      store: new InMemoryCheckpointStore(),
      budget: BUDGET,
    });
    await expect(
      orch.runStep(SPEND_KEY, { dispatch: provider.dispatch, timeoutMs: 10 }),
    ).rejects.toThrow(/reserved/);
    await expect(orch.memoize(SPEND_KEY, async () => 1)).rejects.toThrow(/reserved/);
    expect(provider.requests).toBe(0);
  });

  it("a failed load is retried on the next call instead of being cached", async () => {
    const store = new InMemoryCheckpointStore();
    const load = vi
      .spyOn(store, "load")
      .mockRejectedValueOnce(new Error("redis down"));
    const orch = new WorkflowOrchestrator({ workflowId: "wf", router: makeProvider(0).router, store, budget: BUDGET });
    await expect(orch.isResuming()).rejects.toThrow(/redis down/);
    await expect(orch.isResuming()).resolves.toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a failed background save of recordSpend is logged, not thrown", async () => {
    const store = new FlakyStore(1);
    const orch = new WorkflowOrchestrator({ workflowId: "wf", router: makeProvider(0).router, store, budget: BUDGET });
    orch.recordSpend({ totalTokens: 1, estimatedCost: 0.1 });
    await settle();
    expect(store.saves).toBe(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "wf" }),
      expect.stringContaining("spend"),
    );
    // The next save carries the spend that the failed one dropped.
    await orch.memoize("m", async () => ({ ok: true }));
    const raw = await store.inner.load("wf");
    expect(JSON.parse(raw![SPEND_KEY]!.result)).toMatchObject({ estimatedCost: 0.1 });
  });

  it("clear() waits for a pending background save, so the cleared record is not re-created", async () => {
    const store = new InMemoryCheckpointStore();
    const orch = new WorkflowOrchestrator({ workflowId: "wf", router: makeProvider(0).router, store, budget: BUDGET });
    orch.recordSpend({ totalTokens: 1, estimatedCost: 0.1 });
    await orch.clear();
    await settle();
    expect(await store.load("wf")).toBeNull();
  });
});

describe("WorkflowOrchestrator — spend accounted before store.save", () => {
  it("runStep: a rejected save still records the spend once; the retry is not charged and cannot pass the cap", async () => {
    const store = new FlakyStore(1);
    const provider = makeProvider(0.6);
    const orch = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });

    await expect(
      orch.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 }),
    ).rejects.toThrow(/redis down/);
    expect(orch.getSpend()).toEqual({ totalTokens: 100, estimatedCost: 0.6 });
    expect(orch.getStop()?.reason).toBe("budget_exceeded");

    // Retrying the same step returns the cached result without charging again.
    await expect(
      orch.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 }),
    ).resolves.toContain("result of task-1");
    expect(orch.getSpend()).toEqual({ totalTokens: 100, estimatedCost: 0.6 });

    // The next new step is refused before dispatch.
    await expect(
      orch.runStep("s2", { dispatch: provider.dispatch, timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(provider.requests).toBe(1);
  });

  it("runStep: the dedup guard still holds when the save rejects (a reused taskId costs nothing)", async () => {
    const store = new FlakyStore(0);
    const provider = makeProvider(0.3);
    const orch = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });
    await orch.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 }); // 0.30
    vi.spyOn(store, "save").mockRejectedValueOnce(new Error("redis down"));
    await expect(
      orch.runStep("s1-again", { dispatch: () => Promise.resolve("task-1"), timeoutMs: 10 }),
    ).rejects.toThrow(/redis down/);
    expect(orch.getSpend().estimatedCost).toBeCloseTo(0.3, 10);
    expect(orch.getStop()).toBeNull();
  });

  it("memoize: a rejected save still records the spend once; the retry is not charged and cannot pass the cap", async () => {
    const store = new FlakyStore(1);
    const orch = new WorkflowOrchestrator({ workflowId: "wf", router: makeProvider(0).router, store, budget: BUDGET });
    const produce = vi.fn().mockResolvedValue({
      answer: "phase",
      inputTokens: 40,
      outputTokens: 10,
      estimatedCost: 0.6,
    });

    await expect(orch.memoize("phase", produce)).rejects.toThrow(/redis down/);
    expect(orch.getSpend()).toEqual({ totalTokens: 50, estimatedCost: 0.6 });

    await expect(orch.memoize("phase", produce)).resolves.toMatchObject({ answer: "phase" });
    expect(produce).toHaveBeenCalledTimes(1);
    expect(orch.getSpend()).toEqual({ totalTokens: 50, estimatedCost: 0.6 });

    const next = vi.fn().mockResolvedValue({ answer: "x" });
    await expect(orch.memoize("next", next)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(next).not.toHaveBeenCalled();
  });
});
