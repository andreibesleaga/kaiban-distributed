import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "http";
import type Redis from "ioredis";

const mockSubscribe = vi.fn().mockResolvedValue(undefined);
const mockRedisOn = vi.fn();
const mockPublisherQuit = vi.fn().mockResolvedValue(undefined);
const mockSubscriberQuit = vi.fn().mockResolvedValue(undefined);
const mockPublish = vi.fn().mockResolvedValue(1);
const unwrapVerifiedMock = vi.fn((payload: string) => JSON.parse(payload));
const wrapSignedMock = vi.fn((payload: Record<string, unknown>) =>
  JSON.stringify({ ...payload, _signed: true }),
);

const basePublisher = {
  publish: mockPublish,
  quit: mockPublisherQuit,
};
const baseSubscriber = {
  subscribe: mockSubscribe,
  on: mockRedisOn,
  quit: mockSubscriberQuit,
};

const redisPublisher = basePublisher as unknown as Redis;
const redisSubscriber = baseSubscriber as unknown as Redis;

let connectionHandler: ((socket: MockSocket) => void) | null = null;

interface MockSocket {
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  data: Record<string, unknown>;
  handshake: { auth: Record<string, unknown> };
  disconnect: ReturnType<typeof vi.fn>;
}

function makeMockSocket(): MockSocket {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    data: {},
    handshake: { auth: {} },
    disconnect: vi.fn(),
  };
}

vi.mock("socket.io", () => ({
  Server: vi.fn().mockImplementation(function () {
    return {
      adapter: vi.fn(),
      emit: vi.fn(),
      close: vi.fn((cb?: () => void) => {
        if (cb) cb();
      }),
      on: vi
        .fn()
        .mockImplementation((event: string, cb: typeof connectionHandler) => {
          if (event === "connection") connectionHandler = cb;
        }),
      use: vi.fn(),
    };
  }),
}));

vi.mock("@socket.io/redis-adapter", () => ({
  createAdapter: vi.fn().mockReturnValue("mock-adapter"),
}));

vi.mock("../../../src/infrastructure/security/channel-signing", () => ({
  unwrapVerified: vi.fn((payload: string) => unwrapVerifiedMock(payload)),
  wrapSigned: vi.fn((payload: Record<string, unknown>) =>
    wrapSignedMock(payload),
  ),
}));

import { SocketGateway } from "../../../src/adapters/gateway/SocketGateway";

describe("SocketGateway — coverage branches", () => {
  const httpServer = createServer();
  const gateways: SocketGateway[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    connectionHandler = null;
    unwrapVerifiedMock.mockImplementation((payload: string) =>
      JSON.parse(payload),
    );
  });

  afterEach(async () => {
    await Promise.all(gateways.splice(0).map((gateway) => gateway.shutdown()));
  });

  function initGateway(opts?: {
    validHitlDecisions?: string[];
    hitlPublisher?: Redis;
  }): SocketGateway {
    const gateway = new SocketGateway(
      httpServer,
      redisPublisher,
      redisSubscriber,
      opts,
    );
    gateways.push(gateway);
    gateway.initialize();
    return gateway;
  }

  function getRedisMessageHandler(): (channel: string, data: string) => void {
    const calls = mockRedisOn.mock.calls as Array<
      [string, (channel: string, data: string) => void]
    >;
    return calls.find(([event]) => event === "message")![1];
  }

  function getHitlHandler(
    socket: MockSocket,
  ): (
    payload: unknown,
    ack?: (response: { ok: boolean; error?: string }) => void,
  ) => void {
    const calls = socket.on.mock.calls as Array<
      [
        string,
        (
          payload: unknown,
          ack?: (response: { ok: boolean; error?: string }) => void,
        ) => void,
      ]
    >;
    return calls.find(([event]) => event === "hitl:decision")![1];
  }

  it("replays metadata and inputs in the accumulated snapshot", () => {
    initGateway();
    getRedisMessageHandler()(
      "kaiban-state-events",
      JSON.stringify({
        teamWorkflowStatus: "RUNNING",
        metadata: { totalTokens: 42, estimatedCost: 0.01 },
        inputs: { topic: "distributed-ai" },
      }),
    );

    const socket = makeMockSocket();
    connectionHandler!(socket);

    expect(socket.emit).toHaveBeenCalledWith(
      "state:update",
      expect.objectContaining({
        teamWorkflowStatus: "RUNNING",
        metadata: { totalTokens: 42, estimatedCost: 0.01 },
        inputs: { topic: "distributed-ai" },
      }),
    );
  });

  it("ignores snapshot entries whose ids are not strings", () => {
    initGateway();
    getRedisMessageHandler()(
      "kaiban-state-events",
      JSON.stringify({
        agents: [
          {
            agentId: 123,
            name: "invalid-agent",
            role: "Researcher",
            status: "IDLE",
            currentTaskId: null,
          },
        ],
      }),
    );

    const socket = makeMockSocket();
    connectionHandler!(socket);

    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("logs and acks failure when publishing a HITL decision to Redis fails", async () => {
    const failingHitlPublisher = {
      publish: vi.fn().mockRejectedValue(new Error("redis-down")),
      quit: vi.fn().mockResolvedValue(undefined),
    } as unknown as Redis;
    initGateway({ hitlPublisher: failingHitlPublisher });

    const socket = makeMockSocket();
    connectionHandler!(socket);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ack = vi.fn();
    getHitlHandler(socket)({ taskId: "task-123", decision: "PUBLISH" }, ack);

    await Promise.resolve();
    await Promise.resolve();

    expect(ack).toHaveBeenCalledWith({
      ok: false,
      error: "Redis publish failed",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "[SocketGateway] Failed to publish HITL decision to Redis:",
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it("logs parse failures when unwrapVerified throws", () => {
    initGateway();
    unwrapVerifiedMock.mockImplementationOnce(() => {
      throw new Error("bad envelope");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getRedisMessageHandler()("kaiban-state-events", "not-json");

    expect(errorSpy).toHaveBeenCalledWith(
      "[SocketGateway] Failed to parse state message",
    );
    errorSpy.mockRestore();
  });

  it("disconnects a distinct HITL publisher during shutdown", async () => {
    const hitlQuit = vi.fn().mockResolvedValue(undefined);
    const separateHitlPublisher = {
      publish: vi.fn().mockResolvedValue(1),
      quit: hitlQuit,
    } as unknown as Redis;
    const gateway = new SocketGateway(
      httpServer,
      redisPublisher,
      redisSubscriber,
      {
        hitlPublisher: separateHitlPublisher,
      },
    );

    await gateway.shutdown();

    expect(hitlQuit).toHaveBeenCalledOnce();
  });
});
