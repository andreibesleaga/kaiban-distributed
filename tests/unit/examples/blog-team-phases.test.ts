import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runResearchPhase,
  runWritePhase,
  runEditorialPhase,
  runBlogRevision,
  handleBlogDecision,
  RESEARCH_WAIT_MS,
  WRITE_WAIT_MS,
  EDIT_WAIT_MS,
} from "../../../examples/blog-team/phases";

// ── mock waitForHITLDecision from shared ─────────────────────────────────────
const { mockWaitForHITL } = vi.hoisted(() => ({ mockWaitForHITL: vi.fn() }));
vi.mock("../../../src/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/shared")>();
  return { ...actual, waitForHITLDecision: mockWaitForHITL };
});

// ── helpers to build mock deps ────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function makeMocks() {
  const mockRpc = { call: vi.fn(), setToken: vi.fn() };
  const mockRouter = { wait: vi.fn(), waitAll: vi.fn(), clearPending: vi.fn() };
  const mockPub = {
    taskQueued: vi.fn(),
    taskFailed: vi.fn(),
    taskDone: vi.fn(),
    publishMetadata: vi.fn(),
    awaitingHITL: vi.fn(),
    workflowFinished: vi.fn(),
    workflowStopped: vi.fn(),
    publish: vi.fn(),
  };
  let _totalTokens = 0;
  let _totalCost = 0;
  const mockRunLog = {
    logTask: vi.fn().mockImplementation(
      (
        _phase: string,
        _taskId: string,
        _agentId: string,
        data: {
          inputTokens?: number;
          outputTokens?: number;
          estimatedCost?: number;
        },
      ) => {
        _totalTokens += (data.inputTokens ?? 0) + (data.outputTokens ?? 0);
        _totalCost += data.estimatedCost ?? 0;
      },
    ),
    logError: vi.fn(),
    finish: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    get totals() {
      return { totalTokens: _totalTokens, totalCost: _totalCost };
    },
  };
  return { mockRpc, mockRouter, mockPub, mockRunLog };
}

function parsedResult(answer = "Result text"): string {
  return JSON.stringify({
    answer,
    inputTokens: 50,
    outputTokens: 100,
    estimatedCost: 0.002,
  });
}

// ── exported constants ────────────────────────────────────────────────────────

describe("phase wait constants", () => {
  it("RESEARCH_WAIT_MS is a positive number", () => {
    expect(RESEARCH_WAIT_MS).toBeGreaterThan(0);
  });
  it("WRITE_WAIT_MS is a positive number", () => {
    expect(WRITE_WAIT_MS).toBeGreaterThan(0);
  });
  it("EDIT_WAIT_MS is a positive number", () => {
    expect(EDIT_WAIT_MS).toBeGreaterThan(0);
  });
});

// ── runResearchPhase ─────────────────────────────────────────────────────────

describe("runResearchPhase()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls rpc.call to create task and returns summary", async () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRpc.call.mockResolvedValue({ taskId: "research-1" });
    mockRouter.wait.mockResolvedValue(parsedResult("Research summary"));

    const result = await runResearchPhase(
      "AI topic",
      mockRouter as never,
      mockPub as never,
      mockRpc as never,
      mockRunLog as never,
    );

    expect(mockRpc.call).toHaveBeenCalledWith(
      "tasks.create",
      expect.objectContaining({ agentId: "researcher" }),
    );
    expect(mockPub.taskQueued).toHaveBeenCalledWith(
      "research-1",
      expect.any(String),
      "researcher",
    );
    expect(result.taskId).toBe("research-1");
    expect(result.summary).toBe("Research summary");
  });

  it("calls taskFailed and rethrows when router.wait rejects", async () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRpc.call.mockResolvedValue({ taskId: "research-1" });
    mockRouter.wait.mockRejectedValue(new Error("timeout"));

    await expect(
      runResearchPhase(
        "topic",
        mockRouter as never,
        mockPub as never,
        mockRpc as never,
        mockRunLog as never,
      ),
    ).rejects.toThrow("timeout");
    expect(mockPub.taskFailed).toHaveBeenCalledWith(
      "research-1",
      "researcher",
      expect.any(String),
      "timeout",
    );
  });
});

