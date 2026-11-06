/**
 * AgentStatePublisher — tasks ended by an emergency STOP ALL show as `STOPPED`
 * (roadmap §6.10 ES-1, ES-2, ES-12; ADR-025): never `BLOCKED`/`ERROR`, and a
 * late result from a handler that ignored its signal never shows as `DONE`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../../src/shared/structured-logger", () => ({
  createStructuredLogger: (): typeof mockLog => mockLog,
  logger: mockLog,
  resolveLogLevel: (): string => "silent",
}));

import { AgentStatePublisher } from "../../../src/adapters/state/agent-state-publisher";
import { EmergencyStopError } from "../../../src/domain/errors/DomainError";
import type { MessagePayload } from "../../../src/infrastructure/messaging/interfaces";

const mockPublish = vi.fn().mockResolvedValue(1);
const mockQuit = vi.fn().mockResolvedValue("OK");

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { publish: mockPublish, quit: mockQuit };
  }),
}));

interface Delta {
  agents?: { agentId: string; status: string; currentTaskId: string | null }[];
  tasks?: { taskId: string; title: string; status: string }[];
}

const deltas = (): Delta[] =>
  mockPublish.mock.calls.map((c) => JSON.parse(c[1] as string) as Delta);
const taskStatuses = (taskId: string): string[] =>
  deltas()
    .flatMap((d) => d.tasks ?? [])
    .filter((t) => t.taskId === taskId)
    .map((t) => t.status);
const lastAgentStatus = (): string | undefined =>
  deltas()
    .flatMap((d) => d.agents ?? [])
    .at(-1)?.status;

const agentInfo = { agentId: "researcher", name: "Ava", role: "Researcher" };
const payload = (taskId: string): MessagePayload => ({
  taskId,
  agentId: "researcher",
  timestamp: 0,
  data: { instruction: "Research the topic" },
});

describe("AgentStatePublisher — emergency stop", () => {
  let publisher: AgentStatePublisher;

  beforeEach(() => {
    vi.clearAllMocks();
    publisher = new AgentStatePublisher("redis://localhost:6379", agentInfo);
  });

  afterEach(async () => {
    await publisher.disconnect().catch(() => {});
    vi.useRealTimers();
  });

  it("a handler ended by EmergencyStopError publishes task STOPPED and agent IDLE, and rethrows", async () => {
    const stop = new EmergencyStopError();
    const wrapped = publisher.wrapHandler(vi.fn().mockRejectedValue(stop));

    await expect(wrapped(payload("t-1"))).rejects.toBe(stop);

    expect(taskStatuses("t-1")).toEqual(["DOING", "STOPPED"]);
    expect(taskStatuses("t-1")).not.toContain("BLOCKED");
    expect(lastAgentStatus()).toBe("IDLE");
  });

  it("a late result after an emergency abort never shows as DONE (ES-12)", async () => {
    const controller = new AbortController();
    const handler = vi.fn(async () => {
      controller.abort(new EmergencyStopError());
      return { answer: "late", inputTokens: 5, outputTokens: 5, estimatedCost: 0.01 };
    });
    const wrapped = publisher.wrapHandler(handler);

    await expect(wrapped(payload("t-2"), controller.signal)).rejects.toBeInstanceOf(
      EmergencyStopError,
    );
    expect(taskStatuses("t-2")).toEqual(["DOING", "STOPPED"]);
    expect(lastAgentStatus()).toBe("IDLE");
    // The spent tokens still count against the caps.
    expect(publisher.getTotalTokensUsed()).toBe(10);
  });

  it("a late result with no usage after an emergency abort counts nothing", async () => {
    const controller = new AbortController();
    const wrapped = publisher.wrapHandler(async () => {
      controller.abort(new EmergencyStopError());
      return "plain";
    });
    await expect(wrapped(payload("t-2b"), controller.signal)).rejects.toBeInstanceOf(
      EmergencyStopError,
    );
    expect(publisher.getTotalTokensUsed()).toBe(0);
  });

  it("a late plain failure after an emergency abort shows STOPPED, never BLOCKED/ERROR", async () => {
    const controller = new AbortController();
    const wrapped = publisher.wrapHandler(async () => {
      controller.abort(new EmergencyStopError());
      throw new Error("provider said no");
    });
    await expect(wrapped(payload("t-6"), controller.signal)).rejects.toBeInstanceOf(EmergencyStopError);
    expect(taskStatuses("t-6")).toEqual(["DOING", "STOPPED"]);
    expect(lastAgentStatus()).toBe("IDLE");
  });

  it("a late paid failure after an emergency abort still counts its tokens", async () => {
    const { FailedAttemptError } = await import("../../../src/domain/errors/DomainError");
    const controller = new AbortController();
    const wrapped = publisher.wrapHandler(async () => {
      controller.abort(new EmergencyStopError());
      throw new FailedAttemptError("blocked", { inputTokens: 4, outputTokens: 3, estimatedCost: 0 });
    });
    await expect(wrapped(payload("t-7"), controller.signal)).rejects.toBeInstanceOf(EmergencyStopError);
    expect(publisher.getTotalTokensUsed()).toBe(7);
    expect(taskStatuses("t-7")).not.toContain("BLOCKED");
  });

  it("a late result after a timeout abort is not published as DONE (ACT-06)", async () => {
    const controller = new AbortController();
    const reason = new Error("timeout");
    const handler = vi.fn(async () => {
      controller.abort(reason);
      return { text: "late", usage: { inputTokens: 2, outputTokens: 3 } };
    });
    const wrapped = publisher.wrapHandler(handler);

    await expect(wrapped(payload("t-3"), controller.signal)).rejects.toBe(reason);
    expect(taskStatuses("t-3")).not.toContain("DONE");
  });

  it("publishStopped() for the running task publishes task STOPPED and agent IDLE; the heartbeat says IDLE", async () => {
    vi.useFakeTimers();
    publisher.publishIdle(1_000);
    let finish!: () => void;
    const wrapped = publisher.wrapHandler(
      () => new Promise<string>((r) => (finish = (): void => r("x"))),
    );
    const running = wrapped(payload("t-4")).catch(() => undefined);
    await Promise.resolve();

    publisher.publishStopped(payload("t-4"));
    expect(taskStatuses("t-4").at(-1)).toBe("STOPPED");
    expect(lastAgentStatus()).toBe("IDLE");
    const stopped = deltas().flatMap((d) => d.tasks ?? []).find((t) => t.status === "STOPPED");
    expect(stopped?.title).toBe("Research the topic");

    mockPublish.mockClear();
    vi.advanceTimersByTime(1_001);
    expect(lastAgentStatus()).toBe("IDLE");
    finish();
    await running;
  });

  it("publishStopped() for a task that never ran publishes only the task", () => {
    publisher.publishStopped({ ...payload("t-5"), data: {} });
    const last = deltas().at(-1)!;
    expect(last.tasks).toEqual([
      expect.objectContaining({ taskId: "t-5", status: "STOPPED", title: "t-5" }),
    ]);
    expect(last.agents).toBeUndefined();
  });

  it("publishControlAck() publishes the ack as a `control` delta (ES-9)", () => {
    const ack = {
      commandId: "c-1",
      issuedAt: 1_000,
      issuedBy: "operator",
      reason: "runaway",
      nodeId: "host:1",
      agentId: "researcher",
      outcome: "applied" as const,
      aborted: 2,
      at: 1_005,
    };
    publisher.publishControlAck(ack);
    const last = JSON.parse(mockPublish.mock.calls.at(-1)![1] as string) as Record<string, unknown>;
    expect(last).toEqual({ control: ack });
  });
});
