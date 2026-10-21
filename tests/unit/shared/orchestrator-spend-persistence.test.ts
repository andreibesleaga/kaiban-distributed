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
import {
  BudgetExceededError,
  UNLIMITED,
  cleanSpendAmount,
  cleanSpendTotals,
} from "../../../src/shared/budget";
import { spendOfHandlerResult } from "../../../src/shared/orchestrator";

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

describe("WorkflowOrchestrator — clear() ends the run", () => {
  it("resets the totals and the stop record, and a later recordSpend does not re-create the record", async () => {
    const store = new InMemoryCheckpointStore();
    const provider = makeProvider(0.6);
    const orch = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });
    await orch.memoize("m", async () => ({ inputTokens: 2, outputTokens: 0, estimatedCost: 0 }));
    await orch.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 }); // 0.60 → stopped
    expect(orch.getStop()?.reason).toBe("budget_exceeded");

    await orch.clear();
    expect(orch.getSpend()).toEqual({ totalTokens: 0, estimatedCost: 0 });
    expect(orch.getStop()).toBeNull();

    orch.recordSpend({ totalTokens: 150, estimatedCost: 0.7 });
    await settle();
    expect(await store.load("wf")).toBeNull();

    // A new run with the same workflowId starts clean.
    const next = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });
    expect(await next.isResuming()).toBe(false);
    expect(next.getStop()).toBeNull();
    expect(next.getSpend()).toEqual({ totalTokens: 0, estimatedCost: 0 });
  });

  it("a step that settles after clear() does not re-create the record", async () => {
    const store = new InMemoryCheckpointStore();
    let release!: (v: string) => void;
    const router: RouterLike = {
      wait: (): Promise<string> => new Promise<string>((resolve) => (release = resolve)),
    };
    const orch = new WorkflowOrchestrator({ workflowId: "wf", router, store, budget: BUDGET });
    await orch.memoize("m", async () => 1);
    const inFlight = orch.runStep("s1", { dispatch: () => Promise.resolve("t1"), timeoutMs: 10 });
    await settle();
    await orch.clear();
    release(JSON.stringify({ inputTokens: 10, outputTokens: 0, estimatedCost: 0.1 }));
    await inFlight;
    await settle();
    expect(await store.load("wf")).toBeNull();
  });

  it("a step completed after clear() starts a fresh record holding only its own spend", async () => {
    const store = new InMemoryCheckpointStore();
    const provider = makeProvider(0.2);
    const orch = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });
    await orch.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 });
    await orch.clear();
    orch.recordSpend({ totalTokens: 1, estimatedCost: 0.05 });
    await orch.runStep("s2", { dispatch: provider.dispatch, timeoutMs: 10 });

    const raw = await store.load("wf");
    expect(Object.keys(raw ?? {}).sort()).toEqual([SPEND_KEY, "s2"]);
    expect(JSON.parse(raw![SPEND_KEY]!.result)).toMatchObject({ totalTokens: 101 });
    expect(JSON.parse(raw![SPEND_KEY]!.result).estimatedCost).toBeCloseTo(0.25, 10);
  });
});

