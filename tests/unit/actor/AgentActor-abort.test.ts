/**
 * AgentActor — Finding #2 guard: timeout / shutdown must ABORT in-flight work.
 *
 * `executeTask` used to race the handler against a timeout but never cancel the
 * handler, so a timed-out LLM call kept running (and burning tokens) to
 * completion. The actor now passes an AbortSignal into the handler and aborts it
 * on timeout and on stop().
 *
 * Guard (master plan §B8 Phase 1.2 / ADR-014):
 *   - handler receives a non-aborted AbortSignal
 *   - on timeout the signal is aborted (token spend can stop)
 *   - on stop() any in-flight signal is aborted
 */
import { describe, it, expect, vi } from "vitest";

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
import type {
  IMessagingDriver,
  MessagePayload,
} from "../../../src/infrastructure/messaging/interfaces";

function makeCapturingDriver(): {
  driver: IMessagingDriver;
  getHandler: () => (p: MessagePayload) => Promise<void>;
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
  return { driver, getHandler: () => h };
}

const payload: MessagePayload = {
  taskId: "t",
  agentId: "agent-1",
  data: {},
  timestamp: 0,
};

describe("AgentActor — AbortSignal cancellation", () => {
  it("passes a non-aborted AbortSignal into the handler", async () => {
    const { driver, getHandler } = makeCapturingDriver();
    let received: AbortSignal | undefined;
    const handler = vi.fn(async (_p: MessagePayload, signal: AbortSignal | undefined) => {
      received = signal;
      return "ok";
    });
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    await getHandler()(payload);
    expect(received).toBeInstanceOf(AbortSignal);
    expect(received!.aborted).toBe(false);
  });

  it("aborts the handler's signal when the task times out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { driver, getHandler } = makeCapturingDriver();
    let abortedDuringRun = false;
    // Handler that never resolves on its own; it only settles when aborted —
    // proving the actor's timeout fires the signal (token spend can stop).
    const handler = vi.fn(
      (_p: MessagePayload, signal: AbortSignal | undefined) =>
        new Promise<unknown>((_resolve, reject) => {
          signal!.addEventListener("abort", () => {
            abortedDuringRun = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      taskTimeoutMs: 5,
    });
    await actor.start();
    await getHandler()(payload);
    expect(abortedDuringRun).toBe(true);
    // After retries exhaust, the task is DLQ'd.
    expect(driver.publish).toHaveBeenCalledWith(
      "kaiban-events-failed",
      expect.objectContaining({ taskId: "t" }),
    );
  });

  it("aborts in-flight work when the actor stops", async () => {
    const { driver, getHandler } = makeCapturingDriver();
    let signalSeen!: AbortSignal;
    let releaseHandler!: () => void;
    const handler = vi.fn(
      (_p: MessagePayload, signal: AbortSignal | undefined) =>
        new Promise<unknown>((resolve) => {
          signalSeen = signal!;
          releaseHandler = (): void => resolve("done");
        }),
    );
    const actor = new AgentActor("agent-1", driver, "q", handler, {
      taskTimeoutMs: 60_000,
    });
    await actor.start();
    // Kick off a task but don't await it — it parks until released.
    const running = getHandler()(payload);
    await Promise.resolve();
    expect(signalSeen.aborted).toBe(false);
    await actor.stop();
    expect(signalSeen.aborted).toBe(true);
    releaseHandler();
    await running;
  });
});
