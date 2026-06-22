import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
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
import type { MessagePayload } from "../../../src/infrastructure/messaging/interfaces";
import { AGENT_CHANNEL_PREFIX } from "../../../src/shared";

// ── mock waitForHITLDecision from shared ─────────────────────────────────────
const { mockWaitForHITL } = vi.hoisted(() => ({ mockWaitForHITL: vi.fn() }));
vi.mock("../../../src/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/shared")>();
  return { ...actual, waitForHITLDecision: mockWaitForHITL };
});

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
  return { driver, publish, mockRouter, mockPub, mockRunLog };
}

/** Find the dispatch published to a given agent's mailbox channel. */
function dispatchTo(
  publish: Mock<PublishFn>,
  agentId: string,
): { channel: string; payload: MessagePayload } {
  const channel = `${AGENT_CHANNEL_PREFIX}${agentId}`;
  const call = publish.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`no dispatch published to ${channel}`);
  return { channel: call[0], payload: call[1] };
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

  it("dispatches to the researcher mailbox and returns summary", async () => {
    const { driver, publish, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRouter.wait.mockResolvedValue(parsedResult("Research summary"));

    const result = await runResearchPhase(
      "AI topic",
      mockRouter as never,
      mockPub as never,
      driver,
      mockRunLog as never,
    );

    // Regression: the phase MUST publish to the researcher's actor mailbox
    // (kaiban-agents-researcher), not the removed tasks.create RPC.
    const { channel, payload } = dispatchTo(publish, "researcher");
    expect(channel).toBe("kaiban-agents-researcher");
    expect(payload.agentId).toBe("researcher");
    expect(payload.taskId).toBe(result.taskId);
    expect(typeof payload.timestamp).toBe("number");
    expect(payload.data["instruction"]).toEqual(
      expect.stringContaining("AI topic"),
    );
    expect(payload.data["expectedOutput"]).toEqual(expect.any(String));
    expect(payload.data["inputs"]).toEqual({ topic: "AI topic" });

    // taskId is now random — read it back, do not assert a fixed value.
    expect(result.taskId).toEqual(expect.any(String));
    expect(mockPub.taskQueued).toHaveBeenCalledWith(
      result.taskId,
      expect.any(String),
      "researcher",
    );
    expect(result.summary).toBe("Research summary");
  });

  it("calls taskFailed and rethrows when router.wait rejects", async () => {
    const { driver, publish, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRouter.wait.mockRejectedValue(new Error("timeout"));

    await expect(
      runResearchPhase(
        "topic",
        mockRouter as never,
        mockPub as never,
        driver,
        mockRunLog as never,
      ),
    ).rejects.toThrow("timeout");
    const { payload } = dispatchTo(publish, "researcher");
    expect(mockPub.taskFailed).toHaveBeenCalledWith(
      payload.taskId,
      "researcher",
      expect.any(String),
      "timeout",
    );
  });
});

// ── runWritePhase ─────────────────────────────────────────────────────────────

describe("runWritePhase()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dispatches to the writer mailbox and returns draft", async () => {
    const { driver, publish, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRouter.wait.mockResolvedValue(parsedResult("Draft content"));

    const result = await runWritePhase(
      "topic",
      "research summary",
      mockRouter as never,
      mockPub as never,
      driver,
      mockRunLog as never,
    );

    const { channel, payload } = dispatchTo(publish, "writer");
    expect(channel).toBe("kaiban-agents-writer");
    expect(payload.agentId).toBe("writer");
    expect(payload.taskId).toBe(result.taskId);
    expect(typeof payload.timestamp).toBe("number");
    expect(payload.data["instruction"]).toEqual(
      expect.stringContaining("topic"),
    );
    expect(payload.data["context"]).toBe("research summary");
    expect(payload.data["inputs"]).toEqual({ topic: "topic" });

    expect(result.taskId).toEqual(expect.any(String));
    expect(result.draft).toBe("Draft content");
  });

  it("calls taskFailed on writer error", async () => {
    const { driver, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRouter.wait.mockRejectedValue(new Error("write error"));

    await expect(
      runWritePhase(
        "topic",
        "summary",
        mockRouter as never,
        mockPub as never,
        driver,
        mockRunLog as never,
      ),
    ).rejects.toThrow("write error");
    expect(mockPub.taskFailed).toHaveBeenCalled();
  });
});

