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
