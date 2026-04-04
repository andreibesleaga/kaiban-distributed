import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ResearchStatePublisher,
  buildSwarmAgents,
  extractSearchResults,
} from "../../../examples/global-research/state-publisher";
import type { ResearchContext } from "../../../examples/global-research/types";

const mockPublish = vi.fn().mockResolvedValue(1);
const mockQuit = vi.fn().mockResolvedValue("OK");
const mockDel = vi.fn().mockResolvedValue(1);

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { publish: mockPublish, quit: mockQuit, del: mockDel };
  }),
}));

// ── pure helpers ──────────────────────────────────────────────────────────────

describe("buildSwarmAgents()", () => {
  it("returns 3 fixed agents when numSearchers=0", () => {
    const agents = buildSwarmAgents(0);
    expect(agents).toHaveLength(3);
    const ids = agents.map((a) => a.agentId);
    expect(ids).toContain("writer");
    expect(ids).toContain("reviewer");
    expect(ids).toContain("editor");
  });

  it("prepends numSearchers dynamic agents", () => {
    const agents = buildSwarmAgents(3);
    expect(agents).toHaveLength(6);
    expect(agents[0]!.agentId).toBe("searcher-0");
    expect(agents[1]!.agentId).toBe("searcher-1");
    expect(agents[2]!.agentId).toBe("searcher-2");
  });

  it("all agents have status IDLE and null currentTaskId", () => {
    buildSwarmAgents(2).forEach((a) => {
      expect(a.status).toBe("IDLE");
      expect(a.currentTaskId).toBeNull();
    });
  });
});

describe("extractSearchResults()", () => {
  it("returns a structured object with required fields", () => {
    const result = extractSearchResults(
      "Some output text",
      "searcher-0",
      "AI trends",
    );
    expect(result.agentId).toBe("searcher-0");
    expect(result.title).toBe("AI trends");
    expect(result.snippet).toBe("Some output text");
    expect(result.sourceUrl).toMatch(/^research:\/\/searcher-0\//);
    expect(result.relevanceScore).toBeGreaterThanOrEqual(0.85);
    expect(result.relevanceScore).toBeLessThanOrEqual(1.0);
    expect(result.timestamp).toBeTruthy();
  });

  it("truncates title to 80 chars and snippet to 500 chars", () => {
    const longTitle = "x".repeat(200);
    const longOutput = "y".repeat(800);
    const result = extractSearchResults(longOutput, "searcher-1", longTitle);
    expect(result.title.length).toBe(80);
    expect(result.snippet.length).toBe(500);
  });
});

// ── ResearchStatePublisher methods ────────────────────────────────────────────

function makeCtx(overrides: Partial<ResearchContext> = {}): ResearchContext {
  return {
    id: "ctx-1",
    originalQuery: "AI safety",
    status: "INITIALIZED",
    rawSearchData: [],
    editorApproval: false,
    metadata: {
      totalTokens: 1000,
      estimatedCost: 0.05,
      startTime: Date.now() - 5000,
      activeNodes: [],
    },
    ...overrides,
  };
}

describe("ResearchStatePublisher", () => {
  let pub: ResearchStatePublisher;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["CHANNEL_SIGNING_SECRET"];
    pub = new ResearchStatePublisher("redis://localhost:6379");
  });

  it("workflowStarted() calls redis.del and publishes RUNNING", () => {
    pub.workflowStarted(2);
    expect(mockDel).toHaveBeenCalledWith("kaiban:searcher:reg");
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    expect(msg["teamWorkflowStatus"]).toBe("RUNNING");
    const agents = msg["agents"] as Array<{ agentId: string }>;
    expect(agents.some((a) => a.agentId === "searcher-0")).toBe(true);
  });

  it("searchingPhase() publishes DOING tasks for each taskId", () => {
    pub.searchingPhase(["t1", "t2"]);
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    const tasks = msg["tasks"] as Array<{ taskId: string; status: string }>;
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.status).toBe("DOING");
    expect(tasks[0]!.taskId).toBe("t1");
  });

  it("searchPhaseComplete() maps error to BLOCKED and success to DONE", () => {
    pub.searchPhaseComplete([
      { taskId: "t1", result: "ok" },
      { taskId: "t2", error: "timeout" },
    ]);
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    const tasks = msg["tasks"] as Array<{ taskId: string; status: string }>;
    expect(tasks.find((t) => t.taskId === "t1")!.status).toBe("DONE");
    expect(tasks.find((t) => t.taskId === "t2")!.status).toBe("BLOCKED");
  });

  it("aggregatingPhase() publishes DOING task for writer", () => {
    pub.aggregatingPhase("write-1", 5);
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    const tasks = msg["tasks"] as Array<{
      taskId: string;
      status: string;
      assignedToAgentId: string;
    }>;
    expect(tasks[0]!.taskId).toBe("write-1");
    expect(tasks[0]!.status).toBe("DOING");
    expect(tasks[0]!.assignedToAgentId).toBe("writer");
  });

  it("reviewingPhase() publishes DOING task for reviewer", () => {
    pub.reviewingPhase("review-1");
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    const tasks = msg["tasks"] as Array<{
      assignedToAgentId: string;
      status: string;
    }>;
    expect(tasks[0]!.assignedToAgentId).toBe("reviewer");
    expect(tasks[0]!.status).toBe("DOING");
  });

  it("awaitingHITL() publishes AWAITING_VALIDATION task for editor", () => {
    pub.awaitingHITL("edit-1", "CONDITIONAL", "7/10");
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    const tasks = msg["tasks"] as Array<{
      status: string;
      result: string;
      assignedToAgentId: string;
    }>;
    expect(tasks[0]!.status).toBe("AWAITING_VALIDATION");
    expect(tasks[0]!.result).toContain("CONDITIONAL");
    expect(tasks[0]!.result).toContain("7/10");
    expect(tasks[0]!.assignedToAgentId).toBe("editor");
  });

  it("workflowFinished() publishes FINISHED with DONE edit task", () => {
    const ctx = makeCtx({ originalQuery: "AI safety" });
    pub.workflowFinished(ctx, "edit-task");
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    expect(msg["teamWorkflowStatus"]).toBe("FINISHED");
    const tasks = msg["tasks"] as Array<{ taskId: string; status: string }>;
    expect(tasks[0]!.taskId).toBe("edit-task");
    expect(tasks[0]!.status).toBe("DONE");
  });

  it("workflowStopped() without ctx publishes STOPPED with BLOCKED task", () => {
    pub.workflowStopped("task-1", "Rejected");
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    expect(msg["teamWorkflowStatus"]).toBe("STOPPED");
    const tasks = msg["tasks"] as Array<{ taskId: string; status: string }>;
    expect(tasks[0]!.status).toBe("BLOCKED");
    expect(msg["metadata"]).toBeUndefined();
  });

  it("workflowStopped() with ctx includes metadata", () => {
    const ctx = makeCtx();
    pub.workflowStopped("task-1", "reason", ctx);
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    expect(msg["metadata"]).toBeDefined();
    const meta = msg["metadata"] as { totalTokens: number };
    expect(meta.totalTokens).toBe(1000);
  });
});
