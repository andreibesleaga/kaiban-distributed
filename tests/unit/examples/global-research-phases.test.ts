import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildSubTopics,
  runSearchPhase,
  runWritePhase,
  runGovernancePhase,
  runEditorialPhase,
  runRevisionPhase,
  handleDecision,
} from "../../../examples/global-research/phases";
import type { ResearchContext } from "../../../examples/global-research/types";

// ── mock waitForHITLDecision ──────────────────────────────────────────────────
const { mockWaitForHITL } = vi.hoisted(() => ({ mockWaitForHITL: vi.fn() }));
vi.mock("../../../src/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/shared")>();
  return { ...actual, waitForHITLDecision: mockWaitForHITL };
});

// ── helpers ───────────────────────────────────────────────────────────────────
function makeCtx(overrides: Partial<ResearchContext> = {}): ResearchContext {
  return {
    id: "ctx-1",
    originalQuery: "AI safety",
    status: "INITIALIZED",
    rawSearchData: [],
    editorApproval: false,
    metadata: {
      totalTokens: 0,
      estimatedCost: 0,
      startTime: Date.now() - 1000,
      activeNodes: [],
    },
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function parsedResult(answer = "Result text") {
  return JSON.stringify({
    answer,
    inputTokens: 50,
    outputTokens: 100,
    estimatedCost: 0.002,
  });
}

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
    searchingPhase: vi.fn(),
    searchPhaseComplete: vi.fn(),
    aggregatingPhase: vi.fn(),
    reviewingPhase: vi.fn(),
    workflowStarted: vi.fn(),
  };
  let _totalTokens = 0;
  let _totalCost = 0;
  const mockRunLog = {
    logTask: vi.fn().mockImplementation(
      (
        _p: string,
        _t: string,
        _a: string,
        d: {
          inputTokens?: number;
          outputTokens?: number;
          estimatedCost?: number;
        },
      ) => {
        _totalTokens += (d.inputTokens ?? 0) + (d.outputTokens ?? 0);
        _totalCost += d.estimatedCost ?? 0;
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

// ── buildSubTopics ────────────────────────────────────────────────────────────

describe("buildSubTopics()", () => {
  it("returns n sub-topics for n <= 8", () => {
    expect(buildSubTopics("AI", 3)).toHaveLength(3);
    expect(buildSubTopics("AI", 8)).toHaveLength(8);
  });

  it("is capped at 8 even when n > 8", () => {
    expect(buildSubTopics("AI", 15)).toHaveLength(8);
  });

  it("includes the query in every sub-topic", () => {
    buildSubTopics("quantum computing", 4).forEach((t) =>
      expect(t).toContain("quantum computing"),
    );
  });
});

// ── runSearchPhase ────────────────────────────────────────────────────────────

describe("runSearchPhase()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fans out tasks and populates ctx.rawSearchData on success", async () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRpc.call.mockResolvedValue({ taskId: "search-1" });
    mockRouter.waitAll.mockResolvedValue([
      { taskId: "search-1", result: parsedResult("Found info") },
    ]);

    const ctx = makeCtx();
    await runSearchPhase(
      ctx,
      "AI",
      1,
      60000,
      mockRouter as never,
      mockPub as never,
      mockRpc as never,
      mockRunLog as never,
    );

    expect(ctx.rawSearchData).toHaveLength(1);
    expect(mockPub.searchingPhase).toHaveBeenCalled();
    expect(mockPub.searchPhaseComplete).toHaveBeenCalled();
  });

  it("logs errors for failed searcher results", async () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRpc.call.mockResolvedValue({ taskId: "s-1" });
    mockRouter.waitAll.mockResolvedValue([
      { taskId: "s-1", result: parsedResult("ok") },
      { taskId: "s-2", error: "timeout" },
    ]);

    const ctx = makeCtx();
    await runSearchPhase(
      ctx,
      "AI",
      2,
      60000,
      mockRouter as never,
      mockPub as never,
      mockRpc as never,
      mockRunLog as never,
    );

    expect(mockRunLog.logError).toHaveBeenCalledWith(
      "search",
      expect.any(String),
      expect.any(String),
      "timeout",
    );
    expect(ctx.rawSearchData).toHaveLength(1);
  });

  it("throws when all searchers fail", async () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRpc.call.mockResolvedValue({ taskId: "s-1" });
    mockRouter.waitAll.mockResolvedValue([{ taskId: "s-1", error: "failed" }]);

    const ctx = makeCtx();
    await expect(
      runSearchPhase(
        ctx,
        "AI",
        1,
        60000,
        mockRouter as never,
        mockPub as never,
        mockRpc as never,
        mockRunLog as never,
      ),
    ).rejects.toThrow("All searcher tasks failed");
  });
});

