import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
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
import type { MessagePayload } from "../../../src/infrastructure/messaging/interfaces";
import { AGENT_CHANNEL_PREFIX } from "../../../src/shared";

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

// ── typed driver mock (replaces the removed rpc.call('tasks.create', …) seam) ──
type PublishFn = (channel: string, payload: MessagePayload) => Promise<void>;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function makeMocks() {
  const publish = vi.fn<PublishFn>(() => Promise.resolve());
  const driver = { publish };
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
  return { driver, publish, mockRouter, mockPub, mockRunLog };
}

/** All dispatches published to a given agent's mailbox channel, in call order. */
function dispatchesTo(
  publish: Mock<PublishFn>,
  agentId: string,
): MessagePayload[] {
  const channel = `${AGENT_CHANNEL_PREFIX}${agentId}`;
  return publish.mock.calls.filter((c) => c[0] === channel).map((c) => c[1]);
}

/** The single dispatch published to a given agent's mailbox channel. */
function dispatchTo(publish: Mock<PublishFn>, agentId: string): MessagePayload {
  const all = dispatchesTo(publish, agentId);
  if (all.length === 0)
    throw new Error(`no dispatch published to ${AGENT_CHANNEL_PREFIX}${agentId}`);
  return all[all.length - 1]!;
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

  it("fans out tasks to the searcher mailbox and populates ctx.rawSearchData on success", async () => {
    const { driver, publish, mockRouter, mockPub, mockRunLog } = makeMocks();
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
      driver,
      mockRunLog as never,
    );

    // Regression: each searcher fan-out publishes to the searcher mailbox.
    const dispatches = dispatchesTo(publish, "searcher");
    expect(dispatches).toHaveLength(1);
    const d0 = dispatches[0]!;
    expect(d0.agentId).toBe("searcher");
    expect(typeof d0.timestamp).toBe("number");
    expect(d0.taskId).toEqual(expect.any(String));
    expect(d0.data["instruction"]).toEqual(expect.stringContaining("AI"));
    expect(d0.data["expectedOutput"]).toEqual(expect.any(String));
    expect(d0.data["inputs"]).toMatchObject({ topic: "AI", searchIndex: 0 });

    expect(ctx.rawSearchData).toHaveLength(1);
    expect(mockPub.searchingPhase).toHaveBeenCalled();
    expect(mockPub.searchPhaseComplete).toHaveBeenCalled();
  });

  it("fans out N searchers — one dispatch per sub-topic with a unique searchIndex", async () => {
    const { driver, publish, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRouter.waitAll.mockResolvedValue([
      { taskId: "s-0", result: parsedResult("a") },
      { taskId: "s-1", result: parsedResult("b") },
      { taskId: "s-2", result: parsedResult("c") },
    ]);

    const ctx = makeCtx();
    await runSearchPhase(
      ctx,
      "AI",
      3,
      60000,
      mockRouter as never,
      mockPub as never,
      driver,
      mockRunLog as never,
    );

    const dispatches = dispatchesTo(publish, "searcher");
    expect(dispatches).toHaveLength(3);
    const indices = dispatches.map(
      (d) => (d.data["inputs"] as { searchIndex: number }).searchIndex,
    );
    expect(indices.sort()).toEqual([0, 1, 2]);
    // taskIds are random and unique
    const ids = new Set(dispatches.map((d) => d.taskId));
    expect(ids.size).toBe(3);
  });

  it("maps each fan-out result to its dispatch index even when searchers finish out of order (C1)", async () => {
    const { driver, publish, mockRouter, mockPub, mockRunLog } = makeMocks();
    // waitAll returns results in COMPLETION order — simulate the reverse of the
    // dispatch order. The fix must resolve each result's real index via its taskId,
    // not the result-array position.
    mockRouter.waitAll.mockImplementation((ids: string[]) =>
      Promise.resolve(
        [...ids]
          .reverse()
          .map((id, k) => ({ taskId: id, result: parsedResult(`ans-${k}`) })),
      ),
    );

    const ctx = makeCtx();
    await runSearchPhase(
      ctx,
      "AI",
      3,
      60000,
      mockRouter as never,
      mockPub as never,
      driver,
      mockRunLog as never,
    );

    const dispatched = dispatchesTo(publish, "searcher"); // dispatch order
    expect(dispatched).toHaveLength(3);
    // The result carrying dispatched[i]'s taskId must be logged as searcher-i —
    // regardless of the reversed completion order (would fail on the old code).
    for (let i = 0; i < dispatched.length; i++) {
      expect(mockRunLog.logTask).toHaveBeenCalledWith(
        "search",
        dispatched[i]!.taskId,
        `searcher-${i}`,
        expect.anything(),
      );
    }
    expect(ctx.rawSearchData).toHaveLength(3);

    // C1-residual: the board publication must receive a dispatch-order
    // indexByTaskId map so out-of-order results still get the right searcher card
    // (board mis-attribution was caused by using the result-array position).
    expect(mockPub.searchPhaseComplete).toHaveBeenCalledTimes(1);
    const [resultsArg, indexByTaskId] = mockPub.searchPhaseComplete.mock
      .calls[0] as [
      Array<{ taskId: string }>,
      Map<string, number>,
    ];
    expect(indexByTaskId).toBeInstanceOf(Map);
    for (let i = 0; i < dispatched.length; i++) {
      expect(indexByTaskId.get(dispatched[i]!.taskId)).toBe(i);
    }
    // Every completion-order result resolves back to its dispatch-order index.
    for (const r of resultsArg) {
      const dispatchIdx = dispatched.findIndex(
        (d) => d.taskId === r.taskId,
      );
      expect(indexByTaskId.get(r.taskId)).toBe(dispatchIdx);
    }
  });

  it("uses '' fallback for taskIds[i] and subTopics[i] when results exceed numSearchers (lines 91,93,95 branches)", async () => {
    const { driver, mockRouter, mockPub, mockRunLog } = makeMocks();
    // 1 searcher dispatched → taskIds has 1 entry; waitAll returns 3 results
    // Use JSON with null answer for index 1 → triggers parsed.answer || sr.result fallback
    const nullAnswerResult = JSON.stringify({
      answer: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
    });
    mockRouter.waitAll.mockResolvedValue([
      { taskId: "s-1", result: parsedResult("ok") }, // index 0 → taskIds[0] exists, subTopics[0] exists
      { taskId: "s-extra", result: nullAnswerResult }, // index 1 → taskIds[1]=undefined→'', subTopics[1]=undefined→'', answer=''→||sr.result
      { taskId: "s-err", error: "boom" }, // index 2 → taskIds[2]=undefined→'', sr.error path
    ]);

    const ctx = makeCtx();
    await runSearchPhase(
      ctx,
      "AI",
      1,
      60000,
      mockRouter as never,
      mockPub as never,
      driver,
      mockRunLog as never,
    );
    expect(ctx.rawSearchData).toHaveLength(2);
  });

  it("logs errors for failed searcher results", async () => {
    const { driver, mockRouter, mockPub, mockRunLog } = makeMocks();
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
      driver,
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

  it("skips results with neither result nor error (else-if false branch)", async () => {
    const { driver, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRouter.waitAll.mockResolvedValue([
      { taskId: "s-1", result: parsedResult("ok") }, // covers sr.result path
      { taskId: "s-empty" }, // neither result nor error → skipped
    ]);

    const ctx = makeCtx();
    await runSearchPhase(
      ctx,
      "AI",
      2,
      60000,
      mockRouter as never,
      mockPub as never,
      driver,
      mockRunLog as never,
    );
    expect(ctx.rawSearchData).toHaveLength(1);
  });

  it("throws when all searchers fail", async () => {
    const { driver, mockRouter, mockPub, mockRunLog } = makeMocks();
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
        driver,
        mockRunLog as never,
      ),
    ).rejects.toThrow("All searcher tasks failed");
  });
});

