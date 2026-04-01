/**
 * AgentActor — console.warn when taskHandler is missing.
 *
 * Covers: start() warning for missing taskHandler, warning message content,
 * warning appears before subscribe, and that actor still functions normally.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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

describe("AgentActor — console.warn when taskHandler is missing", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("logs console.warn on start() when no taskHandler is provided", async () => {
    const d = {
      publish: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn(),
      disconnect: vi.fn(),
    };
    const actor = new AgentActor("agent-1", d, "q");
    await actor.start();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("silently dropped");
  });

  it("warn message contains sanitised (hashed) agent ID, not raw ID", async () => {
    const d = {
      publish: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn(),
      disconnect: vi.fn(),
    };
    const rawId = "super-secret-agent-id";
    const actor = new AgentActor(rawId, d, "q");
    await actor.start();
    expect(warnSpy.mock.calls[0][0]).not.toContain(rawId);
  });

  it("does NOT log console.warn when a taskHandler IS provided", async () => {
    const d = {
      publish: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn(),
      disconnect: vi.fn(),
    };
    const actor = new AgentActor("agent-1", d, "q", vi.fn());
    await actor.start();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("actor still subscribes to queue even without taskHandler", async () => {
    const d = {
      publish: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn(),
      disconnect: vi.fn(),
    };
    const actor = new AgentActor("agent-1", d, "q");
    await actor.start();
    expect(d.subscribe).toHaveBeenCalledWith("q", expect.any(Function));
  });

  it("actor without taskHandler still publishes to completed queue (uses null result)", async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const actor = new AgentActor("agent-1", driver, "q"); // no taskHandler
    await actor.start();
    await getHandler()({
      taskId: "t",
      agentId: "agent-1",
      data: {},
      timestamp: 0,
    });
    expect(driver.publish).toHaveBeenCalledWith(
      "kaiban-events-completed",
      expect.objectContaining({ taskId: "t" }),
    );
  });
});

describe("AgentActor — wildcard agentId (*) routing", () => {
  it("processes task when agentId is * regardless of actor id", async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue("wildcard-result");
    const actor = new AgentActor("specific-agent", driver, "q", handler);
    await actor.start();
    await getHandler()({ taskId: "wt", agentId: "*", data: {}, timestamp: 0 });
    expect(handler).toHaveBeenCalledOnce();
    expect(driver.publish).toHaveBeenCalledWith(
      "kaiban-events-completed",
      expect.objectContaining({ taskId: "wt" }),
    );
  });

  it("ignores task when agentId is different (non-wildcard)", async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn();
    const actor = new AgentActor("agent-a", driver, "q", handler);
    await actor.start();
    await getHandler()({
      taskId: "xt",
      agentId: "agent-b",
      data: {},
      timestamp: 0,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(driver.publish).not.toHaveBeenCalled();
  });
});

describe("AgentActor — taskHandler result propagation", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("includes taskHandler return value in completed event data.result", async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue("final blog post content");
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    await getHandler()({
      taskId: "r1",
      agentId: "agent-1",
      data: {},
      timestamp: 0,
    });
    const call = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "kaiban-events-completed",
    );
    expect(call![1].data.result).toBe("final blog post content");
  });

  it("includes default success result when taskHandler returns undefined", async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue(undefined);
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    await getHandler()({
      taskId: "r2",
      agentId: "agent-1",
      data: {},
      timestamp: 0,
    });
    const call = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "kaiban-events-completed",
    );
    expect(call![1].data.status).toBe("success");
  });

  it("non-Error rejection is stringified in DLQ error field", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { driver, getHandler } = makeCapturingDriver();
    // Reject with a plain string (not an Error object)
    const handler = vi.fn().mockRejectedValue("string-error-message");
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    await getHandler()({
      taskId: "err",
      agentId: "agent-1",
      data: {},
      timestamp: 0,
    });
    const dlqCall = (
      driver.publish as ReturnType<typeof vi.fn>
    ).mock.calls.find((c: unknown[]) => c[0] === "kaiban-events-failed");
    expect(dlqCall![1].data.error).toBe("string-error-message");
  });

  it("completed event includes correct agentId (not hashed)", async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue("done");
    const actor = new AgentActor("agent-pub", driver, "q", handler);
    await actor.start();
    await getHandler()({
      taskId: "x",
      agentId: "agent-pub",
      data: {},
      timestamp: 0,
    });
    const call = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "kaiban-events-completed",
    );
    // The agentId in the published event is the raw actor id (not hashed)
    expect(call![1].agentId).toBe("agent-pub");
  });

  it("DLQ event includes taskId and agentId matching the original task", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockRejectedValue(new Error("fail"));
    const actor = new AgentActor("agent-q", driver, "q", handler);
    await actor.start();
    await getHandler()({
      taskId: "dlq-task",
      agentId: "agent-q",
      data: {},
      timestamp: 0,
    });
    const dlqCall = (
      driver.publish as ReturnType<typeof vi.fn>
    ).mock.calls.find((c: unknown[]) => c[0] === "kaiban-events-failed");
    expect(dlqCall![1].taskId).toBe("dlq-task");
    expect(dlqCall![1].agentId).toBe("agent-q");
  });
});

describe("AgentActor — data field on payload", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("passes full data object to taskHandler", async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const received: MessagePayload[] = [];
    const handler = vi.fn().mockImplementation((p: MessagePayload) => {
      received.push(p);
      return Promise.resolve("ok");
    });
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    const data = {
      instruction: "Write a poem",
      context: "Previous drafts...",
      inputs: { style: "haiku" },
    };
    await getHandler()({
      taskId: "t",
      agentId: "agent-1",
      data,
      timestamp: 999,
    });
    expect(received[0].data).toEqual(data);
    expect(received[0].timestamp).toBe(999);
  });
});
