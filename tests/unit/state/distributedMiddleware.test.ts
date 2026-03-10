import { describe, it, expect, vi } from "vitest";
import { DistributedStateMiddleware } from "../../../src/adapters/state/distributedMiddleware";
import { IMessagingDriver, MessagePayload } from "../../../src/infrastructure/messaging/interfaces";

function makeMockDriver(): IMessagingDriver {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

interface MockStore {
  state: Record<string, unknown>;
  setState: (partial: Record<string, unknown>, replace?: boolean) => void;
}

function makeStore(initial: Record<string, unknown> = {}): MockStore {
  return {
    state: initial,
    setState(partial: Record<string, unknown>): void { this.state = { ...this.state, ...partial }; },
  };
}

describe("DistributedStateMiddleware", () => {
  it("intercepts setState and publishes to the driver", async () => {
    const mockDriver = makeMockDriver();
    const mw = new DistributedStateMiddleware(mockDriver);
    const store = makeStore({ count: 0 });
    mw.attach(store);
    await store.setState({ count: 1 });
    expect(store.state['count']).toBe(1);
    expect(mockDriver.publish).toHaveBeenCalledWith("kaiban-state-events", expect.objectContaining({ data: { stateUpdate: { count: 1 } } }));
  });

  it("sanitizeDelta strips PII keys", async () => {
    const mockDriver = makeMockDriver();
    const mw = new DistributedStateMiddleware(mockDriver);
    const store = makeStore();
    mw.attach(store);
    await store.setState({ count: 2, email: "x@y.com", token: "abc", password: "pw" });
    const call = (mockDriver.publish as ReturnType<typeof vi.fn>).mock.calls[0];
    const data = call[1].data.stateUpdate as Record<string, unknown>;
    expect(data['count']).toBe(2);
    expect(data['email']).toBeUndefined();
    expect(data['token']).toBeUndefined();
    expect(data['password']).toBeUndefined();
  });

  it("sanitizeDelta handles null partial (covers null branch)", async () => {
    const mockDriver = makeMockDriver();
    const mw = new DistributedStateMiddleware(mockDriver);
    const store = makeStore();
    mw.attach(store);
    // Trigger with null via coercion to cover `if (partial === null) return {}`
    await (store.setState as (p: unknown) => Promise<void>)(null);
    const call = (mockDriver.publish as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].data.stateUpdate).toEqual({});
  });

  it("listen() subscribes and delivers state deltas via callback", async () => {
    let capturedHandler!: (payload: MessagePayload) => Promise<void>;
    const mockDriver: IMessagingDriver = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn((_q, handler) => { capturedHandler = handler; return Promise.resolve(); }),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const mw = new DistributedStateMiddleware(mockDriver);
    const onStateChange = vi.fn();
    await mw.listen(onStateChange);
    await capturedHandler({ taskId: "g", agentId: "system", timestamp: 0, data: { stateUpdate: { x: 1 } } });
    expect(onStateChange).toHaveBeenCalledWith({ x: 1 });
  });

  it("publish error is caught and logged without throwing", async () => {
    const mockDriver: IMessagingDriver = {
      publish: vi.fn().mockRejectedValue(new Error("redis down")),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mw = new DistributedStateMiddleware(mockDriver);
    const store = makeStore();
    mw.attach(store);
    await expect(store.setState({ x: 1 })).resolves.not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("sanitizeDelta handles empty state update", async () => {
    const mockDriver = makeMockDriver();
    const mw = new DistributedStateMiddleware(mockDriver);
    const store = makeStore();
    mw.attach(store);
    await store.setState({});
    expect(mockDriver.publish).toHaveBeenCalledOnce();
  });
});
