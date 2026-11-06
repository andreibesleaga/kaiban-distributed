/**
 * Invariant I4 — workers never set the global `teamWorkflowStatus`.
 * Only the orchestrator owns it; a worker heartbeat must never overwrite a
 * terminal FINISHED/STOPPED state on the board.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentStatePublisher } from "../../../src/adapters/state/agent-state-publisher";

const mockPublish = vi.fn().mockResolvedValue(1);
const mockQuit = vi.fn().mockResolvedValue("OK");

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { publish: mockPublish, quit: mockQuit };
  }),
}));

const agentInfo = { agentId: "worker-i4", name: "Worker", role: "Worker" };
const payload = { taskId: "t-i4", agentId: "worker-i4", timestamp: 0, data: {} };

function publishedDeltas(): Array<Record<string, unknown>> {
  return (mockPublish.mock.calls as Array<[string, string]>).map(
    ([, message]) => JSON.parse(message) as Record<string, unknown>,
  );
}

describe("AgentStatePublisher — I4: never sets teamWorkflowStatus", () => {
  let publisher: AgentStatePublisher;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    publisher = new AgentStatePublisher("redis://localhost:6379", agentInfo);
  });

  afterEach(async () => {
    await publisher.disconnect().catch(() => {});
    vi.useRealTimers();
  });

  it("omits it from idle, heartbeat, success and failure deltas", async () => {
    publisher.publishIdle(1000);
    await publisher.wrapHandler(vi.fn().mockResolvedValue("ok"))(payload);
    await expect(
      publisher.wrapHandler(vi.fn().mockRejectedValue(new Error("boom")))(payload),
    ).rejects.toThrow("boom");
    vi.advanceTimersByTime(1001); // heartbeat

    const deltas = publishedDeltas();
    expect(deltas.length).toBeGreaterThanOrEqual(5);
    // both outcomes were published, so the loop below covers success and failure
    const statuses = deltas.flatMap((d) =>
      ((d["agents"] ?? []) as Array<{ status: string }>).map((a) => a.status),
    );
    expect(statuses).toEqual(expect.arrayContaining(["IDLE", "EXECUTING", "ERROR"]));
    for (const delta of deltas) {
      expect(delta).not.toHaveProperty("teamWorkflowStatus");
    }
  });
});
