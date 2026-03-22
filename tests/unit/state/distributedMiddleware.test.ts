import { describe, it, expect, vi } from "vitest";
import { DistributedStateMiddleware } from "../../../src/adapters/state/distributedMiddleware";
import { MessagePayload } from "../../../src/infrastructure/messaging/interfaces";

const mockRedis = {
  publish: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn(),
  quit: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  options: {},
};

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(function() { return mockRedis; }),
}));

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("intercepts setState and publishes to the driver", async () => {
    const mw = new DistributedStateMiddleware('redis://localhost');
    const store = makeStore({ count: 0 });
    mw.attach(store);
    await store.setState({ count: 1 });
    expect(store.state['count']).toBe(1);
    expect(mockRedis.publish).toHaveBeenCalledWith(
      "kaiban-state-events",
      expect.stringContaining('"stateUpdate":{"count":1}')
    );
  });

  it("sanitizeDelta strips PII keys", async () => {
    const mw = new DistributedStateMiddleware('redis://localhost');
    const store = makeStore();
    mw.attach(store);
    await store.setState({ count: 2, email: "x@y.com", token: "abc", password: "pw" });
    const call = mockRedis.publish.mock.calls[0];
    const parsed = JSON.parse(call[1] as string) as MessagePayload;
    const data = parsed.data['stateUpdate'] as Record<string, unknown>;
    expect(data['count']).toBe(2);
    expect(data['email']).toBeUndefined();
    expect(data['token']).toBeUndefined();
    expect(data['password']).toBeUndefined();
  });

  it("sanitizeDelta handles null partial (covers null branch)", async () => {
    const mw = new DistributedStateMiddleware('redis://localhost');
    const store = makeStore();
    mw.attach(store);
    // Trigger with null via coercion to cover `if (partial === null) return {}`
    await (store.setState as (p: unknown) => Promise<void>)(null);
    const call = mockRedis.publish.mock.calls[0];
    const parsed = JSON.parse(call[1] as string) as MessagePayload;
    expect(parsed.data['stateUpdate']).toEqual({});
  });

  it("listen() subscribes and delivers state deltas via callback", async () => {
    let capturedHandler!: (channel: string, message: string) => void;
    mockRedis.on.mockImplementation((event, handler) => {
      if (event === 'message') capturedHandler = handler;
    });
    
    const mw = new DistributedStateMiddleware('redis://localhost');
    const onStateChange = vi.fn();
    await mw.listen(onStateChange);
    
    // Simulate incoming Redis pub/sub message
    const msg = JSON.stringify({ taskId: "g", agentId: "system", timestamp: 0, data: { stateUpdate: { x: 1 } } });
    capturedHandler("kaiban-state-events", msg);
    
    expect(onStateChange).toHaveBeenCalledWith({ x: 1 });
  });

  it("listen() logs error on invalid json payload", async () => {
    let capturedHandler!: (channel: string, message: string) => void;
    mockRedis.on.mockImplementation((event, handler) => {
      if (event === 'message') capturedHandler = handler;
    });

    const mw = new DistributedStateMiddleware('redis://localhost');
    const onStateChange = vi.fn();
    await mw.listen(onStateChange);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    capturedHandler("kaiban-state-events", "invalid json");

    expect(errSpy).toHaveBeenCalledWith("[DistributedStateMiddleware] Failed to parse message:", expect.any(SyntaxError));
    errSpy.mockRestore();
  });

  it("disconnect() calls redis quit", async () => {
    const mw = new DistributedStateMiddleware('redis://localhost');
    await mw.disconnect();
    expect(mockRedis.quit).toHaveBeenCalled();
  });

  it("publish error is caught and logged without throwing", async () => {
    mockRedis.publish.mockRejectedValueOnce(new Error("redis down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mw = new DistributedStateMiddleware('redis://localhost');
    const store = makeStore();
    mw.attach(store);
    await expect(store.setState({ x: 1 })).resolves.not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("sanitizeDelta handles empty state update", async () => {
    const mw = new DistributedStateMiddleware('redis://localhost');
    const store = makeStore();
    mw.attach(store);
    await store.setState({});
    expect(mockRedis.publish).toHaveBeenCalledOnce();
  });
});
