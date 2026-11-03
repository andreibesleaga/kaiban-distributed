/**
 * WorkflowOrchestrator — the emergency STOP ALL signal (roadmap §6.10 ES-4,
 * ADR-025): the current wait ends with EmergencyStopError, and no further step
 * is dispatched or produced.
 */
import { describe, it, expect, vi, type Mock } from "vitest";
import {
  WorkflowOrchestrator,
  InMemoryCheckpointStore,
  type RouterLike,
} from "../../../src/shared/orchestrator";
import { EmergencyStopError } from "../../../src/domain/errors/DomainError";

/** A router whose wait settles only when its signal aborts (a running task). */
function hangingRouter(): RouterLike & { signals: (AbortSignal | undefined)[] } {
  const signals: (AbortSignal | undefined)[] = [];
  return {
    signals,
    wait: vi.fn(
      (_taskId: string, _ms: number, _label: string, signal?: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signals.push(signal);
          signal?.addEventListener("abort", () => reject(signal.reason as Error));
        }),
    ),
  };
}

const step = (
  dispatch: Mock<() => Promise<string>> = vi.fn<() => Promise<string>>().mockResolvedValue("t1"),
): { dispatch: Mock<() => Promise<string>>; timeoutMs: number } => ({
  dispatch,
  timeoutMs: 60_000,
});

describe("WorkflowOrchestrator — stop signal", () => {
  it("a stop during a step's wait rejects the step with EmergencyStopError", async () => {
    const router = hangingRouter();
    const stop = new AbortController();
    const orch = new WorkflowOrchestrator({
      workflowId: "wf",
      router,
      store: new InMemoryCheckpointStore(),
      stopSignal: stop.signal,
    });
    const running = orch.runStep("research", step());
    await new Promise((r) => setTimeout(r, 0));
    const reason = new EmergencyStopError();
    stop.abort(reason);
    await expect(running).rejects.toBe(reason);
  });

  it("combines the step's own signal with the stop signal (either one aborts the wait)", async () => {
    const router = hangingRouter();
    const stop = new AbortController();
    const own = new AbortController();
    const orch = new WorkflowOrchestrator({
      workflowId: "wf",
      router,
      store: new InMemoryCheckpointStore(),
      stopSignal: stop.signal,
    });
    const running = orch.runStep("research", { ...step(), signal: own.signal });
    await new Promise((r) => setTimeout(r, 0));
    own.abort(new Error("caller cancel"));
    await expect(running).rejects.toThrow("caller cancel");
    expect(router.signals[0]).not.toBe(own.signal);
  });

  it("passes the step's own signal through unchanged when there is no stop signal", async () => {
    const router = hangingRouter();
    const own = new AbortController();
    const orch = new WorkflowOrchestrator({
      workflowId: "wf",
      router,
      store: new InMemoryCheckpointStore(),
    });
    const running = orch.runStep("research", { ...step(), signal: own.signal });
    await new Promise((r) => setTimeout(r, 0));
    expect(router.signals[0]).toBe(own.signal);
    own.abort(new Error("x"));
    await expect(running).rejects.toThrow("x");
  });

  it("after a stop, no step is dispatched and no producer runs", async () => {
    const stop = new AbortController();
    const orch = new WorkflowOrchestrator({
      workflowId: "wf",
      router: hangingRouter(),
      store: new InMemoryCheckpointStore(),
      stopSignal: stop.signal,
    });
    stop.abort(new EmergencyStopError());
    const s = step();
    await expect(orch.runStep("write", s)).rejects.toBeInstanceOf(EmergencyStopError);
    expect(s.dispatch).not.toHaveBeenCalled();
    const produce = vi.fn().mockResolvedValue({ ok: true });
    await expect(orch.memoize("phase", produce)).rejects.toBeInstanceOf(EmergencyStopError);
    expect(produce).not.toHaveBeenCalled();
  });

  it("a stop while a memoized producer runs rejects at once; its late value is not checkpointed", async () => {
    const stop = new AbortController();
    const store = new InMemoryCheckpointStore();
    const orch = new WorkflowOrchestrator({
      workflowId: "wf",
      router: hangingRouter(),
      store,
      stopSignal: stop.signal,
    });
    let finish!: (v: string) => void;
    const running = orch.memoize("phase", () => new Promise<string>((r) => (finish = r)));
    await new Promise((r) => setTimeout(r, 0));
    stop.abort(new EmergencyStopError());
    await expect(running).rejects.toBeInstanceOf(EmergencyStopError);
    finish("late");
    await new Promise((r) => setTimeout(r, 0));
    expect(await store.load("wf")).toBeNull();
  });

  it("a producer that fails after a stop does not raise an unhandled rejection", async () => {
    const stop = new AbortController();
    const orch = new WorkflowOrchestrator({
      workflowId: "wf",
      router: hangingRouter(),
      store: new InMemoryCheckpointStore(),
      stopSignal: stop.signal,
    });
    let fail!: (e: Error) => void;
    const running = orch.memoize("phase", () => new Promise<string>((_r, j) => (fail = j)));
    await new Promise((r) => setTimeout(r, 0));
    stop.abort(new EmergencyStopError());
    await expect(running).rejects.toBeInstanceOf(EmergencyStopError);
    fail(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 0));
  });

  it("a memoized producer that fails before any stop rejects with its own error", async () => {
    const orch = new WorkflowOrchestrator({
      workflowId: "wf",
      router: hangingRouter(),
      store: new InMemoryCheckpointStore(),
      stopSignal: new AbortController().signal,
    });
    await expect(
      orch.memoize("phase", () => Promise.reject(new Error("phase failed"))),
    ).rejects.toThrow("phase failed");
  });

  it("a producer that triggers the stop synchronously still ends the step at once", async () => {
    const stop = new AbortController();
    const store = new InMemoryCheckpointStore();
    const orch = new WorkflowOrchestrator({
      workflowId: "wf",
      router: hangingRouter(),
      store,
      stopSignal: stop.signal,
    });
    const running = orch.memoize("phase", () => {
      stop.abort(new EmergencyStopError());
      return new Promise<string>(() => undefined); // never settles on its own
    });
    await expect(running).rejects.toBeInstanceOf(EmergencyStopError);
    expect(await store.load("wf")).toBeNull();
  });

  it("a memoized producer that finishes before any stop is unchanged", async () => {
    const stop = new AbortController();
    const orch = new WorkflowOrchestrator({
      workflowId: "wf",
      router: hangingRouter(),
      store: new InMemoryCheckpointStore(),
      stopSignal: stop.signal,
    });
    await expect(orch.memoize("phase", async () => 7)).resolves.toBe(7);
  });

  it("checkpointed steps still replay after a stop (they cost nothing)", async () => {
    const store = new InMemoryCheckpointStore();
    await store.save("wf", { research: { taskId: "t0", result: "cached" } });
    const stop = new AbortController();
    stop.abort(new EmergencyStopError());
    const orch = new WorkflowOrchestrator({
      workflowId: "wf",
      router: hangingRouter(),
      store,
      stopSignal: stop.signal,
    });
    await expect(orch.runStep("research", step())).resolves.toBe("cached");
  });
});
