/**
 * SocketGateway — HITL decision validation edge cases.
 *
 * Tests the hitl:decision socket event handler for malformed, invalid, and
 * duplicate payloads to ensure robust validation at the gateway boundary.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "http";
import type Redis from "ioredis";
import { SocketGateway } from "../../../src/adapters/gateway/SocketGateway";

const mockSubscribe = vi.fn().mockResolvedValue(undefined);
const mockRedisOn = vi.fn();
const mockQuit = vi.fn().mockResolvedValue(undefined);
const mockPublish = vi.fn().mockResolvedValue(1);
const mockRedisSubscriber = {
  subscribe: mockSubscribe,
  on: mockRedisOn,
  quit: mockQuit,
};
const mockLpush = vi.fn().mockResolvedValue(1);
const mockExpire = vi.fn().mockResolvedValue(1);
const mockRedisPublisher = {
  publish: mockPublish,
  quit: mockQuit,
  lpush: mockLpush,
  expire: mockExpire,
};
const redisSubscriber = mockRedisSubscriber as unknown as Redis;
const redisPublisher = mockRedisPublisher as unknown as Redis;

const mockEmit = vi.fn();
const mockIoClose = vi.fn().mockImplementation((cb?: () => void) => {
  if (cb) cb();
});

let connectionHandler: ((socket: MockSocket) => void) | null = null;

interface MockSocket {
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  data: Record<string, unknown>;
}

function makeMockSocket(): MockSocket {
  return { emit: vi.fn(), on: vi.fn(), data: {} };
}

const mockIoOn = vi
  .fn()
  .mockImplementation((event: string, cb: (socket: MockSocket) => void) => {
    if (event === "connection") connectionHandler = cb;
  });

vi.mock("socket.io", () => ({
  Server: vi.fn().mockImplementation(function () {
    return {
      adapter: vi.fn(),
      emit: mockEmit,
      close: mockIoClose,
      on: mockIoOn,
      use: vi.fn(),
    };
  }),
}));
vi.mock("@socket.io/redis-adapter", () => ({
  createAdapter: vi.fn().mockReturnValue("mock-redis-adapter"),
}));

describe("SocketGateway — HITL edge cases", () => {
  let sg: SocketGateway;
  const httpServer = createServer();

  beforeEach(() => {
    vi.clearAllMocks();
    connectionHandler = null;
    sg = new SocketGateway(httpServer, redisPublisher, redisSubscriber);
    sg.initialize();
  });

  afterEach(async () => {
    await sg.shutdown();
  });

  function getHitlHandler(
    socket: MockSocket,
  ): (
    payload: unknown,
    ack?: (r: { ok: boolean; error?: string }) => void,
  ) => void {
    const calls = socket.on.mock.calls as Array<
      [string, (...args: unknown[]) => void]
    >;
    const hitlCall = calls.find((c) => c[0] === "hitl:decision");
    return hitlCall![1] as (
      payload: unknown,
      ack?: (r: { ok: boolean; error?: string }) => void,
    ) => void;
  }

  function connectSocket(): {
    socket: MockSocket;
    hitl: ReturnType<typeof getHitlHandler>;
  } {
    const socket = makeMockSocket();
    connectionHandler!(socket);
    return { socket, hitl: getHitlHandler(socket) };
  }

  it("rejects payload with missing taskId", () => {
    const { hitl } = connectSocket();
    const ack = vi.fn();
    hitl({ decision: "PUBLISH" }, ack);
    expect(ack).toHaveBeenCalledWith({
      ok: false,
      error: "invalid taskId or decision",
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("rejects payload with missing decision field", () => {
    const { hitl } = connectSocket();
    const ack = vi.fn();
    hitl({ taskId: "abc-123" }, ack);
    expect(ack).toHaveBeenCalledWith({
      ok: false,
      error: "invalid taskId or decision",
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("rejects invalid decision value not in VALID_DECISIONS", () => {
    const { hitl } = connectSocket();
    const ack = vi.fn();
    hitl({ taskId: "abc-123", decision: "INVALID" }, ack);
    expect(ack).toHaveBeenCalledWith({
      ok: false,
      error: "invalid decision value: INVALID",
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("rejects non-object payload (null)", () => {
    const { hitl } = connectSocket();
    const ack = vi.fn();
    hitl(null, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "invalid payload" });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("rejects non-string decision (numeric)", () => {
    const { hitl } = connectSocket();
    const ack = vi.fn();
    hitl({ taskId: "abc-123", decision: 42 }, ack);
    expect(ack).toHaveBeenCalledWith({
      ok: false,
      error: "invalid taskId or decision",
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("accepts valid PUBLISH decision and publishes to Redis", async () => {
    const { hitl } = connectSocket();
    const ack = vi.fn();
    hitl({ taskId: "abc-123", decision: "PUBLISH" }, ack);
    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith({ ok: true }));
    expect(mockPublish).toHaveBeenCalledWith(
      "kaiban-hitl-decisions",
      JSON.stringify({ taskId: "abc-123", decision: "PUBLISH" }),
    );
  });

  it("respects custom validHitlDecisions list", async () => {
    await sg.shutdown();
    sg = new SocketGateway(httpServer, redisPublisher, redisSubscriber, {
      validHitlDecisions: ["APPROVE", "DENY"],
    });
    sg.initialize();

    const { hitl } = connectSocket();
    const ack1 = vi.fn();
    hitl({ taskId: "t1", decision: "PUBLISH" }, ack1);
    expect(ack1).toHaveBeenCalledWith({
      ok: false,
      error: "invalid decision value: PUBLISH",
    });

    const ack2 = vi.fn();
    hitl({ taskId: "t1", decision: "APPROVE" }, ack2);
    await vi.waitFor(() => expect(ack2).toHaveBeenCalledWith({ ok: true }));
  });

  it("rejects VIEW decision — VIEW is terminal-only, not a valid board decision", () => {
    const { hitl } = connectSocket();
    const ack = vi.fn();
    hitl({ taskId: "abc-123", decision: "VIEW" }, ack);
    expect(ack).toHaveBeenCalledWith({
      ok: false,
      error: "invalid decision value: VIEW",
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("returns ok:false ACK when Redis publish fails", async () => {
    mockPublish.mockRejectedValueOnce(new Error("Redis down"));
    const { hitl } = connectSocket();
    const ack = vi.fn();
    hitl({ taskId: "redis-err-task", decision: "PUBLISH" }, ack);
    await vi.waitFor(() =>
      expect(ack).toHaveBeenCalledWith({
        ok: false,
        error: "Redis publish failed",
      }),
    );
  });

  it("calls ack with ok:true and logs after successful Redis publish", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { hitl } = connectSocket();
    const ack = vi.fn();
    hitl({ taskId: "log-task-12345678", decision: "REVISE" }, ack);
    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith({ ok: true }));
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("HITL decision received"),
    );
    logSpy.mockRestore();
  });

  it("handles missing ack callback gracefully (no-throw)", () => {
    const { hitl } = connectSocket();
    // No ack provided — should not throw
    expect(() =>
      hitl({ taskId: "no-ack-task", decision: "INVALID" }),
    ).not.toThrow();
  });
});
