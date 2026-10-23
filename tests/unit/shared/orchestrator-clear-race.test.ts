/**
 * WorkflowOrchestrator — a step that was waiting for the first checkpoint load
 * when `clear()` ran belongs to the finished run: it must not dispatch (and pay)
 * after the reset, nor re-create the cleared record. A malformed spend value
 * never throws (it counts as zero).
 */
import { describe, it, expect, vi } from "vitest";

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
  type CheckpointStore,
  type RouterLike,
  type WorkflowCheckpoint,
} from "../../../src/shared/orchestrator";
import { UNLIMITED, cleanSpendAmount } from "../../../src/shared/budget";

const BUDGET = { maxTokens: UNLIMITED, maxCostUsd: 0.5 };

/** A store whose first load waits until the test releases it. */
function makeSlowStore(): {
  store: CheckpointStore;
  releaseLoad: () => void;
  saved: WorkflowCheckpoint[];
} {
  let releaseLoad!: () => void;
  const gate = new Promise<void>((r) => (releaseLoad = r));
  const saved: WorkflowCheckpoint[] = [];
  const store: CheckpointStore = {
    load: async () => {
      await gate;
      return null;
    },
    save: (_id, cp) => {
      saved.push(cp);
      return Promise.resolve();
    },
    clear: () => Promise.resolve(),
  };
  return { store, releaseLoad, saved };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("WorkflowOrchestrator — steps waiting on the first load when clear() runs", () => {
  it("runStep does not dispatch and does not save after the reset", async () => {
    const { store, releaseLoad, saved } = makeSlowStore();
    const router: RouterLike = { wait: () => Promise.resolve("{}") };
    const dispatch = vi.fn().mockResolvedValue("t1");
    const orch = new WorkflowOrchestrator({
      workflowId: "wf",
      router,
      store,
      budget: BUDGET,
    });

    const step = orch.runStep("s1", { dispatch, timeoutMs: 10 });
    await settle();
    await orch.clear();
    releaseLoad();

    await expect(step).rejects.toThrow(/cleared/);
    expect(dispatch).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("memoize does not run its producer after the reset", async () => {
    const { store, releaseLoad, saved } = makeSlowStore();
    const router: RouterLike = { wait: () => Promise.resolve("{}") };
    const produce = vi.fn().mockResolvedValue(1);
    const orch = new WorkflowOrchestrator({
      workflowId: "wf",
      router,
      store,
      budget: BUDGET,
    });

    const step = orch.memoize("m", produce);
    await settle();
    await orch.clear();
    releaseLoad();

    await expect(step).rejects.toThrow(/cleared/);
    expect(produce).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });
});

describe("cleanSpendAmount — never throws", () => {
  it("a value whose conversion throws counts as zero", () => {
    const hostile = {
      valueOf(): number {
        throw new Error("no");
      },
      toString(): string {
        throw new Error("no");
      },
    };
    expect(cleanSpendAmount(hostile)).toBe(0);
    expect(cleanSpendAmount(Symbol("x"))).toBe(0);
  });
});
