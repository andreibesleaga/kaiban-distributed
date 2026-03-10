import { describe, it, expect, vi } from "vitest";
import { AgentActor } from "../../../src/application/actor/AgentActor";
import { IMessagingDriver, MessagePayload } from "../../../src/infrastructure/messaging/interfaces";

function makeMockDriver(): IMessagingDriver {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCapturingDriver(): { driver: IMessagingDriver; getHandler: () => (p: MessagePayload) => Promise<void> } {
  let h!: (p: MessagePayload) => Promise<void>;
  const driver: IMessagingDriver = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((_q, handler) => { h = handler; return Promise.resolve(); }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return { driver, getHandler: () => h };
}

describe("AgentActor", () => {
  it("subscribes to the correct queue on start", async () => {
    const d = makeMockDriver();
    const actor = new AgentActor("agent-1", d, "q");
    await actor.start();
    expect(d.subscribe).toHaveBeenCalledWith("q", expect.any(Function));
  });

  it("processes a matching task (with default executeTask) and publishes completion", async () => {
    const { driver, getHandler } = makeCapturingDriver();
    // No custom handler → uses default delay-based execute
    const actor = new AgentActor("agent-1", driver, "q");
    await actor.start();
    await getHandler()({ taskId: "t", agentId: "agent-1", data: {}, timestamp: 0 });
    expect(driver.publish).toHaveBeenCalledWith("kaiban-events-completed", expect.objectContaining({ taskId: "t" }));
  });

  it("processes a task with custom taskHandler", async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const customHandler = vi.fn().mockResolvedValue(undefined);
    const actor = new AgentActor("agent-1", driver, "q", customHandler);
    await actor.start();
    await getHandler()({ taskId: "t2", agentId: "agent-1", data: {}, timestamp: 0 });
    expect(customHandler).toHaveBeenCalledOnce();
    expect(driver.publish).toHaveBeenCalledWith("kaiban-events-completed", expect.objectContaining({ taskId: "t2" }));
  });

  it("stop() calls driver.unsubscribe(), NOT driver.disconnect()", async () => {
    const d = makeMockDriver();
    const actor = new AgentActor("agent-1", d, "q");
    await actor.start();
    await actor.stop();
    expect(d.unsubscribe).toHaveBeenCalledWith("q");
    expect(d.disconnect).not.toHaveBeenCalled();
  });

  it("retries processTask up to 3 times on failure then publishes to DLQ", async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const failHandler = vi.fn().mockRejectedValue(new Error("fail"));
    const actor = new AgentActor("agent-1", driver, "q", failHandler);
    await actor.start();
    await getHandler()({ taskId: "tf", agentId: "agent-1", data: {}, timestamp: 0 });
    expect(failHandler).toHaveBeenCalledTimes(3);
    expect(driver.publish).toHaveBeenCalledWith("kaiban-events-failed", expect.objectContaining({ taskId: "tf", data: expect.objectContaining({ status: "failed" }) }));
  });

  it("does not log raw agentId in console output", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const d = makeMockDriver();
    const actor = new AgentActor("agent-secret-id", d, "q");
    await actor.start();
    await actor.stop();
    for (const log of logSpy.mock.calls.map((c) => c.join(" "))) {
      expect(log).not.toContain("agent-secret-id");
    }
    logSpy.mockRestore();
  });

  it("ignores a task addressed to a different agent", async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const actor = new AgentActor("agent-1", driver, "q");
    await actor.start();
    await getHandler()({ taskId: "t", agentId: "other", data: {}, timestamp: 0 });
    expect(driver.publish).not.toHaveBeenCalled();
  });

  it("processes a wildcard task (agentId = *)", async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const actor = new AgentActor("agent-1", driver, "q");
    await actor.start();
    await getHandler()({ taskId: "t", agentId: "*", data: {}, timestamp: 0 });
    expect(driver.publish).toHaveBeenCalledWith("kaiban-events-completed", expect.anything());
  });

  it("catches non-Error rejections and converts to string (covers errMsg = String(err) branch)", async () => {
    const { driver, getHandler } = makeCapturingDriver();
    // Non-Error rejection — exercises the String(err) path
    const failHandler = vi.fn().mockRejectedValue('plain string error');
    const actor = new AgentActor("agent-1", driver, "q", failHandler);
    await actor.start();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await getHandler()({ taskId: "t", agentId: "agent-1", timestamp: 0, data: {} });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('plain string error'));
    errSpy.mockRestore();
  });
});