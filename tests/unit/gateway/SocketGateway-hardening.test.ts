import { describe, it, expect, vi } from "vitest";
import { createServer } from "http";
import type Redis from "ioredis";

// Capture constructor options
let capturedOptions: Record<string, unknown> | null = null;
vi.mock("socket.io", () => ({
  Server: vi.fn().mockImplementation(function (
    _srv: unknown,
    opts: Record<string, unknown>,
  ) {
    capturedOptions = opts;
    return {
      adapter: vi.fn(),
      emit: vi.fn(),
      close: vi.fn((cb?: () => void) => {
        if (cb) cb();
      }),
      on: vi.fn(),
      use: vi.fn(),
    };
  }),
}));
vi.mock("@socket.io/redis-adapter", () => ({
  createAdapter: vi.fn().mockReturnValue("mock-adapter"),
}));

import { SocketGateway } from "../../../src/adapters/gateway/SocketGateway";

const mockRedis = {
  subscribe: vi.fn(),
  on: vi.fn(),
  quit: vi.fn().mockResolvedValue(undefined),
};
const redisClient = mockRedis as unknown as Redis;

describe("SocketGateway — hardening options", () => {
  it("sets maxHttpBufferSize to 1MB", () => {
    capturedOptions = null;
    const httpServer = createServer();
    const sg = new SocketGateway(httpServer, redisClient, redisClient);
    sg.initialize();
    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!["maxHttpBufferSize"]).toBe(1e6);
  });

  it("sets pingTimeout to 20s", () => {
    capturedOptions = null;
    const httpServer = createServer();
    const sg = new SocketGateway(httpServer, redisClient, redisClient);
    sg.initialize();
    expect(capturedOptions!["pingTimeout"]).toBe(20_000);
  });

  it("sets pingInterval to 25s", () => {
    capturedOptions = null;
    const httpServer = createServer();
    const sg = new SocketGateway(httpServer, redisClient, redisClient);
    sg.initialize();
    expect(capturedOptions!["pingInterval"]).toBe(25_000);
  });

  it("still sets CORS origin (wildcard array when SOCKET_CORS_ORIGINS unset)", () => {
    capturedOptions = null;
    const httpServer = createServer();
    const sg = new SocketGateway(httpServer, redisClient, redisClient);
    sg.initialize();
    const cors = capturedOptions!["cors"] as Record<string, unknown>;
    // When SOCKET_CORS_ORIGINS is not set (non-production), origin is ['*']
    expect(cors["origin"]).toEqual(["*"]);
  });
});