// ── runWritePhase ─────────────────────────────────────────────────────────────

describe("runWritePhase() (global-research)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dispatches to the writer mailbox and updates ctx.consolidatedDraft", async () => {
    const { driver, publish, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRouter.wait.mockResolvedValue(parsedResult("Consolidated report"));

    const ctx = makeCtx();
    await runWritePhase(
      ctx,
      "AI",
      120000,
      mockRouter as never,
      mockPub as never,
      driver,
      mockRunLog as never,
    );

    const payload = dispatchTo(publish, "writer");
    expect(payload.agentId).toBe("writer");
    expect(typeof payload.timestamp).toBe("number");
    expect(payload.taskId).toEqual(expect.any(String));
    expect(payload.data["instruction"]).toEqual(expect.stringContaining("AI"));
    expect(payload.data["context"]).toContain(`RESEARCH CONTEXT ID: ${ctx.id}`);

    expect(ctx.consolidatedDraft).toBe("Consolidated report");
    expect(mockPub.aggregatingPhase).toHaveBeenCalledWith(payload.taskId, 0);
    expect(mockPub.taskDone).toHaveBeenCalledWith(payload.taskId, "writer");
  });

  it("builds searchSummary from populated rawSearchData (line 116 map callback)", async () => {
    const { driver, publish, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRouter.wait.mockResolvedValue(parsedResult("Report with sources"));

    const ctx = makeCtx({
      rawSearchData: [
        {
          agentId: "searcher-0",
          title: "AI Safety Overview",
          snippet: "Key findings here",
          sourceUrl: "research://searcher-0/1",
          relevanceScore: 0.9,
          timestamp: new Date().toISOString(),
        },
      ],
    });

    await runWritePhase(
      ctx,
      "AI safety",
      120000,
      mockRouter as never,
      mockPub as never,
      driver,
      mockRunLog as never,
    );

    // The dispatched context should contain the formatted source line
    const payload = dispatchTo(publish, "writer");
    const context = payload.data["context"] as string;
    expect(context).toContain("[Source 1] searcher-0");
    expect(context).toContain("AI Safety Overview");
    expect(payload.data["inputs"]).toMatchObject({ numSources: 1 });
  });

  it("calls taskFailed and rethrows on error", async () => {
    const { driver, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRouter.wait.mockRejectedValue(new Error("write err"));

    await expect(
      runWritePhase(
        makeCtx(),
        "AI",
        120000,
        mockRouter as never,
        mockPub as never,
        driver,
        mockRunLog as never,
      ),
    ).rejects.toThrow("write err");
    expect(mockPub.taskFailed).toHaveBeenCalled();
  });

  it("falls back to raw when parsed.answer is empty (line 137 || branch)", async () => {
    const { driver, mockRouter, mockPub, mockRunLog } = makeMocks();
    // JSON with null answer → parseHandlerResult returns answer: ""
    const rawFallback = JSON.stringify({
      answer: null,
      inputTokens: 5,
      outputTokens: 3,
      estimatedCost: 0.001,
    });
    mockRouter.wait.mockResolvedValue(rawFallback);

    const ctx = makeCtx();
    await runWritePhase(
      ctx,
      "AI",
      120000,
      mockRouter as never,
      mockPub as never,
      driver,
      mockRunLog as never,
    );
    expect(ctx.consolidatedDraft).toBe(rawFallback);
  });
});

// ── runGovernancePhase ────────────────────────────────────────────────────────

describe("runGovernancePhase()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dispatches to the reviewer mailbox, returns APPROVED and populates ctx.feedback", async () => {
    const { driver, publish, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRouter.wait.mockResolvedValue(
      parsedResult("Recommendation: APPROVED\nCompliance Score: 9/10\nAll good"),
    );

    const ctx = makeCtx({ consolidatedDraft: "draft text" });
    const gov = await runGovernancePhase(
      ctx,
      "AI",
      120000,
      mockRouter as never,
      mockPub as never,
      driver,
      mockRunLog as never,
    );

    // Regression: governance review is dispatched to the reviewer mailbox.
    const payload = dispatchTo(publish, "reviewer");
    expect(payload.agentId).toBe("reviewer");
    expect(typeof payload.timestamp).toBe("number");
    expect(payload.data["instruction"]).toEqual(expect.any(String));
    expect(payload.data["context"]).toContain("--- RESEARCH REPORT ---");
    expect(payload.data["context"]).toContain("draft text");
    expect(mockPub.reviewingPhase).toHaveBeenCalledWith(payload.taskId);

    expect(gov.recommendation).toBe("APPROVED");
    expect(ctx.feedback).toBeDefined();
    expect(ctx.feedback!.isApproved).toBe(true);
  });

  it("returns REJECTED recommendation and sets isApproved=false", async () => {
    const { driver, mockRouter, mockPub, mockRunLog } = makeMocks();
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
      driver,
      mockRunLog as never,
    );

    expect(gov.recommendation).toBe("REJECTED");
    expect(ctx.feedback!.isApproved).toBe(false);
  });

  it("calls taskFailed on error", async () => {
    const { driver, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRouter.wait.mockRejectedValue(new Error("gov error"));

    await expect(
      runGovernancePhase(
        makeCtx(),
        "AI",
        120000,
        mockRouter as never,
        mockPub as never,
        driver,
        mockRunLog as never,
      ),
    ).rejects.toThrow("gov error");
    expect(mockPub.taskFailed).toHaveBeenCalled();
  });

  it("extracts compliance violations from governance text (line 177 matchAll loop body)", async () => {
    const { driver, mockRouter, mockPub, mockRunLog } = makeMocks();
    // Include a compliance violation in the format the regex expects
    const violationText =
      "Recommendation: REJECTED\nCompliance Score: 3/10\n- Data Privacy — Standard: GDPR — Severity: High";
    mockRouter.wait.mockResolvedValue(parsedResult(violationText));

    const ctx = makeCtx({ consolidatedDraft: "draft" });
    const gov = await runGovernancePhase(
      ctx,
      "AI",
      120000,
      mockRouter as never,
      mockPub as never,
      driver,
      mockRunLog as never,
    );
    expect(gov.recommendation).toBe("REJECTED");
    expect(ctx.feedback?.complianceViolations).toContain("Data Privacy");
  });

  it("falls back to raw when parsed.answer is empty (line 169 || branch)", async () => {
    const { driver, mockRouter, mockPub, mockRunLog } = makeMocks();
    const rawFallback = JSON.stringify({
      answer: null,
      inputTokens: 2,
      outputTokens: 1,
      estimatedCost: 0.0,
    });
    mockRouter.wait.mockResolvedValue(rawFallback);

    const gov = await runGovernancePhase(
      makeCtx({ consolidatedDraft: "draft" }),
      "AI",
      120000,
      mockRouter as never,
      mockPub as never,
      driver,
      mockRunLog as never,
    );
    // parseRecommendation on rawFallback (JSON string) returns UNKNOWN
    expect(gov.recommendation).toBe("UNKNOWN");
  });
});

