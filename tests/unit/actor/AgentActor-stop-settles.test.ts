/**
 * AgentActor — stop() settles a task whose handler ignores its signal (ACT-07),
 * and a handler that throws synchronously leaves nothing in flight (ACT-V-04).
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
import type {
  IMessagingDriver,
  MessagePayload,
} from "../../../src/infrastructure/messaging/interfaces";

function makeDriver(): {
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

const task = (taskId: string): MessagePayload => ({
  taskId,
  agentId: "agent-1",
  data: { instruction: "do" },
  timestamp: Date.now() + 1_000_000,
});

beforeEach(() => vi.clearAllMocks());

describe("AgentActor.stop() with a handler that ignores its signal", () => {
  it("settles the task at once and dead-letters it as actor_stopped; the late result is not published", async () => {
    const { driver, deliver, published } = makeDriver();
    let finish: (v: string) => void = () => undefined;
    const handler = vi.fn(() => new Promise<string>((r) => (finish = r))); // deaf
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();

    let settled = false;
    const run = deliver(task("t1")).then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 5));
    await actor.stop();
    await run;
    expect(settled).toBe(true);
    expect(published("kaiban-events-failed")[0]?.data).toMatchObject({
      error: "actor_stopped",
    });

    finish("late");
    await new Promise((r) => setTimeout(r, 5));
    expect(published("kaiban-events-completed")).toEqual([]);
  });
});

describe("AgentActor — a handler that throws synchronously", () => {
  it("leaves no controller in flight, so STOP ALL aborts nothing", async () => {
    const { driver, deliver } = makeDriver();
    const handler = vi.fn(() => {
      throw new Error("bad input");
    });
    const actor = new AgentActor("agent-1", driver, "q", handler as never);
    await actor.start();
    await deliver(task("t1"));
    expect(handler).toHaveBeenCalledTimes(3); // three attempts, none leaked
    expect(actor.emergencyStop(Date.now() + 2_000_000)).toEqual({
      outcome: "applied",
      aborted: 0,
    });
  });
});

describe("AgentActor — a task without a numeric timestamp after a STOP ALL", () => {
  it("is refused (fail closed) and dead-lettered as emergency_stop, handler not called", async () => {
    const { driver, deliver, published } = makeDriver();
    const handler = vi.fn(async () => "ran");
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    actor.emergencyStop(1_000);
    const bad = {
      ...task("t-nots"),
      timestamp: undefined as unknown as number,
    };
    await deliver(bad);
    expect(handler).not.toHaveBeenCalled();
    expect(published("kaiban-events-failed")[0]?.data).toMatchObject({
      error: "emergency_stop",
    });
  });

  it("still runs before any STOP ALL has been issued", async () => {
    const { driver, deliver } = makeDriver();
    const handler = vi.fn(async () => "ran");
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    await deliver({ ...task("t-nots"), timestamp: Number.NaN });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