// ── runWritePhase ─────────────────────────────────────────────────────────────

describe("runWritePhase() (global-research)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates writer task and updates ctx.consolidatedDraft", async () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRpc.call.mockResolvedValue({ taskId: "write-1" });
    mockRouter.wait.mockResolvedValue(parsedResult("Consolidated report"));

    const ctx = makeCtx();
    await runWritePhase(
      ctx,
      "AI",
      120000,
      mockRouter as never,
      mockPub as never,
      mockRpc as never,
      mockRunLog as never,
    );

    expect(ctx.consolidatedDraft).toBe("Consolidated report");
    expect(mockPub.aggregatingPhase).toHaveBeenCalledWith("write-1", 0);
    expect(mockPub.taskDone).toHaveBeenCalledWith("write-1", "writer");
  });

  it("calls taskFailed and rethrows on error", async () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRpc.call.mockResolvedValue({ taskId: "write-1" });
    mockRouter.wait.mockRejectedValue(new Error("write err"));

    await expect(
      runWritePhase(
        makeCtx(),
        "AI",
        120000,
        mockRouter as never,
        mockPub as never,
        mockRpc as never,
        mockRunLog as never,
      ),
    ).rejects.toThrow("write err");
    expect(mockPub.taskFailed).toHaveBeenCalled();
  });
});

// ── runGovernancePhase ────────────────────────────────────────────────────────

describe("runGovernancePhase()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns APPROVED recommendation and populates ctx.feedback", async () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRpc.call.mockResolvedValue({ taskId: "rev-1" });
    mockRouter.wait.mockResolvedValue(
      parsedResult(
        "Recommendation: APPROVED\nCompliance Score: 9/10\nAll good",
      ),
    );

    const ctx = makeCtx({ consolidatedDraft: "draft text" });
    const gov = await runGovernancePhase(
      ctx,
      "AI",
      120000,
      mockRouter as never,
      mockPub as never,
      mockRpc as never,
      mockRunLog as never,
    );

    expect(gov.recommendation).toBe("APPROVED");
    expect(ctx.feedback).toBeDefined();
    expect(ctx.feedback!.isApproved).toBe(true);
  });

  it("returns REJECTED recommendation and sets isApproved=false", async () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRpc.call.mockResolvedValue({ taskId: "rev-1" });
    mockRouter.wait.mockResolvedValue(
      parsedResult("Recommendation: REJECTED\nCompliance Score: 3/10"),
    );

    const ctx = makeCtx({ consolidatedDraft: "draft" });
    const gov = await runGovernancePhase(
      ctx,
      "AI",
      120000,
      mockRouter as never,
      mockPub as never,
      mockRpc as never,
      mockRunLog as never,
    );

    expect(gov.recommendation).toBe("REJECTED");
    expect(ctx.feedback!.isApproved).toBe(false);
  });

  it("calls taskFailed on error", async () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRpc.call.mockResolvedValue({ taskId: "rev-1" });
    mockRouter.wait.mockRejectedValue(new Error("gov error"));

    await expect(
      runGovernancePhase(
        makeCtx(),
        "AI",
        120000,
        mockRouter as never,
        mockPub as never,
        mockRpc as never,
        mockRunLog as never,
      ),
    ).rejects.toThrow("gov error");
    expect(mockPub.taskFailed).toHaveBeenCalled();
  });
});