// ── runEditorialPhase ─────────────────────────────────────────────────────────

describe("runEditorialPhase() (global-research)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dispatches to the editor mailbox and calls awaitingHITL", async () => {
    const { driver, publish, mockRouter, mockPub, mockRunLog } = makeMocks();
    // The editor (Morgan) emits an "Accuracy Score", NOT "Compliance Score"
    // (that is the governance reviewer's label). Parsing the wrong label made
    // the editorial score always render "N/A" — guard against the regression.
    mockRouter.wait.mockResolvedValue(
      parsedResult("Recommendation: PUBLISH\nAccuracy Score: 8/10"),
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
      driver,
      mockRunLog as never,
    );

    const payload = dispatchTo(publish, "editor");
    expect(payload.agentId).toBe("editor");
    expect(payload.taskId).toBe(result.taskId);
    expect(typeof payload.timestamp).toBe("number");
    expect(payload.data["instruction"]).toEqual(
      expect.stringContaining(gov.recommendation),
    );
    expect(payload.data["context"]).toContain("--- RESEARCH REPORT ---");
    expect(payload.data["context"]).toContain("draft");

    expect(result.taskId).toEqual(expect.any(String));
    expect(result.score).toBe("8/10");
    expect(mockPub.awaitingHITL).toHaveBeenCalled();
  });

  it("calls taskFailed on error", async () => {
    const { driver, mockRouter, mockPub, mockRunLog } = makeMocks();
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
        driver,
        mockRunLog as never,
      ),
    ).rejects.toThrow("edit err");
    expect(mockPub.taskFailed).toHaveBeenCalled();
  });

  it("falls back to raw when parsed.answer is empty (line 211 || branch)", async () => {
    const { driver, mockRouter, mockPub, mockRunLog } = makeMocks();
    const rawFallback = JSON.stringify({
      answer: null,
      inputTokens: 1,
      outputTokens: 1,
      estimatedCost: 0.0,
    });
    mockRouter.wait.mockResolvedValue(rawFallback);

    const gov = { recommendation: "APPROVED", score: "9/10", text: "gov text" };
    const result = await runEditorialPhase(
      makeCtx({ consolidatedDraft: "draft" }),
      "AI",
      gov,
      120000,
      mockRouter as never,
      mockPub as never,
      driver,
      mockRunLog as never,
    );
    expect(result.taskId).toEqual(expect.any(String));
  });
});

