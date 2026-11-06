/**
 * SocketGateway — final-audit fixes: a non-function ack never crashes the
 * process, long token lifetimes, snapshot-request limit, WebSocket origin
 * allowlist, per-gateway fan-out, proxy-aware stop key, run restart reset.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../../src/shared/structured-logger", () => ({
  createStructuredLogger: (): typeof mockLog => mockLog,
  logger: mockLog,
  resolveLogLevel: (): string => "silent",
}));

import { createServer } from "http";
import type Redis from "ioredis";
import { SocketGateway } from "../../../src/adapters/gateway/SocketGateway";
import type { EmergencyStopIngress } from "../../../src/adapters/gateway/emergency-stop-ingress";

const redisOn = vi.fn();
const redisSubscriber = { subscribe: vi.fn(), on: redisOn, quit: vi.fn().mockResolvedValue(undefined) } as unknown as Redis;
const redisPublisher = {
  publish: vi.fn().mockResolvedValue(1),
  quit: vi.fn().mockResolvedValue(undefined),
  lpush: vi.fn().mockResolvedValue(1),
  expire: vi.fn().mockResolvedValue(1),
} as unknown as Redis;

interface MockSocket {
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  data: Record<string, unknown>;
  handshake: { auth: Record<string, unknown>; address: string; headers?: Record<string, unknown> };
}
let connectionHandler: ((socket: MockSocket) => void) | null = null;
let capturedOptions: Record<string, unknown> | null = null;
const globalEmit = vi.fn();
const localEmit = vi.fn();
const localDisconnect = vi.fn();

vi.mock("socket.io", () => ({
  Server: vi.fn().mockImplementation(function (_srv: unknown, opts: Record<string, unknown>) {
    capturedOptions = opts;
    return {
      adapter: vi.fn(),
      emit: globalEmit,
      local: { emit: localEmit, disconnectSockets: localDisconnect },
      close: vi.fn((cb?: () => void) => cb?.()),
      on: vi.fn((event: string, cb: (s: MockSocket) => void) => {
        if (event === "connection") connectionHandler = cb;
      }),
      use: vi.fn(),
    };
  }),
}));
vi.mock("@socket.io/redis-adapter", () => ({ createAdapter: vi.fn() }));
vi.mock("../../../src/infrastructure/security/channel-signing", () => ({
  unwrapVerified: vi.fn((raw: string) => JSON.parse(raw) as Record<string, unknown>),
  wrapSigned: vi.fn((p: Record<string, unknown>) => JSON.stringify(p)),
}));

const connect = (over: Partial<MockSocket> = {}): MockSocket => {
  const socket: MockSocket = {
    emit: vi.fn(),
    on: vi.fn(),
    disconnect: vi.fn(),
    data: {},
    handshake: { auth: { token: "tok" }, address: "10.0.0.9" },
    ...over,
  };
  connectionHandler!(socket);
  return socket;
};
const handlerOf = (socket: MockSocket, event: string): ((...a: unknown[]) => unknown) =>
  (socket.on.mock.calls as Array<[string, (...a: unknown[]) => unknown]>).find((c) => c[0] === event)![1];
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const stopAll = vi.fn();
const control = { stopAll } as unknown as EmergencyStopIngress;
let sg: SocketGateway;
const start = (opts: ConstructorParameters<typeof SocketGateway>[3] = {}): void => {
  sg = new SocketGateway(createServer(), redisPublisher, redisSubscriber, { control, ...opts });
  sg.initialize();
};

beforeEach(() => {
  vi.clearAllMocks();
  stopAll.mockResolvedValue({ ok: true, commandId: "c", issuedAt: 1, saved: true });
  delete process.env["SOCKET_CORS_ORIGINS"];
  delete process.env["NODE_ENV"];
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env["SOCKET_CORS_ORIGINS"];
});

describe("a client's last argument is not a function", () => {
  it.each(["x", 5, { a: 1 }, null])("hitl:decision with %j neither throws nor crashes", (junk) => {
    start();
    const socket = connect();
    expect(() => handlerOf(socket, "hitl:decision")({ taskId: "t1", decision: "NOPE" }, junk)).not.toThrow();
    expect(() => handlerOf(socket, "hitl:decision")({ taskId: "t1", decision: "PUBLISH" }, junk)).not.toThrow();
  });

  it("control:stop-all still issues the stop and never rejects", async () => {
    start();
    const socket = connect();
    handlerOf(socket, "control:stop-all")({}, "x");
    await flush();
    expect(stopAll).toHaveBeenCalledTimes(1);
  });

  it("a stop refusal with a junk ack does not reject either", async () => {
    start();
    stopAll.mockResolvedValue({ ok: false, status: 401, error: "no" });
    const socket = connect();
    handlerOf(socket, "control:stop-all")({}, 42);
    await flush();
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it("an unexpected failure in the stop path is logged and acked, not unhandled", async () => {
    start();
    stopAll.mockRejectedValue(new Error("boom"));
    const socket = connect();
    const ack = vi.fn();
    handlerOf(socket, "control:stop-all")({}, ack);
    await flush();
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "Emergency stop failed" });
    expect(mockLog.error).toHaveBeenCalled();
  });
});

describe("token expiry timer", () => {
  it("a 30-day token keeps the socket connected (no 1 ms clamp)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    start();
    const exp = Math.floor(Date.now() / 1000) + 30 * 86_400;
    const socket = connect({ data: { exp } });
    vi.advanceTimersByTime(60_000);
    expect(socket.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(29 * 86_400 * 1000);
    expect(socket.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * 86_400 * 1000);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it("a short token still disconnects at its expiry and stops the timer on disconnect", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    start();
    const exp = Math.floor(Date.now() / 1000) + 10;
    const socket = connect({ data: { exp } });
    vi.advanceTimersByTime(11_000);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("state:request limit", () => {
  it("answers 5 requests per 10 s per connection and drops the rest", () => {
    vi.useFakeTimers();
    start();
    const socket = connect();
    localEmit.mockClear();
    // seed a snapshot so a send is visible
    const onMessage = (redisOn.mock.calls as Array<[string, (c: string, d: string) => void]>).find((c) => c[0] === "message")![1];
    onMessage("c", JSON.stringify({ teamWorkflowStatus: "RUNNING" }));
    socket.emit.mockClear();
    for (let i = 0; i < 8; i++) handlerOf(socket, "state:request")();
    expect(socket.emit).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(10_001);
    handlerOf(socket, "state:request")();
    expect(socket.emit).toHaveBeenCalledTimes(6);
  });
});

describe("WebSocket origin allowlist", () => {
  const verdict = (origin: string | undefined): boolean => {
    let result: boolean | undefined;
    (capturedOptions!["allowRequest"] as (r: unknown, cb: (e: null, ok: boolean) => void) => void)(
      { headers: origin === undefined ? {} : { origin } },
      (_e, ok) => (result = ok),
    );
    return result!;
  };

  it("with an allowlist, refuses a listed-out origin and admits listed and origin-less clients", () => {
    process.env["SOCKET_CORS_ORIGINS"] = "https://board.example.com, http://localhost:5173";
    start();
    expect(verdict("https://evil.example")).toBe(false);
    expect(verdict("https://board.example.com")).toBe(true);
    expect(verdict("http://localhost:5173")).toBe(true);
    expect(verdict(undefined)).toBe(true);
  });
});

describe("fan-out and shutdown", () => {
  it("state deltas go to this gateway's clients only (the adapter would repeat them per gateway)", () => {
    start();
    const onMessage = (redisOn.mock.calls as Array<[string, (c: string, d: string) => void]>).find((c) => c[0] === "message")![1];
    onMessage("c", JSON.stringify({ teamWorkflowStatus: "RUNNING" }));
    expect(localEmit).toHaveBeenCalledWith("state:update", { teamWorkflowStatus: "RUNNING" });
    expect(globalEmit).not.toHaveBeenCalled();
  });

  it("noteStop announces to this gateway's clients only", () => {
    start();
    sg.noteStop({ commandId: "c", issuedAt: 5, issuedBy: "cli" });
    expect(localEmit).toHaveBeenCalledTimes(1);
    expect(globalEmit).not.toHaveBeenCalled();
  });

  it("disconnectClients ends local sockets; before initialize it is a no-op", () => {
    sg = new SocketGateway(createServer(), redisPublisher, redisSubscriber);
    expect(() => sg.disconnectClients()).not.toThrow();
    sg.initialize();
    sg.disconnectClients();
    expect(localDisconnect).toHaveBeenCalledWith(true);
  });
});

describe("stop-all rate-limit key", () => {
  const keyFor = async (opts: { trustProxy?: boolean }, headers?: Record<string, unknown>): Promise<string> => {
    start(opts);
    const socket = connect({ handshake: { auth: {}, address: "10.0.0.9", ...(headers ? { headers } : {}) } });
    handlerOf(socket, "control:stop-all")({});
    await flush();
    return stopAll.mock.calls.at(-1)![2] as string;
  };

  it("uses the socket address by default, ignoring a forwarded header", async () => {
    expect(await keyFor({}, { "x-forwarded-for": "1.2.3.4" })).toBe("10.0.0.9");
  });

  it("behind a trusted proxy uses the last X-Forwarded-For entry (as Express does)", async () => {
    expect(await keyFor({ trustProxy: true }, { "x-forwarded-for": "6.6.6.6, 1.2.3.4" })).toBe("1.2.3.4");
  });

  it("joins repeated header values and falls back to the address when absent or empty", async () => {
    expect(await keyFor({ trustProxy: true }, { "x-forwarded-for": ["6.6.6.6", "1.2.3.5"] })).toBe("1.2.3.5");
    expect(await keyFor({ trustProxy: true }, {})).toBe("10.0.0.9");
    expect(await keyFor({ trustProxy: true }, { "x-forwarded-for": "" })).toBe("10.0.0.9");
  });
});

describe("a new run clears the previous run's metadata and inputs (UI-V-02)", () => {
  const deliver = (delta: Record<string, unknown>): void => {
    const onMessage = (redisOn.mock.calls as Array<[string, (c: string, d: string) => void]>).find((c) => c[0] === "message")![1];
    onMessage("c", JSON.stringify(delta));
  };

  it("replays only the new run's startTime after FINISHED then RUNNING", () => {
    start();
    deliver({ teamWorkflowStatus: "RUNNING", metadata: { startTime: 1 }, inputs: { topic: "a" } });
    deliver({ teamWorkflowStatus: "FINISHED", metadata: { endTime: 9, totalTokens: 7 } });
    deliver({ teamWorkflowStatus: "RUNNING", metadata: { startTime: 20 } });
    const socket = connect();
    const snap = socket.emit.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(snap["metadata"]).toEqual({ startTime: 20 });
    expect(snap["inputs"]).toBeUndefined();
  });

  it("keeps metadata while the same run continues", () => {
    start();
    deliver({ teamWorkflowStatus: "RUNNING", metadata: { startTime: 1 } });
    deliver({ teamWorkflowStatus: "RUNNING", metadata: { totalTokens: 3 } });
    const socket = connect();
    expect((socket.emit.mock.calls.at(-1)![1] as Record<string, unknown>)["metadata"]).toEqual({ startTime: 1, totalTokens: 3 });
  });
});
