import { describe, it, expect, vi, beforeEach } from "vitest";
import { OrchestratorStatePublisher } from "../../../src/shared";

const mockPublish = vi.fn().mockResolvedValue(1);
const mockQuit = vi.fn().mockResolvedValue("OK");
const mockDel = vi.fn().mockResolvedValue(1);

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { publish: mockPublish, quit: mockQuit, del: mockDel };
  }),
}));

// channel-signing uses wrapSigned which depends on CHANNEL_SIGNING_SECRET;
// without it, it returns plain JSON — that's fine for these tests.

describe("OrchestratorStatePublisher", () => {
  let publisher: OrchestratorStatePublisher;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["CHANNEL_SIGNING_SECRET"];
    publisher = new OrchestratorStatePublisher("redis://localhost:6379");
  });

  it("publish() sends an event to the kaiban-state-events channel", () => {
    publisher.publish({ teamWorkflowStatus: "RUNNING" });
    expect(mockPublish).toHaveBeenCalledWith(
      "kaiban-state-events",
      expect.stringContaining('"teamWorkflowStatus":"RUNNING"'),
    );
  });

  it("taskQueued() publishes a task in TODO status", () => {
    publisher.taskQueued("task-1", "Research topic", "researcher");
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as {
      tasks: Array<{
        taskId: string;
        status: string;
        assignedToAgentId: string;
      }>;
    };
    expect(msg.tasks[0]).toMatchObject({
      taskId: "task-1",
      status: "TODO",
      assignedToAgentId: "researcher",
    });
  });

  it("taskQueued() truncates title to 60 characters", () => {
    const longTitle = "A".repeat(100);
    publisher.taskQueued("task-1", longTitle, "agent");
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as {
      tasks: Array<{ title: string }>;
    };
    expect(msg.tasks[0]!.title).toHaveLength(60);
  });

  it("taskDone() publishes a task in DONE status", () => {
    publisher.taskDone("task-2", "writer");
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as {
      tasks: Array<{
        taskId: string;
        status: string;
        assignedToAgentId: string;
      }>;
    };
    expect(msg.tasks[0]).toMatchObject({
      taskId: "task-2",
      status: "DONE",
      assignedToAgentId: "writer",
    });
  });

  it("taskFailed() publishes agent with ERROR status and task with BLOCKED status", () => {
    publisher.taskFailed("task-3", "editor", "Editorial Review", "LLM timeout");
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as {
      agents: Array<{ status: string; agentId: string }>;
      tasks: Array<{ status: string; taskId: string; result: string }>;
    };
    expect(msg.agents[0]).toMatchObject({ agentId: "editor", status: "ERROR" });
    expect(msg.tasks[0]).toMatchObject({
      taskId: "task-3",
      status: "BLOCKED",
    });
    expect(msg.tasks[0]!.result).toContain("ERROR: LLM timeout");
  });

  it("taskFailed() truncates error message to 200 chars in result", () => {
    const longError = "E".repeat(300);
    publisher.taskFailed("t", "a", "title", longError);
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as {
      tasks: Array<{ result: string }>;
    };
    // "ERROR: " prefix + 200 chars of error
    expect(msg.tasks[0]!.result).toHaveLength("ERROR: ".length + 200);
  });

  it("publishMetadata() sends metadata delta to the channel", () => {
    publisher.publishMetadata({ totalTokens: 500, estimatedCost: 0.01 });
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as {
      metadata: { totalTokens: number; estimatedCost: number };
    };
    expect(msg.metadata).toEqual({ totalTokens: 500, estimatedCost: 0.01 });
  });

  it("disconnect() calls redis.quit()", async () => {
    await publisher.disconnect();
    expect(mockQuit).toHaveBeenCalled();
  });

  it("logs error to console.error when publish() rejects", async () => {
    mockPublish.mockRejectedValueOnce(new Error("Redis disconnected"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    publisher.publish({ teamWorkflowStatus: "RUNNING" });
    // Let the .catch() microtask run
    await Promise.resolve();
    await Promise.resolve();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Publish failed"),
      expect.any(Error),
    );
    errSpy.mockRestore();
  });
});