// ── runRevisionPhase ──────────────────────────────────────────────────────────

describe("runRevisionPhase()", () => {
  beforeEach(() => vi.clearAllMocks());

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const makeRevDeps = (overrides: Record<string, unknown> = {}) => {
    const { driver, publish, mockRouter, mockPub, mockRunLog } = makeMocks();
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
        driver,
        rl: null,
        runLog: mockRunLog as never,
        ...overrides,
      },
      driver,
      publish,
      mockRouter,
      mockPub,
      mockRunLog,
    };
  };

  it("with autoPub=true dispatches a revision to the writer mailbox without calling waitForHITL", async () => {
    const { deps, publish, mockRouter, mockPub, mockRunLog } = makeRevDeps({
      autoPub: true,
    });
    mockRouter.wait.mockResolvedValue(parsedResult("revised report"));

    await runRevisionPhase(deps as never);

    // Regression: revision is dispatched to the writer mailbox.
    const payload = dispatchTo(publish, "writer");
    expect(payload.agentId).toBe("writer");
    expect(typeof payload.timestamp).toBe("number");
    expect(payload.data["instruction"]).toEqual(
      expect.stringContaining("Revise"),
    );
    expect(payload.data["context"]).toContain("--- EDITORIAL FEEDBACK ---");
    expect(payload.data["context"]).toContain("edit text");

    expect(mockWaitForHITL).not.toHaveBeenCalled();
    expect(mockPub.workflowFinished).toHaveBeenCalled();
    expect(mockRunLog.finish).toHaveBeenCalledWith("REVISED");
  });

  it("with autoPub=false and PUBLISH decision calls workflowFinished", async () => {
    const { deps, mockRouter, mockPub, mockRunLog } = makeRevDeps({
      autoPub: false,
    });
    mockRouter.wait.mockResolvedValue(parsedResult("revised report"));
    mockWaitForHITL.mockResolvedValue("PUBLISH");

    await runRevisionPhase(deps as never);

    expect(mockPub.workflowFinished).toHaveBeenCalled();
    expect(mockRunLog.finish).toHaveBeenCalledWith("REVISED");
  });

  it("with autoPub=false and non-PUBLISH decision calls workflowStopped", async () => {
    const { deps, mockRouter, mockPub, mockRunLog } = makeRevDeps({
      autoPub: false,
    });
    mockRouter.wait.mockResolvedValue(parsedResult("revised report"));
    mockWaitForHITL.mockResolvedValue("REJECT");

    await runRevisionPhase(deps as never);

    expect(mockPub.workflowStopped).toHaveBeenCalled();
    expect(mockRunLog.finish).toHaveBeenCalledWith("STOPPED");
  });

  it("invokes onView callback when waitForHITL triggers it (line 261)", async () => {
    const { deps, mockRouter } = makeRevDeps({ autoPub: false });
    mockRouter.wait.mockResolvedValue(parsedResult("revised report"));

    mockWaitForHITL.mockImplementationOnce(
      async (opts: { onView?: () => void }) => {
        if (opts.onView) opts.onView();
        return "PUBLISH";
      },
    );

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await runRevisionPhase(deps as never);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("---"));
    stdoutSpy.mockRestore();
  });

  it("onView uses '' fallback when consolidatedDraft cleared before view (line 263 ?? branch)", async () => {
    const { deps, mockRouter } = makeRevDeps({ autoPub: false });
    mockRouter.wait.mockResolvedValue(parsedResult("revised report"));

    mockWaitForHITL.mockImplementationOnce(
      async (opts: { onView?: () => void; taskId?: string }) => {
        // Clear consolidatedDraft before calling onView to trigger the ?? '' fallback
        delete (deps.ctx as unknown as Record<string, unknown>)[
          "consolidatedDraft"
        ];
        if (opts.onView) opts.onView();
        return "PUBLISH";
      },
    );

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await runRevisionPhase(deps as never);
    stdoutSpy.mockRestore();
  });

  it("falls back to raw when parsed.answer is empty (line 253 || branch)", async () => {
    const { deps, mockRouter } = makeRevDeps({ autoPub: true });
    const rawFallback = JSON.stringify({
      answer: null,
      inputTokens: 2,
      outputTokens: 1,
      estimatedCost: 0.0,
    });
    mockRouter.wait.mockResolvedValue(rawFallback);

    await runRevisionPhase(deps as never);

    expect(deps.ctx.consolidatedDraft).toBe(rawFallback);
  });
});