describe("WorkflowOrchestrator — restored stop record", () => {
  it("uses the detail computed from the restored totals and the current budget", async () => {
    const store = new InMemoryCheckpointStore();
    await store.save("wf", {
      s1: { taskId: "t1", result: "done" },
      [SPEND_KEY]: {
        taskId: SPEND_KEY,
        result: JSON.stringify({
          totalTokens: 0,
          estimatedCost: 0.6,
          stop: { reason: "budget_exceeded", detail: "stale detail from an older budget" },
        }),
      },
    });
    const orch = new WorkflowOrchestrator({ workflowId: "wf", router: makeProvider(0).router, store, budget: BUDGET });
    await orch.isResuming();
    expect(orch.getStop()?.detail).not.toContain("stale");
    expect(orch.getStop()?.detail).toMatch(/0\.6000 >= \$0\.50/);
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

describe("WorkflowOrchestrator — a throwing onStopped cannot lose a paid step", () => {
  const throwingStop = (): void => {
    throw new Error("callback boom");
  };

  it("runStep: the step and its spend are still saved, and a restart replays it for free", async () => {
    const store = new InMemoryCheckpointStore();
    const provider = makeProvider(1);
    const orch = new WorkflowOrchestrator({
      workflowId: "wf", router: provider.router, store, budget: BUDGET, onStopped: throwingStop,
    });
    await expect(orch.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 })).resolves.toContain("result of");
    expect(orch.getStop()?.reason).toBe("budget_exceeded");
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "wf" }),
      expect.stringContaining("onStopped"),
    );

    const restarted = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });
    expect(await restarted.isResuming()).toBe(true);
    expect(restarted.getSpend()).toEqual({ totalTokens: 100, estimatedCost: 1 });
    await restarted.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 });
    expect(provider.requests).toBe(1);
  });

  it("memoize: the value and its spend are still saved", async () => {
    const store = new InMemoryCheckpointStore();
    const orch = new WorkflowOrchestrator({
      workflowId: "wf", router: makeProvider(0).router, store, budget: BUDGET, onStopped: throwingStop,
    });
    await expect(
      orch.memoize("m", async () => ({ inputTokens: 3, outputTokens: 0, estimatedCost: 1 })),
    ).resolves.toMatchObject({ estimatedCost: 1 });
    const raw = await store.load("wf");
    expect(Object.keys(raw ?? {}).sort()).toEqual([SPEND_KEY, "m"]);
    expect(JSON.parse(raw![SPEND_KEY]!.result)).toMatchObject({ totalTokens: 3, estimatedCost: 1 });
  });

  it("load: restored totals that breach a lowered cap are added once, even when onStopped throws", async () => {
    const store = new InMemoryCheckpointStore();
    await store.save("wf", {
      s1: { taskId: "t1", result: "done" },
      [SPEND_KEY]: { taskId: SPEND_KEY, result: JSON.stringify({ totalTokens: 10, estimatedCost: 1, stop: null }) },
    });
    const orch = new WorkflowOrchestrator({
      workflowId: "wf", router: makeProvider(0).router, store, budget: BUDGET, onStopped: throwingStop,
    });
    expect(await orch.isResuming()).toBe(true);
    expect(await orch.isResuming()).toBe(true);
    expect(orch.getSpend()).toEqual({ totalTokens: 10, estimatedCost: 1 });
    expect(orch.getStop()?.reason).toBe("budget_exceeded");
  });
});

/** An in-memory store whose `load` / `clear` can be held open until released. */
class GatedStore implements CheckpointStore {
  readonly inner = new InMemoryCheckpointStore();
  loadGate: Promise<void> | null = null;
  clearGate: Promise<void> | null = null;
  /** When set, a load rejects with it once its gate opens. */
  loadError: Error | null = null;
  loads = 0;
  async load(id: string): Promise<WorkflowCheckpoint | null> {
    this.loads += 1;
    const value = await this.inner.load(id); // read first, return late
    if (this.loadGate) await this.loadGate;
    if (this.loadError) throw this.loadError;
    return value;
  }
  save(id: string, cp: WorkflowCheckpoint): Promise<void> {
    return this.inner.save(id, cp);
  }
  async clear(id: string): Promise<void> {
    if (this.clearGate) await this.clearGate;
    return this.inner.clear(id);
  }
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

describe("WorkflowOrchestrator — clear() races", () => {
  it("a first load still in flight when clear() runs does not bring the old steps or spend back", async () => {
    const store = new GatedStore();
    await store.inner.save("wf", {
      a: { taskId: "ta", result: "old" },
      [SPEND_KEY]: { taskId: SPEND_KEY, result: JSON.stringify({ totalTokens: 10, estimatedCost: 0.01, stop: null }) },
    });
    const provider = makeProvider(0.1);
    const orch = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });
    const held = gate();
    store.loadGate = held.promise;

    const resuming = orch.isResuming();
    await settle(); // the load has read the old record and is waiting
    const cleared = orch.clear();
    await settle();
    held.open();
    await cleared;

    expect(await resuming).toBe(false);
    expect(orch.getSpend()).toEqual({ totalTokens: 0, estimatedCost: 0 });
    await orch.runStep("b", { dispatch: provider.dispatch, timeoutMs: 10 });
    expect(Object.keys((await store.inner.load("wf")) ?? {}).sort()).toEqual([SPEND_KEY, "b"]);
    expect(await orch.runStep("a", { dispatch: provider.dispatch, timeoutMs: 10 })).not.toBe("old");
    expect(provider.requests).toBe(2);
  });