// ── runWritePhase ─────────────────────────────────────────────────────────────

describe("runWritePhase()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates writer task and returns draft", async () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRpc.call.mockResolvedValue({ taskId: "write-1" });
    mockRouter.wait.mockResolvedValue(parsedResult("Draft content"));

    const result = await runWritePhase(
      "topic",
      "research summary",
      mockRouter as never,
      mockPub as never,
      mockRpc as never,
      mockRunLog as never,
    );

    expect(mockRpc.call).toHaveBeenCalledWith(
      "tasks.create",
      expect.objectContaining({ agentId: "writer" }),
    );
    expect(result.taskId).toBe("write-1");
    expect(result.draft).toBe("Draft content");
  });

  it("calls taskFailed on writer error", async () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRpc.call.mockResolvedValue({ taskId: "write-1" });
    mockRouter.wait.mockRejectedValue(new Error("write error"));

    await expect(
      runWritePhase(
        "topic",
        "summary",
        mockRouter as never,
        mockPub as never,
        mockRpc as never,
        mockRunLog as never,
      ),
    ).rejects.toThrow("write error");
    expect(mockPub.taskFailed).toHaveBeenCalled();
  });
});

// ── runEditorialPhase ─────────────────────────────────────────────────────────

describe("runEditorialPhase()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates editor task and returns recommendation and score", async () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRpc.call.mockResolvedValue({ taskId: "edit-1" });
    mockRouter.wait.mockResolvedValue(
      parsedResult(
        "Recommendation: PUBLISH\nAccuracy Score: 9/10\nDetails here",
      ),
    );

    const result = await runEditorialPhase(
      "topic",
      "research",
      "draft",
      mockRouter as never,
      mockPub as never,
      mockRpc as never,
      mockRunLog as never,
    );

    expect(mockRpc.call).toHaveBeenCalledWith(
      "tasks.create",
      expect.objectContaining({ agentId: "editor" }),
    );
    expect(result.taskId).toBe("edit-1");
    expect(result.recommendation).toBe("PUBLISH");
  });

  it("calls taskFailed on editorial error", async () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRpc.call.mockResolvedValue({ taskId: "edit-1" });
    mockRouter.wait.mockRejectedValue(new Error("edit error"));

    await expect(
      runEditorialPhase(
        "topic",
        "research",
        "draft",
        mockRouter as never,
        mockPub as never,
        mockRpc as never,
        mockRunLog as never,
      ),
    ).rejects.toThrow("edit error");
    expect(mockPub.taskFailed).toHaveBeenCalled();
  });
});

// ── runBlogRevision ───────────────────────────────────────────────────────────

describe("runBlogRevision()", () => {
  beforeEach(() => vi.clearAllMocks());

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const baseRevDeps = () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    return {
      deps: {
        topic: "topic",
        redisUrl: "redis://localhost:6379",
        editTaskId: "edit-1",
        editorialReview: "review",
        blogDraft: "draft",
        researchSummary: "summary",
        router: mockRouter as never,
        pub: mockPub as never,
        rpc: mockRpc as never,
        rl: { question: vi.fn(), write: vi.fn(), close: vi.fn() } as never,
        runLog: mockRunLog as never,
        totalTokens: 100,
        totalCost: 0.001,
      },
      mockRpc,
      mockRouter,
      mockPub,
      mockRunLog,
    };
  };

  it("returns PUBLISHED when HITL decision is PUBLISH", async () => {
    const { deps, mockRpc, mockRouter, mockPub } = baseRevDeps();
    mockRpc.call.mockResolvedValue({ taskId: "rev-1" });
    mockRouter.wait.mockResolvedValue(parsedResult("Revised draft"));
    mockWaitForHITL.mockResolvedValue("PUBLISH");

    const outcome = await runBlogRevision(deps);
    expect(outcome).toBe("PUBLISHED");
    expect(mockPub.workflowFinished).toHaveBeenCalled();
  });

  it("returns STOPPED when HITL decision is not PUBLISH", async () => {
    const { deps, mockRpc, mockRouter, mockPub } = baseRevDeps();
    mockRpc.call.mockResolvedValue({ taskId: "rev-1" });
    mockRouter.wait.mockResolvedValue(parsedResult("Revised draft"));
    mockWaitForHITL.mockResolvedValue("REJECT");

    const outcome = await runBlogRevision(deps);
    expect(outcome).toBe("STOPPED");
    expect(mockPub.workflowStopped).toHaveBeenCalled();
  });
});

