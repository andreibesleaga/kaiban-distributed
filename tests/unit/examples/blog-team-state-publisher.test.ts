import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BlogStatePublisher,
  BLOG_AGENTS,
} from "../../../examples/blog-team/state-publisher";

const mockPublish = vi.fn().mockResolvedValue(1);
const mockQuit = vi.fn().mockResolvedValue("OK");

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { publish: mockPublish, quit: mockQuit };
  }),
}));

describe("blog-team BlogStatePublisher", () => {
  let pub: BlogStatePublisher;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["CHANNEL_SIGNING_SECRET"];
    pub = new BlogStatePublisher("redis://localhost:6379");
  });

  it("workflowStarted() publishes RUNNING status with topic and agents", () => {
    pub.workflowStarted("AI Trends 2025");
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    expect(msg["teamWorkflowStatus"]).toBe("RUNNING");
    expect(msg["inputs"]).toEqual({ topic: "AI Trends 2025" });
    expect(msg["agents"]).toBeDefined();
  });

  it("awaitingHITL() publishes AWAITING_VALIDATION task status", () => {
    pub.awaitingHITL("task-edit", "Editorial Review", "PUBLISH", "8/10");
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    expect(msg["teamWorkflowStatus"]).toBe("RUNNING");
    const tasks = msg["tasks"] as Array<{ status: string; result: string }>;
    expect(tasks[0]!.status).toBe("AWAITING_VALIDATION");
    expect(tasks[0]!.result).toContain("PUBLISH");
    expect(tasks[0]!.result).toContain("8/10");
  });

  it("workflowFinished() without editTaskId publishes FINISHED with single task", () => {
    pub.workflowFinished("write-task", "AI topic", 500, 0.01);
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    expect(msg["teamWorkflowStatus"]).toBe("FINISHED");
    expect((msg["tasks"] as unknown[]).length).toBe(1);
  });

  it("workflowFinished() with editTaskId includes editorial task in DONE status", () => {
    pub.workflowFinished("write-task", "topic", 500, 0.01, "edit-task");
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    const tasks = msg["tasks"] as Array<{ taskId: string; status: string }>;
    expect(tasks.length).toBe(2);
    const editEntry = tasks.find((t) => t.taskId === "edit-task");
    expect(editEntry?.status).toBe("DONE");
  });

  it("workflowStopped() without editTaskId publishes STOPPED with single task", () => {
    pub.workflowStopped("task-id", "Rejected by reviewer", 200, 0.005);
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    expect(msg["teamWorkflowStatus"]).toBe("STOPPED");
    expect((msg["tasks"] as unknown[]).length).toBe(1);
  });

  it("workflowStopped() with different editTaskId includes it as BLOCKED", () => {
    pub.workflowStopped("task-id", "reason", 200, 0.005, "different-edit-task");
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    const tasks = msg["tasks"] as Array<{ taskId: string; status: string }>;
    expect(tasks.length).toBe(2);
    const editEntry = tasks.find((t) => t.taskId === "different-edit-task");
    expect(editEntry?.status).toBe("BLOCKED");
  });

  it("workflowStopped() does NOT add editTaskId when it equals taskId", () => {
    pub.workflowStopped("same-task", "reason", 200, 0.005, "same-task");
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    expect((msg["tasks"] as unknown[]).length).toBe(1);
  });

  it("BLOG_AGENTS export contains researcher, writer and editor", () => {
    const ids = BLOG_AGENTS.map((a) => a.agentId);
    expect(ids).toContain("researcher");
    expect(ids).toContain("writer");
    expect(ids).toContain("editor");
  });
});
