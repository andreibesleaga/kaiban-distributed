/**
 * WorkflowOrchestrator — reusable single-active orchestrator (master plan §B5.1 Phase R).
 *
 * Drives a workflow via CompletionRouter with Redis checkpoint→resume and
 * taskId idempotency. These tests use an in-memory CheckpointStore + a fake
 * CompletionRouter so they run with zero brokers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  WorkflowOrchestrator,
  InMemoryCheckpointStore,
  type CheckpointStore,
  type RouterLike,
} from "../../../src/shared/orchestrator";

function makeRouter(
  resultsByTask: Record<string, string | Error>,
): RouterLike & { waitCalls: string[] } {
  const waitCalls: string[] = [];
  return {
    waitCalls,
    wait(taskId: string): Promise<string> {
      waitCalls.push(taskId);
      const r = resultsByTask[taskId];
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r ?? "");
    },
  };
}

describe("WorkflowOrchestrator", () => {
  let store: CheckpointStore;

  beforeEach(() => {
    store = new InMemoryCheckpointStore();
  });

  it("runs a step: dispatches, waits, checkpoints, returns the result", async () => {
    const router = makeRouter({ t1: "RESEARCH-OUTPUT" });
    const orch = new WorkflowOrchestrator({ workflowId: "wf-1", router, store });

    const dispatch = vi.fn().mockResolvedValue("t1");
    const out = await orch.runStep("research", { dispatch, timeoutMs: 1000 });

    expect(out).toBe("RESEARCH-OUTPUT");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(router.waitCalls).toEqual(["t1"]);
    // checkpoint persisted under a namespaced key
    expect(await store.load("wf-1")).toMatchObject({
      research: { taskId: "t1", result: "RESEARCH-OUTPUT" },
    });
  });

  it("RESUME: a checkpointed step is NOT re-dispatched (no double-spend)", async () => {
    // Pre-seed a checkpoint as if the process had crashed after step 1.
    await store.save("wf-1", {
      research: { taskId: "t1", result: "CACHED-RESEARCH" },
    });
    const router = makeRouter({});
    const orch = new WorkflowOrchestrator({ workflowId: "wf-1", router, store });

    const dispatch = vi.fn().mockResolvedValue("t-NEW");
    const out = await orch.runStep("research", { dispatch, timeoutMs: 1000 });

    expect(out).toBe("CACHED-RESEARCH");
    expect(dispatch).not.toHaveBeenCalled(); // idempotent resume — paid LLM call skipped
    expect(router.waitCalls).toEqual([]); // router never invoked on resume
  });

  it("resumes from last checkpoint: completed steps skipped, remaining run", async () => {
    await store.save("wf-1", {
      research: { taskId: "t1", result: "CACHED-RESEARCH" },
    });
    const router = makeRouter({ t2: "WRITE-OUTPUT" });
    const orch = new WorkflowOrchestrator({ workflowId: "wf-1", router, store });

    const dispatchResearch = vi.fn().mockResolvedValue("t1");
    const dispatchWrite = vi.fn().mockResolvedValue("t2");

    const r = await orch.runStep("research", { dispatch: dispatchResearch, timeoutMs: 1000 });
    const w = await orch.runStep("write", { dispatch: dispatchWrite, timeoutMs: 1000 });

    expect(r).toBe("CACHED-RESEARCH");
    expect(w).toBe("WRITE-OUTPUT");
    expect(dispatchResearch).not.toHaveBeenCalled();
    expect(dispatchWrite).toHaveBeenCalledTimes(1);
  });

  it("idempotency: dispatch returning an already-checkpointed taskId does not re-wait", async () => {
    // Two distinct step names that (pathologically) dispatch the SAME taskId.
    const router = makeRouter({ tX: "ONLY-ONCE" });
    const orch = new WorkflowOrchestrator({ workflowId: "wf-1", router, store });

    const out1 = await orch.runStep("a", { dispatch: () => Promise.resolve("tX"), timeoutMs: 1000 });
    const out2 = await orch.runStep("b", { dispatch: () => Promise.resolve("tX"), timeoutMs: 1000 });

    expect(out1).toBe("ONLY-ONCE");
    expect(out2).toBe("ONLY-ONCE"); // deduped by taskId — reuses the first result
    expect(router.waitCalls).toEqual(["tX"]); // wait() called exactly once for tX
  });

  it("propagates a step failure and does NOT checkpoint the failed step", async () => {
    const router = makeRouter({ tf: new Error("Agent failed: boom") });
    const orch = new WorkflowOrchestrator({ workflowId: "wf-1", router, store });

    await expect(
      orch.runStep("research", { dispatch: () => Promise.resolve("tf"), timeoutMs: 1000 }),
    ).rejects.toThrow(/boom/);
    const cp = await store.load("wf-1");
    expect(cp?.["research"]).toBeUndefined(); // failed step is re-runnable on resume
  });

  it("clear() wipes the checkpoint (call on terminal completion)", async () => {
    await store.save("wf-1", { research: { taskId: "t1", result: "x" } });
    const router = makeRouter({});
    const orch = new WorkflowOrchestrator({ workflowId: "wf-1", router, store });

    await orch.clear();
    expect(await store.load("wf-1")).toBeNull();
  });

  it("isResuming() reports whether a prior checkpoint exists", async () => {
    const router = makeRouter({});
    const fresh = new WorkflowOrchestrator({ workflowId: "wf-fresh", router, store });
    expect(await fresh.isResuming()).toBe(false);

    await store.save("wf-old", { a: { taskId: "t", result: "r" } });
    const resumed = new WorkflowOrchestrator({ workflowId: "wf-old", router, store });
    expect(await resumed.isResuming()).toBe(true);
  });

  it("passes the AbortSignal + label through to the router", async () => {
    const wait = vi.fn().mockResolvedValue("ok");
    const router: RouterLike = { wait };
    const orch = new WorkflowOrchestrator({ workflowId: "wf-1", router, store });
    const ac = new AbortController();

    await orch.runStep("research", {
      dispatch: () => Promise.resolve("t9"),
      timeoutMs: 4242,
      label: "research-label",
      signal: ac.signal,
    });

    expect(wait).toHaveBeenCalledWith("t9", 4242, "research-label", ac.signal);
  });

  it("defaults the wait label to the step name", async () => {
    const wait = vi.fn().mockResolvedValue("ok");
    const router: RouterLike = { wait };
    const orch = new WorkflowOrchestrator({ workflowId: "wf-1", router, store });

    await orch.runStep("editorial", { dispatch: () => Promise.resolve("t"), timeoutMs: 10 });
    expect(wait).toHaveBeenCalledWith("t", 10, "editorial", undefined);
  });
});

// ── memoize: phase-level checkpoint→resume for structured results ─────────────

describe("WorkflowOrchestrator.memoize", () => {
  let store: CheckpointStore;
  const noopRouter: RouterLike = { wait: () => Promise.resolve("") };

  beforeEach(() => {
    store = new InMemoryCheckpointStore();
  });

  it("runs the producer once and checkpoints its (structured) result", async () => {
    const orch = new WorkflowOrchestrator({ workflowId: "wf-1", router: noopRouter, store });
    const produce = vi.fn().mockResolvedValue({ summary: "RESEARCH", tokens: 42 });

    const out = await orch.memoize("research", produce);

    expect(out).toEqual({ summary: "RESEARCH", tokens: 42 });
    expect(produce).toHaveBeenCalledTimes(1);
    // Persisted under the step name (taskId namespaced to the step) for resume.
    const cp = await store.load("wf-1");
    expect(cp?.["research"]?.taskId).toBe("memoize:research");
    expect(JSON.parse(cp!["research"]!.result)).toEqual({ summary: "RESEARCH", tokens: 42 });
  });

  it("RESUME: a memoized step returns the cached value without re-running the producer", async () => {
    await store.save("wf-1", {
      research: { taskId: "memoize:research", result: JSON.stringify({ summary: "CACHED" }) },
    });
    const orch = new WorkflowOrchestrator({ workflowId: "wf-1", router: noopRouter, store });
    const produce = vi.fn().mockResolvedValue({ summary: "FRESH" });

    const out = await orch.memoize<{ summary: string }>("research", produce);

    expect(out).toEqual({ summary: "CACHED" });
    expect(produce).not.toHaveBeenCalled(); // resumed — paid phase skipped
  });

  it("does NOT checkpoint a failed producer (so it re-runs on resume)", async () => {
    const orch = new WorkflowOrchestrator({ workflowId: "wf-1", router: noopRouter, store });
    const produce = vi.fn().mockRejectedValue(new Error("phase boom"));

    await expect(orch.memoize("write", produce)).rejects.toThrow(/phase boom/);
    expect((await store.load("wf-1"))?.["write"]).toBeUndefined();
  });
});

describe("InMemoryCheckpointStore", () => {
  it("save/load/clear roundtrip", async () => {
    const store = new InMemoryCheckpointStore();
    expect(await store.load("k")).toBeNull();
    await store.save("k", { s: { taskId: "t", result: "r" } });
    expect(await store.load("k")).toEqual({ s: { taskId: "t", result: "r" } });
    await store.clear("k");
    expect(await store.load("k")).toBeNull();
  });

  it("isolates checkpoints by workflow id", async () => {
    const store = new InMemoryCheckpointStore();
    await store.save("a", { s: { taskId: "ta", result: "ra" } });
    await store.save("b", { s: { taskId: "tb", result: "rb" } });
    expect(await store.load("a")).toEqual({ s: { taskId: "ta", result: "ra" } });
    expect(await store.load("b")).toEqual({ s: { taskId: "tb", result: "rb" } });
  });
});
