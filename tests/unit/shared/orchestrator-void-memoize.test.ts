/**
 * WorkflowOrchestrator.memoize — a void step (WF-05): `JSON.stringify(undefined)`
 * is `undefined`, which used to make the resume (and a second memoize of the same
 * name in one instance) throw `SyntaxError: "undefined" is not valid JSON`.
 */
import { describe, it, expect, vi } from "vitest";
import {
  WorkflowOrchestrator,
  InMemoryCheckpointStore,
  type RouterLike,
} from "../../../src/shared/orchestrator";

const router: RouterLike = { wait: vi.fn() };

describe("WorkflowOrchestrator.memoize — a producer returning undefined", () => {
  it("resumes from another instance without re-running the producer", async () => {
    const store = new InMemoryCheckpointStore();
    const first = new WorkflowOrchestrator({ workflowId: "wf", router, store });
    const produce = vi.fn().mockResolvedValue(undefined);
    await first.memoize("notify", produce);

    const second = new WorkflowOrchestrator({ workflowId: "wf", router, store });
    await expect(second.memoize("notify", produce)).resolves.toBeNull();
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("a second memoize of the same name in one instance replays instead of throwing", async () => {
    const orch = new WorkflowOrchestrator({
      workflowId: "wf2", router, store: new InMemoryCheckpointStore(),
    });
    const produce = vi.fn().mockResolvedValue(undefined);
    await orch.memoize("notify", produce);
    await expect(orch.memoize("notify", produce)).resolves.toBeNull();
    expect(produce).toHaveBeenCalledTimes(1);
  });
});