// ── runEditorialPhase ─────────────────────────────────────────────────────────

describe("runEditorialPhase()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dispatches to the editor mailbox and returns recommendation and score", async () => {
    const { driver, publish, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRouter.wait.mockResolvedValue(
      parsedResult("Recommendation: PUBLISH\nAccuracy Score: 9/10\nDetails here"),
    );

    const result = await runEditorialPhase(
      "topic",
      "research",
      "draft",
      mockRouter as never,
      mockPub as never,
      driver,
      mockRunLog as never,
    );

    const { channel, payload } = dispatchTo(publish, "editor");
    expect(channel).toBe("kaiban-agents-editor");
    expect(payload.agentId).toBe("editor");
    expect(payload.taskId).toBe(result.taskId);
    expect(typeof payload.timestamp).toBe("number");
    expect(payload.data["instruction"]).toEqual(expect.any(String));
    expect(payload.data["context"]).toContain("--- RESEARCH SUMMARY ---");
    expect(payload.data["context"]).toContain("research");
    expect(payload.data["context"]).toContain("draft");
    expect(payload.data["inputs"]).toEqual({ topic: "topic" });

    expect(result.taskId).toEqual(expect.any(String));
    expect(result.recommendation).toBe("PUBLISH");
    expect(mockPub.taskQueued).toHaveBeenCalledWith(
      result.taskId,
      "Editorial Review",
      "editor",
    );
  });

  it("calls taskFailed on editorial error", async () => {
    const { driver, mockRouter, mockPub, mockRunLog } = makeMocks();
    mockRouter.wait.mockRejectedValue(new Error("edit error"));

    await expect(
      runEditorialPhase(
        "topic",
        "research",
        "draft",
        mockRouter as never,
        mockPub as never,
        driver,
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
    const { driver, publish, mockRouter, mockPub, mockRunLog } = makeMocks();
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
        driver,
        rl: { question: vi.fn(), write: vi.fn(), close: vi.fn() } as never,
        runLog: mockRunLog as never,
        totalTokens: 100,
        totalCost: 0.001,
      },
      driver,
      publish,
      mockRouter,
      mockPub,
      mockRunLog,
    };
  };

  it("returns PUBLISHED when HITL decision is PUBLISH", async () => {
    const { deps, publish, mockRouter, mockPub } = baseRevDeps();
    mockRouter.wait.mockResolvedValue(parsedResult("Revised draft"));
    mockWaitForHITL.mockResolvedValue("PUBLISH");

    const outcome = await runBlogRevision(deps);
    expect(outcome).toBe("PUBLISHED");
    expect(mockPub.workflowFinished).toHaveBeenCalled();

    // Regression: the revision is dispatched back to the writer mailbox.
    const { channel, payload } = dispatchTo(publish, "writer");
    expect(channel).toBe("kaiban-agents-writer");
    expect(payload.agentId).toBe("writer");
    expect(typeof payload.timestamp).toBe("number");
    expect(payload.data["instruction"]).toEqual(
      expect.stringContaining("Revise"),
    );
    expect(payload.data["context"]).toContain("--- EDITORIAL FEEDBACK ---");
    expect(payload.data["context"]).toContain("review");
    expect(payload.data["inputs"]).toEqual({ topic: "topic" });
  });

  it("returns STOPPED when HITL decision is not PUBLISH", async () => {
    const { deps, mockRouter, mockPub } = baseRevDeps();
    mockRouter.wait.mockResolvedValue(parsedResult("Revised draft"));
    mockWaitForHITL.mockResolvedValue("REJECT");

    const outcome = await runBlogRevision(deps);
    expect(outcome).toBe("STOPPED");
    expect(mockPub.workflowStopped).toHaveBeenCalled();
  });

  it("invokes onView callback when waitForHITL triggers it (line 165)", async () => {
    const { deps, mockRouter } = baseRevDeps();
    mockRouter.wait.mockResolvedValue(parsedResult("Revised draft"));

    // Make mockWaitForHITL invoke the onView callback before resolving
    mockWaitForHITL.mockImplementationOnce(
      async (opts: { onView?: () => void }) => {
        if (opts.onView) opts.onView();
        return "PUBLISH";
      },
    );

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await runBlogRevision(deps);
    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining("REVISED DRAFT"),
    );
    stdoutSpy.mockRestore();
  });
});