// ── handleBlogDecision ───────────────────────────────────────────────────────

describe("handleBlogDecision()", () => {
  beforeEach(() => vi.clearAllMocks());

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const baseDecisionDeps = () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    return {
      deps: {
        topic: "topic",
        redisUrl: "redis://localhost:6379",
        gatewayUrl: "http://localhost:4000",
        research: {
          taskId: "research-1",
          summary: "summary",
          tokens: 100,
          cost: 0.001,
        },
        write: {
          taskId: "write-1",
          draft: "draft text",
          tokens: 200,
          cost: 0.002,
        },
        edit: {
          taskId: "edit-1",
          review: "review text\nRationale\nBecause reasons",
          recommendation: "PUBLISH",
          score: "9/10",
          tokens: 150,
          cost: 0.0015,
        },
        router: mockRouter as never,
        pub: mockPub as never,
        rpc: mockRpc as never,
        rl: { question: vi.fn(), write: vi.fn(), close: vi.fn() } as never,
        runLog: mockRunLog as never,
      },
      mockRpc,
      mockRouter,
      mockPub,
      mockRunLog,
    };
  };

  it("PUBLISH decision calls workflowFinished and runLog.finish('PUBLISHED')", async () => {
    const { deps, mockPub, mockRunLog } = baseDecisionDeps();
    mockWaitForHITL.mockResolvedValue("PUBLISH");

    await handleBlogDecision(deps);

    expect(mockPub.workflowFinished).toHaveBeenCalledWith(
      "write-1",
      "topic",
      expect.any(Number),
      expect.any(Number),
      "edit-1",
    );
    expect(mockRunLog.finish).toHaveBeenCalledWith("PUBLISHED");
  });

  it("REVISE decision calls runBlogRevision (rpc creates revision task)", async () => {
    const { deps, mockRpc, mockRouter, mockRunLog } = baseDecisionDeps();
    mockWaitForHITL
      .mockResolvedValueOnce("REVISE") // first call — handleBlogDecision
      .mockResolvedValueOnce("PUBLISH"); // second call — runBlogRevision
    mockRpc.call.mockResolvedValue({ taskId: "rev-1" });
    mockRouter.wait.mockResolvedValue(parsedResult("revised"));

    await handleBlogDecision(deps);

    expect(mockRpc.call).toHaveBeenCalledWith(
      "tasks.create",
      expect.objectContaining({ agentId: "writer" }),
    );
    expect(mockRunLog.finish).toHaveBeenCalledWith("REVISED");
  });

  it("REJECT decision with Rationale section extracts rationale", async () => {
    const { deps, mockPub, mockRunLog } = baseDecisionDeps();
    mockWaitForHITL.mockResolvedValue("REJECT");

    await handleBlogDecision(deps);

    expect(mockPub.workflowStopped).toHaveBeenCalledWith(
      "edit-1",
      "Because reasons",
      expect.any(Number),
      expect.any(Number),
      "edit-1",
    );
    expect(mockRunLog.finish).toHaveBeenCalledWith("REJECTED");
  });

  it("REJECT decision without Rationale section uses fallback text", async () => {
    const { deps, mockPub } = baseDecisionDeps();
    deps.edit = { ...deps.edit, review: "No special section here" };
    mockWaitForHITL.mockResolvedValue("REJECT");

    await handleBlogDecision(deps);

    expect(mockPub.workflowStopped).toHaveBeenCalledWith(
      "edit-1",
      "Rejected by human reviewer",
      expect.any(Number),
      expect.any(Number),
      "edit-1",
    );
  });
});