  it("a step saved while store.clear() is still running is written after the delete, not wiped by it", async () => {
    const store = new GatedStore();
    const provider = makeProvider(0.1);
    const orch = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });
    await orch.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 });
    const held = gate();
    store.clearGate = held.promise;

    const cleared = orch.clear();
    await settle(); // clear() has reset the instance and is waiting on store.clear
    const next = orch.runStep("s2", { dispatch: provider.dispatch, timeoutMs: 10 });
    await settle();
    held.open();
    await cleared;
    await next;

    expect(Object.keys((await store.inner.load("wf")) ?? {}).sort()).toEqual([SPEND_KEY, "s2"]);
  });

  it("a failed store.clear() rejects clear() but does not block later saves", async () => {
    const store = new GatedStore();
    const provider = makeProvider(0.1);
    const orch = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });
    await orch.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 });
    store.clearGate = Promise.reject(new Error("redis down"));

    await expect(orch.clear()).rejects.toThrow("redis down");
    await orch.runStep("s2", { dispatch: provider.dispatch, timeoutMs: 10 });
    expect(Object.keys((await store.inner.load("wf")) ?? {}).sort()).toEqual([SPEND_KEY, "s2"]);
  });
});

describe("WorkflowOrchestrator — clear() vs a failing checkpoint load", () => {
  it("a load that fails after clear() neither re-arms a reload nor undoes the reset (no double count)", async () => {
    const store = new GatedStore();
    await store.inner.save("wf", {
      a: { taskId: "ta", result: "old" },
      [SPEND_KEY]: { taskId: SPEND_KEY, result: JSON.stringify({ totalTokens: 10, estimatedCost: 0.3, stop: null }) },
    });
    const provider = makeProvider(0.1);
    const orch = new WorkflowOrchestrator({ workflowId: "wf", router: provider.router, store, budget: BUDGET });
    const held = gate();
    store.loadGate = held.promise;
    store.loadError = new Error("redis down");

    const resuming = orch.isResuming();
    await settle(); // the first load is in flight
    const cleared = orch.clear();
    await settle();
    held.open(); // ... and fails after clear() has reset the instance
    await cleared;
    // The stale load's failure is discarded like its result would be.
    await expect(resuming).resolves.toBe(false);

    store.loadGate = null;
    store.loadError = null;
    await orch.runStep("b", { dispatch: provider.dispatch, timeoutMs: 10 }); // 0.10
    expect(await orch.isResuming()).toBe(true);
    // No second load: the fresh record (holding b's 0.10) is not added again,
    // and the old step "a" stays gone.
    expect(store.loads).toBe(1);
    expect(orch.getSpend().estimatedCost).toBeCloseTo(0.1, 10);
    expect(orch.getSpend().totalTokens).toBe(100);
    expect(await orch.runStep("a", { dispatch: provider.dispatch, timeoutMs: 10 })).not.toBe("old");
    expect(provider.requests).toBe(2);
  });

  it("a load that fails with no clear() in between is still retried", async () => {
    const store = new GatedStore();
    store.loadError = new Error("redis down");
    const orch = new WorkflowOrchestrator({ workflowId: "wf", router: makeProvider(0).router, store, budget: BUDGET });
    await expect(orch.isResuming()).rejects.toThrow("redis down");
    store.loadError = null;
    await expect(orch.isResuming()).resolves.toBe(false);
    expect(store.loads).toBe(2);
  });
});