// ── handleBlogDecision ───────────────────────────────────────────────────────

describe("handleBlogDecision()", () => {
  beforeEach(() => vi.clearAllMocks());

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const baseDecisionDeps = () => {
    const { driver, publish, mockRouter, mockPub, mockRunLog } = makeMocks();
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
        driver,
        rl: { question: vi.fn(), write: vi.fn(), close: vi.fn() } as never,
        runLog: mockRunLog as never,
      },
      driver,
      publish,
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

  it("REVISE decision calls runBlogRevision and finishes REVISED when revision publishes", async () => {
    const { deps, publish, mockRouter, mockRunLog } = baseDecisionDeps();
    mockWaitForHITL
      .mockResolvedValueOnce("REVISE") // first call — handleBlogDecision
      .mockResolvedValueOnce("PUBLISH"); // second call — runBlogRevision
    mockRouter.wait.mockResolvedValue(parsedResult("revised"));

    await handleBlogDecision(deps);

    // Regression: REVISE re-dispatches to the writer mailbox.
    const { channel, payload } = dispatchTo(publish, "writer");
    expect(channel).toBe("kaiban-agents-writer");
    expect(payload.agentId).toBe("writer");
    expect(payload.data["instruction"]).toEqual(
      expect.stringContaining("Revise"),
    );
    expect(mockRunLog.finish).toHaveBeenCalledWith("REVISED");
  });

  it("REVISE decision finishes STOPPED when revision is rejected (line 226 false branch)", async () => {
    const { deps, mockRouter, mockRunLog } = baseDecisionDeps();
    mockWaitForHITL
      .mockResolvedValueOnce("REVISE") // first call — handleBlogDecision
      .mockResolvedValueOnce("REJECT"); // second call — runBlogRevision → STOPPED
    mockRouter.wait.mockResolvedValue(parsedResult("revised"));

    await handleBlogDecision(deps);

    expect(mockRunLog.finish).toHaveBeenCalledWith("STOPPED");
  });

  it("REVISE recommendation icon shows [REVISE] (line 199 middle branch)", async () => {
    const { deps } = baseDecisionDeps();
    deps.edit = { ...deps.edit, recommendation: "REVISE" };
    mockWaitForHITL.mockResolvedValue("REJECT"); // just end quickly

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await handleBlogDecision(deps);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("[REVISE]"));
    stdoutSpy.mockRestore();
  });

  it("REJECT recommendation icon shows [REJECT] (line 199 last branch)", async () => {
    const { deps } = baseDecisionDeps();
    deps.edit = { ...deps.edit, recommendation: "REJECT" };
    mockWaitForHITL.mockResolvedValue("REJECT");

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await handleBlogDecision(deps);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("[REJECT]"));
    stdoutSpy.mockRestore();
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

  it("invokes onView callback when waitForHITL triggers it (line 206)", async () => {
    const { deps } = baseDecisionDeps();

    mockWaitForHITL.mockImplementationOnce(
      async (opts: { onView?: () => void }) => {
        if (opts.onView) opts.onView();
        return "PUBLISH";
      },
    );

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await handleBlogDecision(deps);
    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining("FULL BLOG DRAFT"),
    );
    stdoutSpy.mockRestore();
  });
});
