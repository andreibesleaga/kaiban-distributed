/**
 * AgentStatePublisher.wrapHandler — a result that arrives after its attempt was
 * ended (task timeout, node stop) never shows as DONE and never resets the
 * agent to IDLE while a newer attempt is running.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
import type { MessagePayload } from "../../../src/infrastructure/messaging/interfaces";

const mockPublish = vi.fn().mockResolvedValue(1);
vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { publish: mockPublish, quit: vi.fn().mockResolvedValue("OK") };
  }),
}));

interface Delta {
  agents?: { status: string; currentTaskId: string | null }[];
  tasks?: { taskId: string; status: string }[];
}
const deltas = (): Delta[] =>
  mockPublish.mock.calls.map((c) => JSON.parse(c[1] as string) as Delta);
const payload = (taskId: string): MessagePayload => ({
  taskId,
  agentId: "a",
  timestamp: 0,
  data: { instruction: "do it" },
});

describe("wrapHandler — late results", () => {
  let publisher: AgentStatePublisher;
  beforeEach(() => {
    vi.clearAllMocks();
    publisher = new AgentStatePublisher("redis://x", {
      agentId: "a",
      name: "A",
      role: "r",
    });
  });

  it("a late result after a timeout abort is not DONE and does not reset a newer attempt to IDLE", async () => {
    let finishOld: (v: string) => void = () => undefined;
    const handler = vi
      .fn()
      .mockImplementationOnce(() => new Promise<string>((r) => (finishOld = r)))
      .mockImplementationOnce(() => new Promise<string>(() => undefined));
    const wrapped = publisher.wrapHandler(handler);

    const oldAbort = new AbortController();
    const oldRun = wrapped(payload("t1"), oldAbort.signal).catch(
      (e: unknown) => e,
    );
    oldAbort.abort(new Error("task_timeout"));
    void wrapped(payload("t2"), new AbortController().signal); // t2 takes over

    finishOld("late");
    const outcome = await oldRun;

    expect((outcome as Error).message).toBe("task_timeout");
    const all = deltas();
    expect(
      all
        .flatMap((d) => d.tasks ?? [])
        .filter((t) => t.taskId === "t1" && t.status === "DONE"),
    ).toEqual([]);
    const last = all.flatMap((d) => d.agents ?? []).at(-1)!;
    expect(last).toMatchObject({ status: "THINKING", currentTaskId: "t2" });
    // The old task's card is closed, without touching the agent row.
    const closing = all.filter((d) =>
      (d.tasks ?? []).some((t) => t.taskId === "t1" && t.status === "BLOCKED"),
    );
    expect(closing).toHaveLength(1);
    expect(closing[0]!.agents).toBeUndefined();
  });

  it("a superseded attempt of the same task publishes nothing: the retry owns the card", async () => {
    let finishOld: (v: string) => void = () => undefined;
    const handler = vi
      .fn()
      .mockImplementationOnce(() => new Promise<string>((r) => (finishOld = r)))
      .mockImplementationOnce(() => new Promise<string>(() => undefined));
    const wrapped = publisher.wrapHandler(handler);
    const oldAbort = new AbortController();
    const oldRun = wrapped(payload("t1"), oldAbort.signal).catch(
      (e: unknown) => e,
    );
    oldAbort.abort(new Error("task_timeout"));
    void wrapped(payload("t1"), new AbortController().signal); // retry of t1
    const before = mockPublish.mock.calls.length;
    finishOld("late");
    await oldRun;
    expect(mockPublish.mock.calls.length).toBe(before);
  });

  it("a late result of the only attempt is reported as a failed task, not DONE", async () => {
    let finish: (v: string) => void = () => undefined;
    const wrapped = publisher.wrapHandler(
      () => new Promise<string>((r) => (finish = r)),
    );
    const ac = new AbortController();
    const run = wrapped(payload("t1"), ac.signal).catch((e: unknown) => e);
    ac.abort(new Error("task_timeout"));
    finish("late");
    await run;
    const statuses = deltas()
      .flatMap((d) => d.tasks ?? [])
      .map((t) => t.status);
    expect(statuses).not.toContain("DONE");
    expect(statuses).toContain("BLOCKED");
  });
});