// ── handleDecision ────────────────────────────────────────────────────────────

describe("handleDecision()", () => {
  beforeEach(() => vi.clearAllMocks());

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const makeDecisionDeps = (overrides: Record<string, unknown> = {}) => {
    const { driver, publish, mockRouter, mockPub, mockRunLog } = makeMocks();
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
        driver,
        rl: null,
        runLog: mockRunLog as never,
        ...overrides,
      },
      driver,
      publish,
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

  it("REVISE decision dispatches a revision to the writer mailbox", async () => {
    const { deps, publish, mockRouter } = makeDecisionDeps({ autoPub: false });
    mockWaitForHITL
      .mockResolvedValueOnce("REVISE")
      .mockResolvedValueOnce("PUBLISH");
    mockRouter.wait.mockResolvedValue(parsedResult("revised"));

    await handleDecision(deps as never);

    // Regression: REVISE re-dispatches to the writer mailbox.
    const payload = dispatchTo(publish, "writer");
    expect(payload.agentId).toBe("writer");
    expect(payload.data["instruction"]).toEqual(
      expect.stringContaining("Revise"),
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

  it("invokes onView callback when waitForHITL triggers it (line 299)", async () => {
    const { deps } = makeDecisionDeps({ autoPub: false });

    mockWaitForHITL.mockImplementationOnce(
      async (opts: { onView?: () => void }) => {
        if (opts.onView) opts.onView();
        return "PUBLISH";
      },
    );

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await handleDecision(deps as never);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("---"));
    stdoutSpy.mockRestore();
  });

  it("onView callback uses '' when consolidatedDraft is undefined (line 302 ?? branch)", async () => {
    // ctx without consolidatedDraft → consolidatedDraft ?? '' falls back to ''
    const { deps } = makeDecisionDeps({ autoPub: false, ctx: makeCtx() });
    // makeCtx() does not set consolidatedDraft → undefined

    mockWaitForHITL.mockImplementationOnce(
      async (opts: { onView?: () => void }) => {
        if (opts.onView) opts.onView();
        return "PUBLISH";
      },
    );

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await handleDecision(deps as never);
    stdoutSpy.mockRestore();
  });
});