// ── runEditorialPhase ─────────────────────────────────────────────────────────

describe("runEditorialPhase() (global-research)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates editor task and calls awaitingHITL", async () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRpc.call.mockResolvedValue({ taskId: "edit-1" });
    mockRouter.wait.mockResolvedValue(
      parsedResult("Recommendation: PUBLISH\nCompliance Score: 8/10"),
    );

    const gov = { recommendation: "APPROVED", score: "9/10", text: "gov text" };
    const ctx = makeCtx({ consolidatedDraft: "draft" });
    const result = await runEditorialPhase(
      ctx,
      "AI",
      gov,
      120000,
      mockRouter as never,
      mockPub as never,
      mockRpc as never,
      mockRunLog as never,
    );

    expect(result.taskId).toBe("edit-1");
    expect(mockPub.awaitingHITL).toHaveBeenCalled();
  });

  it("calls taskFailed on error", async () => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRpc.call.mockResolvedValue({ taskId: "edit-1" });
    mockRouter.wait.mockRejectedValue(new Error("edit err"));

    const gov = { recommendation: "APPROVED", score: "9/10", text: "gov text" };
    await expect(
      runEditorialPhase(
        makeCtx(),
        "AI",
        gov,
        120000,
        mockRouter as never,
        mockPub as never,
        mockRpc as never,
        mockRunLog as never,
      ),
    ).rejects.toThrow("edit err");
    expect(mockPub.taskFailed).toHaveBeenCalled();
  });
});

// ── runRevisionPhase ──────────────────────────────────────────────────────────

describe("runRevisionPhase()", () => {
  beforeEach(() => vi.clearAllMocks());

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const makeRevDeps = (overrides: Record<string, unknown> = {}) => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    return {
      deps: {
        ctx: makeCtx({ consolidatedDraft: "original" }),
        query: "AI",
        redisUrl: "redis://localhost:6379",
        gov: { recommendation: "CONDITIONAL", score: "7/10", text: "gov text" },
        edit: {
          taskId: "edit-1",
          recommendation: "REVISE",
          score: "7/10",
          text: "edit text",
        },
        writeWaitMs: 120000,
        autoPub: false,
        router: mockRouter as never,
        pub: mockPub as never,
        rpc: mockRpc as never,
        rl: null,
        runLog: mockRunLog as never,
        ...overrides,
      },
      mockRpc,
      mockRouter,
      mockPub,
      mockRunLog,
    };
  };

  it("with autoPub=true publishes without calling waitForHITL", async () => {
    const { deps, mockRpc, mockRouter, mockPub, mockRunLog } = makeRevDeps({
      autoPub: true,
    });
    mockRpc.call.mockResolvedValue({ taskId: "rev-1" });
    mockRouter.wait.mockResolvedValue(parsedResult("revised report"));

    await runRevisionPhase(deps as never);

    expect(mockWaitForHITL).not.toHaveBeenCalled();
    expect(mockPub.workflowFinished).toHaveBeenCalled();
    expect(mockRunLog.finish).toHaveBeenCalledWith("REVISED");
  });

  it("with autoPub=false and PUBLISH decision calls workflowFinished", async () => {
    const { deps, mockRpc, mockRouter, mockPub, mockRunLog } = makeRevDeps({
      autoPub: false,
    });
    mockRpc.call.mockResolvedValue({ taskId: "rev-1" });
    mockRouter.wait.mockResolvedValue(parsedResult("revised report"));
    mockWaitForHITL.mockResolvedValue("PUBLISH");

    await runRevisionPhase(deps as never);

    expect(mockPub.workflowFinished).toHaveBeenCalled();
    expect(mockRunLog.finish).toHaveBeenCalledWith("REVISED");
  });

  it("with autoPub=false and non-PUBLISH decision calls workflowStopped", async () => {
    const { deps, mockRpc, mockRouter, mockPub, mockRunLog } = makeRevDeps({
      autoPub: false,
    });
    mockRpc.call.mockResolvedValue({ taskId: "rev-1" });
    mockRouter.wait.mockResolvedValue(parsedResult("revised report"));
    mockWaitForHITL.mockResolvedValue("REJECT");

    await runRevisionPhase(deps as never);

    expect(mockPub.workflowStopped).toHaveBeenCalled();
    expect(mockRunLog.finish).toHaveBeenCalledWith("STOPPED");
  });
});