describe("WorkflowOrchestrator — every spend number is cleaned (non-finite or negative → 0)", () => {
  it("NaN fed through recordSpend cannot disable the workflow cap", async () => {
    const provider = makeProvider(0.3);
    const orch = new WorkflowOrchestrator({
      workflowId: "wf", router: provider.router, store: new InMemoryCheckpointStore(), budget: BUDGET,
    });
    orch.recordSpend({ totalTokens: Number.NaN, estimatedCost: Number.NaN });
    orch.recordSpend({ totalTokens: Infinity, estimatedCost: -Infinity });
    expect(orch.getSpend()).toEqual({ totalTokens: 0, estimatedCost: 0 });
    await orch.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 }); // 0.30
    await orch.runStep("s2", { dispatch: provider.dispatch, timeoutMs: 10 }); // 0.60 ≥ 0.50
    expect(orch.getStop()?.reason).toBe("budget_exceeded");
    await expect(
      orch.runStep("s3", { dispatch: provider.dispatch, timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(provider.requests).toBe(2);
  });

  it("a negative recordSpend cannot lower the spend", async () => {
    const orch = new WorkflowOrchestrator({
      workflowId: "wf", router: makeProvider(0).router, store: new InMemoryCheckpointStore(), budget: BUDGET,
    });
    orch.recordSpend({ totalTokens: 10, estimatedCost: 0.4 });
    orch.recordSpend({ totalTokens: -10, estimatedCost: -0.4 });
    expect(orch.getSpend()).toEqual({ totalTokens: 10, estimatedCost: 0.4 });
    orch.recordSpend({ totalTokens: 0, estimatedCost: 0.1 });
    expect(orch.getStop()?.reason).toBe("budget_exceeded");
  });

  it("NaN or a negative value from a custom spendOf cannot disable the cap or lower the spend", async () => {
    const provider = makeProvider(0);
    const answers: Array<{ totalTokens: number; estimatedCost: number }> = [
      { totalTokens: Number.NaN, estimatedCost: Number.NaN },
      { totalTokens: -5, estimatedCost: -1 },
      { totalTokens: 1, estimatedCost: 0.6 },
    ];
    const orch = new WorkflowOrchestrator({
      workflowId: "wf",
      router: provider.router,
      store: new InMemoryCheckpointStore(),
      budget: BUDGET,
      spendOf: (): { totalTokens: number; estimatedCost: number } | undefined => answers.shift(),
    });
    await orch.runStep("s1", { dispatch: provider.dispatch, timeoutMs: 10 });
    await orch.memoize("m1", async () => "x");
    expect(orch.getSpend()).toEqual({ totalTokens: 0, estimatedCost: 0 });
    await orch.runStep("s2", { dispatch: provider.dispatch, timeoutMs: 10 });
    expect(orch.getSpend()).toEqual({ totalTokens: 1, estimatedCost: 0.6 });
    expect(orch.getStop()?.reason).toBe("budget_exceeded");
  });

  it("spendOfHandlerResult takes a -1 or other negative field as 0", () => {
    expect(
      spendOfHandlerResult({ inputTokens: -1, outputTokens: 4, estimatedCost: -1 }),
    ).toEqual({ totalTokens: 4, estimatedCost: 0 });
    expect(
      spendOfHandlerResult(JSON.stringify({ inputTokens: 3, outputTokens: -1_000, estimatedCost: 0.2 })),
    ).toEqual({ totalTokens: 3, estimatedCost: 0.2 });
  });

  it("the shared sanitiser: non-finite, negative or missing → 0; numeric strings are read", () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, -1, -0.5, undefined, null, "x", {}]) {
      expect(cleanSpendAmount(bad)).toBe(0);
    }
    expect(cleanSpendAmount(0)).toBe(0);
    expect(cleanSpendAmount(12)).toBe(12);
    expect(cleanSpendAmount("0.25")).toBe(0.25);
    expect(cleanSpendTotals({ totalTokens: -3 })).toEqual({ totalTokens: 0, estimatedCost: 0 });
    expect(cleanSpendTotals({ totalTokens: 3, estimatedCost: Number.NaN })).toEqual({
      totalTokens: 3,
      estimatedCost: 0,
    });
  });
});
