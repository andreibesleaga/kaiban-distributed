/**
 * kaiban-agent-bridge — workflow log paths.
 *
 * These tests specifically cover the workflowLog-based error extraction paths
 * that require a Team mock with a working getStore() method:
 *
 *   - findWorkflowFallbackMessage: logDescription path (with Workflow/Task blocked prefix stripping)
 *   - findWorkflowRootCauseMessage: depth>0 returning record["message"] (nested originalError/cause)
 *   - extractNestedErrorMessageFromRecord: blockReason fallback
 *   - extractNestedErrorMessageFromRecord: logDescription fallback (when message and blockReason absent)
 *
 * The standard test files use a minimal Team mock without getStore(), which causes
 * the code to fall back to result.result — bypassing the workflowLog paths entirely.
 * This file uses a Team mock with getStore() to exercise those paths.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createKaibanTaskHandler } from "../../../src/infrastructure/kaibanjs/kaiban-agent-bridge";
import type {
  IMessagingDriver,
  MessagePayload,
} from "../../../src/infrastructure/messaging/interfaces";

type WorkflowLog = {
  logType?: string;
  agentStatus?: string;
  logDescription?: string;
  metadata?: { error?: unknown };
};

let mockWorkflowLogs: WorkflowLog[] = [];
const mockTeamStart = vi.fn();

vi.mock("kaibanjs", () => ({
  Agent: vi.fn().mockImplementation(function () {
    return {};
  }),
  Task: vi.fn().mockImplementation(function (params: Record<string, unknown>) {
    return { ...params };
  }),
  Team: vi.fn().mockImplementation(function (params: Record<string, unknown>) {
    return {
      start: mockTeamStart,
      getStore: (): { getState: () => { workflowLogs: WorkflowLog[] } } => ({
        getState: () => ({ workflowLogs: mockWorkflowLogs }),
      }),
      ...params,
    };
  }),
}));

function makeDriver(): IMessagingDriver {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

const basePayload: MessagePayload = {
  taskId: "task-001",
  agentId: "researcher",
  timestamp: Date.now(),
  data: {},
};

function makeErrored(result: unknown = new Error("workflow error")): {
  status: string;
  result: unknown;
  stats: null;
} {
  return { status: "ERRORED", result, stats: null };
}

describe("kaiban-agent-bridge — workflow log paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkflowLogs = [];
    mockTeamStart.mockResolvedValue(makeErrored());
  });

  // ── findWorkflowFallbackMessage — logDescription ──────────────────────────

  it("uses logDescription from workflow log as fallback error (no error object)", async () => {
    mockWorkflowLogs = [{ logDescription: "Workflow ended: content policy" }];
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    await expect(h(basePayload)).rejects.toThrow("content policy");
  });

  it("strips 'Workflow blocked: ' prefix from logDescription", async () => {
    mockWorkflowLogs = [
      { logDescription: "Workflow blocked: Rate limit exceeded" },
    ];
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    await expect(h(basePayload)).rejects.toThrow("Rate limit exceeded");
  });

  it("strips 'Task blocked: ... Reason: ' prefix from logDescription", async () => {
    mockWorkflowLogs = [
      { logDescription: "Task blocked: write article Reason: Token limit" },
    ];
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    await expect(h(basePayload)).rejects.toThrow("Token limit");
  });

  it("uses logDescription unchanged when it has no known prefix", async () => {
    mockWorkflowLogs = [{ logDescription: "Custom failure message" }];
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    await expect(h(basePayload)).rejects.toThrow("Custom failure message");
  });

  // ── extractNestedErrorMessageFromRecord — blockReason fallback ────────────

  it("uses blockReason when metadata.error has no message or nested keys", async () => {
    mockWorkflowLogs = [
      { metadata: { error: { blockReason: "Content blocked by policy" } } },
    ];
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    await expect(h(basePayload)).rejects.toThrow("Content blocked by policy");
  });

  it("uses logDescription field on error object when message and blockReason absent", async () => {
    mockWorkflowLogs = [
      {
        metadata: {
          error: {
            logDescription: "Agent terminated unexpectedly",
          },
        },
      },
    ];
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    await expect(h(basePayload)).rejects.toThrow(
      "Agent terminated unexpectedly",
    );
  });

  // ── extractRootCauseMessage — depth > 0 path (nested keys) ───────────────

  it("extracts nested message from originalError (depth > 0 returns message)", async () => {
    mockWorkflowLogs = [
      {
        logType: "AgentStatusUpdate",
        metadata: {
          error: {
            originalError: { message: "Root LLM API failure" },
          },
        },
      },
    ];
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    await expect(h(basePayload)).rejects.toThrow("Root LLM API failure");
  });

  it("extracts nested message from cause field (depth > 0)", async () => {
    mockWorkflowLogs = [
      {
        agentStatus: "THINKING_ERROR",
        metadata: {
          error: {
            cause: { message: "Connection refused" },
          },
        },
      },
    ];
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    await expect(h(basePayload)).rejects.toThrow("Connection refused");
  });

  it("extracts message through rootError field", async () => {
    mockWorkflowLogs = [
      {
        logType: "AgentStatusUpdate",
        metadata: {
          error: {
            rootError: { message: "Deep root error" },
          },
        },
      },
    ];
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    await expect(h(basePayload)).rejects.toThrow("Deep root error");
  });

  // ── scanBackwards (last log checked first) ───────────────────────────────

  it("scans logs in reverse order — last log wins for fallback", async () => {
    mockWorkflowLogs = [
      { logDescription: "First log message" },
      { logDescription: "Second (last) log message" },
    ];
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    await expect(h(basePayload)).rejects.toThrow("Second (last) log message");
  });

  it("skips logs with null/undefined logDescription and uses the one with content", async () => {
    mockWorkflowLogs = [
      { logDescription: "First real message" },
      { logDescription: undefined },
    ];
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    // Last log has undefined logDescription — scan goes to prior log
    await expect(h(basePayload)).rejects.toThrow("First real message");
  });

  // ── toErrorRecord: primitive (non-Error, non-object) value → undefined ──────

  it("falls through all helpers when result.result is a number (lines 189 + 239)", async () => {
    // result.result = 42 (a number): toErrorRecord(42) → undefined (line 189),
    // extractNestedErrorMessage returns undefined (line 239),
    // toNonEmptyString(42) → undefined → reason = "unknown"
    mockTeamStart.mockResolvedValue(makeErrored(42));
    mockWorkflowLogs = [];
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    await expect(h(basePayload)).rejects.toThrow("unknown");
  });

  it("skips root-cause log when metadata.error is a number (lines 189 + 206)", async () => {
    // logType="AgentStatusUpdate" + metadata.error=42:
    // extractRootCauseMessage(42) → toErrorRecord(42) → undefined (line 189),
    // if (!record) → return undefined (line 206). Falls through to logDescription.
    mockWorkflowLogs = [
      {
        logType: "AgentStatusUpdate",
        metadata: { error: 42 },
        logDescription: "numeric error fallback",
      },
    ];
    mockTeamStart.mockResolvedValue(makeErrored());
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    await expect(h(basePayload)).rejects.toThrow("numeric error fallback");
  });

  // ── toErrorRecord: Error instance path (lines 173-182) ─────────────────────

  it("extracts message from an actual Error instance passed as result.result (lines 173-182, 160-161)", async () => {
    // result.result is a real Error with a cause: this triggers toErrorRecord's
    // instanceof Error branch (line 173) AND extractNestedErrorMessageFromRecord's
    // return nestedMessage branch (line 161) when the cause has a message.
    mockWorkflowLogs = [];
    const cause = new Error("root cause message");
    const errWithCause = Object.assign(new Error("outer"), { cause });
    mockTeamStart.mockResolvedValue(makeErrored(errWithCause));
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    await expect(h(basePayload)).rejects.toThrow("root cause message");
  });

  it("uses toNonEmptyString with empty string result (line 144 empty branch)", async () => {
    // result.result is a plain object with message: "" — toNonEmptyString returns
    // undefined for the empty trimmed string (line 144 false branch).
    mockWorkflowLogs = [];
    mockTeamStart.mockResolvedValue(makeErrored({ message: "" }));
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    // Falls through to "unknown" since message is empty
    await expect(h(basePayload)).rejects.toThrow("unknown");
  });

  it("uses extractRootCauseMessage at depth=0 returning undefined (line 223 depth=0 branch)", async () => {
    // extractRootCauseMessage at depth=0 returns undefined when record has no message
    // (depth=0 takes the `undefined` branch of `depth > 0 ? ... : undefined`).
    // Need a log with logType=AgentStatusUpdate but error has no extractable message.
    mockWorkflowLogs = [
      {
        logType: "AgentStatusUpdate",
        metadata: { error: { unknownField: "x" } },
      },
      { logDescription: "fallback description" },
    ];
    mockTeamStart.mockResolvedValue(makeErrored());
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    await expect(h(basePayload)).rejects.toThrow("fallback description");
  });

  it("handles undefined workflowLogs from getStore (line 254 ?? [] branch)", async () => {
    // Simulate getStore().getState() returning no workflowLogs key
    // to exercise the `state.workflowLogs ?? []` null-coalescing branch.
    // Override the Team mock just for this call.
    vi.mocked((await import("kaibanjs")).Team).mockImplementationOnce(function (
      params: Record<string, unknown>,
    ) {
      return {
        start: mockTeamStart,
        // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
        getStore: () => ({ getState: () => ({}) }), // no workflowLogs → triggers ?? []
        ...params,
      };
    } as never);
    mockTeamStart.mockResolvedValue(makeErrored(new Error("no logs")));
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    await expect(h(basePayload)).rejects.toThrow("no logs");
  });

  it("returns true for empty-string status in isSuccessfulWorkflowStatus (line 118 branch)", async () => {
    // result.status = undefined → String(undefined ?? "") = "" → !normalised = true → successful
    mockTeamStart.mockResolvedValue({
      status: undefined,
      result: "ok",
      stats: null,
    });
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    // Status undefined → treated as successful → handler resolves
    const result = await h(basePayload);
    expect(result).toBeDefined();
  });

  // ── RootCauseLog detection — logType AND agentStatus paths ───────────────

  it("treats logType=AgentStatusUpdate as root cause log", async () => {
    mockWorkflowLogs = [
      {
        logType: "AgentStatusUpdate",
        metadata: { error: "direct string error" },
      },
    ];
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    await expect(h(basePayload)).rejects.toThrow("direct string error");
  });

  it("treats agentStatus=THINKING_ERROR as root cause log", async () => {
    mockWorkflowLogs = [
      {
        agentStatus: "thinking_error", // lowercase — tested via .toUpperCase()
        metadata: { error: "thinking failed" },
      },
    ];
    const h = createKaibanTaskHandler(
      { name: "A", role: "R", goal: "G", background: "B" },
      makeDriver(),
    );
    await expect(h(basePayload)).rejects.toThrow("thinking failed");
  });
});