// ── handleDecision ────────────────────────────────────────────────────────────

describe("handleDecision()", () => {
  beforeEach(() => vi.clearAllMocks());

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const makeDecisionDeps = (overrides: Record<string, unknown> = {}) => {
    const { mockRpc, mockRouter, mockPub, mockRunLog } = makeMocks();
    return {
      deps: {
        ctx: makeCtx({ consolidatedDraft: "draft" }),
        query: "AI",
        redisUrl: "redis://localhost:6379",
        gov: { recommendation: "CONDITIONAL", score: "7/10", text: "gov text" },
        edit: {
          taskId: "edit-1",
          recommendation: "PUBLISH",
          score: "8/10",
          text: "editorial text",
        },
        numSearchers: 2,
        writeWaitMs: 120000,
        autoPub: false,
        router: mockRouter as never,
        pub: mockPub as never,
        rpc: mockRpc as never,
        rl: null,
        runLog: mockRunLog as never,
        ...overrides,
      },
      mockRpc,
      mockRouter,
      mockPub,
      mockRunLog,
    };
  };

  it("autoPub=true publishes without waiting", async () => {
    const { deps, mockPub, mockRunLog } = makeDecisionDeps({ autoPub: true });
    await handleDecision(deps as never);
    expect(mockWaitForHITL).not.toHaveBeenCalled();
    expect(mockPub.workflowFinished).toHaveBeenCalled();
    expect(mockRunLog.finish).toHaveBeenCalledWith("PUBLISHED");
  });

  it("autoPub=false with PUBLISH decision calls workflowFinished", async () => {
    const { deps, mockPub, mockRunLog } = makeDecisionDeps({ autoPub: false });
    mockWaitForHITL.mockResolvedValue("PUBLISH");
    await handleDecision(deps as never);
    expect(mockPub.workflowFinished).toHaveBeenCalled();
    expect(mockRunLog.finish).toHaveBeenCalledWith("PUBLISHED");
  });

  it("REVISE decision calls runRevisionPhase (creates revision task)", async () => {
    const { deps, mockRpc, mockRouter } = makeDecisionDeps({ autoPub: false });
    mockWaitForHITL
      .mockResolvedValueOnce("REVISE")
      .mockResolvedValueOnce("PUBLISH");
    mockRpc.call.mockResolvedValue({ taskId: "rev-1" });
    mockRouter.wait.mockResolvedValue(parsedResult("revised"));

    await handleDecision(deps as never);

    expect(mockRpc.call).toHaveBeenCalledWith(
      "tasks.create",
      expect.objectContaining({ agentId: "writer" }),
    );
  });

  it("REJECT decision calls workflowStopped and runLog.finish('REJECTED')", async () => {
    const { deps, mockPub, mockRunLog } = makeDecisionDeps({ autoPub: false });
    mockWaitForHITL.mockResolvedValue("REJECT");
    await handleDecision(deps as never);
    expect(mockPub.workflowStopped).toHaveBeenCalledWith(
      "edit-1",
      "Report rejected by human editor",
      expect.anything(),
    );
    expect(mockRunLog.finish).toHaveBeenCalledWith("REJECTED");
  });
});
