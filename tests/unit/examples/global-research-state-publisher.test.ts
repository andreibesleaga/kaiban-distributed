import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ResearchStatePublisher,
  buildSwarmAgents,
  extractSearchResults,
  MAX_SEARCH_RESULT_CHARS,
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
  it("returns a structured object; nothing is invented (WF-V-02)", () => {
    const result = extractSearchResults("Some output text", "search-1", "AI trends");
    expect(result.agentId).toBe("search-1");
    expect(result.title).toBe("AI trends");
    expect(result.snippet).toBe("Some output text");
    expect(result).not.toHaveProperty("sourceUrl");
    expect(result).not.toHaveProperty("relevanceScore");
    expect(result.timestamp).toBeTruthy();
  });

  it("takes sourceUrl from the first URL the answer names", () => {
    const result = extractSearchResults(
      "Finding. Sources: (https://example.com/a), https://example.org/b",
      "search-1",
      "t",
    );
    expect(result.sourceUrl).toBe("https://example.com/a");
  });

  it("truncates the title to 80 chars; the answer is kept whole up to the 20 000-char bound, sources at the end included", () => {
    const longTitle = "x".repeat(200);
    const answer = "y".repeat(3000) + " Sources: https://example.com/late";
    const result = extractSearchResults(answer, "search-1", longTitle);
    expect(result.title.length).toBe(80);
    expect(result.snippet).toBe(answer);
    expect(extractSearchResults("z".repeat(25_000), "a", "t").snippet.length).toBe(MAX_SEARCH_RESULT_CHARS);
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

  it("workflowStarted() publishes RUNNING and does NOT reset the searcher id counter (WF-10)", () => {
    pub.workflowStarted(2);
    // The searchers registered before the run; deleting the counter would hand a
    // restarted searcher the id of a live one.
    expect(mockDel).not.toHaveBeenCalled();
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

  it("searchPhaseComplete() maps error to BLOCKED and success to DONE, without touching the assignee", () => {
    pub.searchPhaseComplete([
      { taskId: "t1", result: "ok" },
      { taskId: "t2", error: "timeout" },
    ]);
    const msg = JSON.parse(mockPublish.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    const tasks = msg["tasks"] as Array<{ taskId: string; status: string; result?: string }>;
    expect(tasks.find((t) => t.taskId === "t1")!.status).toBe("DONE");
    expect(tasks.find((t) => t.taskId === "t2")!.status).toBe("BLOCKED");
    expect(tasks.find((t) => t.taskId === "t2")!.result).toBe("Failed: timeout");
    // The replica that ran the task published itself as the assignee (WF-V-05).
    for (const t of tasks) expect(t).not.toHaveProperty("assignedToAgentId");
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
    // WF-12: the card carries the editor's verdict, not a "Governance" label.
    expect(tasks[0]!.result).toBe("Editorial: CONDITIONAL | Accuracy: 7/10 — Awaiting human decision");
    expect(tasks[0]!.result).not.toContain("Governance");
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

describe("global-research ResearchStatePublisher — emergency STOP ALL (ADR-025)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reviewStopped(reason) closes the pending card with that reason (WF-11), default keeps the emergency text", () => {
    const pub = new ResearchStatePublisher("redis://localhost:6379");
    pub.awaitingHITL("edit-1", "REVISE", "6/10");
    pub.reviewStopped("Budget guard stopped the run: no decision was taken");
    const msg = JSON.parse(mockPublish.mock.calls.at(-1)![1] as string) as { tasks: Array<{ result: string }> };
    expect(msg.tasks[0]!.result).toBe("Budget guard stopped the run: no decision was taken");
    pub.awaitingHITL("edit-2", "REVISE", "6/10");
    pub.reviewStopped();
    const msg2 = JSON.parse(mockPublish.mock.calls.at(-1)![1] as string) as { tasks: Array<{ result: string }> };
    expect(msg2.tasks[0]!.result).toBe("Emergency stop: no decision was taken");
  });

  it("reviewStopped() marks the pending review task STOPPED, once; nothing when none is pending", () => {
    const pub = new ResearchStatePublisher("redis://localhost:6379");
    pub.reviewStopped();
    expect(mockPublish).not.toHaveBeenCalled();
    pub.awaitingHITL("edit-9", "PUBLISH", "9/10");
    pub.reviewStopped();
    const msg = JSON.parse(mockPublish.mock.calls.at(-1)![1] as string) as Record<string, unknown>;
    expect(msg["tasks"]).toEqual([
      expect.objectContaining({ taskId: "edit-9", status: "STOPPED", assignedToAgentId: "editor" }),
    ]);
    const calls = mockPublish.mock.calls.length;
    pub.reviewStopped();
    expect(mockPublish.mock.calls.length).toBe(calls);
  });
});
