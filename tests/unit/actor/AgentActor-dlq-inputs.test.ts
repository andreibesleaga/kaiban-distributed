/**
 * AgentActor — a dead-letter record carries the task's original inputs, so
 * `replayDlq` can re-run the same task instead of an empty one. When the
 * inputs would push the record past the 64 KB publish cap they are left out
 * and the record says so (`_inputs_omitted`), and replay skips it.
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

import { AgentActor } from "../../../src/application/actor/AgentActor";
import { BudgetExceededError } from "../../../src/shared/budget";
import { replayDlq } from "../../../src/resilience/dlq-replay";
import type {
  IMessagingDriver,
  MessagePayload,
} from "../../../src/infrastructure/messaging/interfaces";

function makeCapturingDriver(): {
  driver: IMessagingDriver;
  deliver: (p: MessagePayload) => Promise<void>;
  published: (channel: string) => MessagePayload[];
} {
  let h!: (p: MessagePayload) => Promise<void>;
  const driver: IMessagingDriver = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((_q, handler) => {
      h = handler;
      return Promise.resolve();
    }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return {
    driver,
    deliver: (p) => h(p),
    published: (channel) =>
      (driver.publish as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: unknown[]) => c[0] === channel)
        .map((c: unknown[]) => c[1] as MessagePayload),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentActor — DLQ records keep the original inputs", () => {
  it("a per-agent budget breach keeps the inputs, and a replay republishes them unchanged", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const handler = vi
      .fn()
      .mockRejectedValue(
        new BudgetExceededError(
          "Token budget exceeded: 600 >= 500",
          "token_budget_exceeded",
        ),
      );
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();

    const inputs = {
      instruction: "summarise",
      context: "ctx",
      workflowId: "wf-1",
    };
    await deliver({
      taskId: "t-in",
      agentId: "agent-1",
      data: inputs,
      timestamp: 0,
    });

    const dlq = published("kaiban-events-failed");
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.data).toMatchObject({
      ...inputs,
      status: "failed",
      error: "token_budget_exceeded",
    });
    expect(dlq[0]!.data["_inputs_omitted"]).toBeUndefined();

    const replayDriver = makeCapturingDriver();
    const result = await replayDlq({
      driver: replayDriver.driver,
      records: [{ payload: dlq[0]! }],
    });
    expect(result.replayed).toBe(1);
    const replayed = (replayDriver.driver.publish as ReturnType<typeof vi.fn>)
      .mock.calls[0]![1] as MessagePayload;
    expect(replayed.data).toEqual(inputs);
  });

  it("retries-exhausted failures keep the inputs too", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const handler = vi.fn().mockRejectedValue(new Error("transient"));
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    await deliver({
      taskId: "t-ex",
      agentId: "agent-1",
      data: { instruction: "do" },
      timestamp: 0,
    });
    expect(published("kaiban-events-failed")[0]!.data).toMatchObject({
      instruction: "do",
      status: "failed",
      error: "transient",
    });
  });

  it("inputs that would exceed the 64 KB cap are left out and the record is marked", async () => {
    const { driver, deliver, published } = makeCapturingDriver();
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    await deliver({
      taskId: "t-big",
      agentId: "agent-1",
      data: { instruction: "x".repeat(70_000) },
      timestamp: 0,
    });
    const rec = published("kaiban-events-failed")[0]!;
    expect(rec.data).toMatchObject({
      status: "failed",
      error: "boom",
      _inputs_omitted: true,
    });
    expect(rec.data["instruction"]).toBeUndefined();
    expect(
      Buffer.byteLength(JSON.stringify(rec.data), "utf8"),
    ).toBeLessThanOrEqual(65_536);
  });
});
