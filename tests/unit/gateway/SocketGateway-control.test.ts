/**
 * SocketGateway — the emergency STOP ALL socket event and the control state in
 * the snapshot (roadmap §6.10 ES-6, ES-7, ES-9; ADR-025).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import { createServer } from "http";
import type Redis from "ioredis";
import { SocketGateway } from "../../../src/adapters/gateway/SocketGateway";
import type { EmergencyStopIngress } from "../../../src/adapters/gateway/emergency-stop-ingress";

const mockRedisOn = vi.fn();
const redisSubscriber = {
  subscribe: vi.fn().mockResolvedValue(undefined),
  on: mockRedisOn,
  quit: vi.fn().mockResolvedValue(undefined),
} as unknown as Redis;
const redisPublisher = {
  publish: vi.fn().mockResolvedValue(1),
  quit: vi.fn().mockResolvedValue(undefined),
  lpush: vi.fn().mockResolvedValue(1),
  expire: vi.fn().mockResolvedValue(1),
} as unknown as Redis;

interface MockSocket {
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  data: Record<string, unknown>;
  handshake: { auth: Record<string, unknown>; address: string };
}
let connectionHandler: ((socket: MockSocket) => void) | null = null;
const mockIoEmit = vi.fn();

vi.mock("socket.io", () => ({
  Server: vi.fn().mockImplementation(function () {
    return {
      adapter: vi.fn(),
      emit: mockIoEmit,
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
  unwrapVerified: vi.fn((raw: string) => {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }),
  wrapSigned: vi.fn((p: Record<string, unknown>) => JSON.stringify(p)),
}));

const connect = (token?: string): MockSocket => {
  const socket: MockSocket = {
    emit: vi.fn(),
    on: vi.fn(),
    data: {},
    handshake: { auth: token ? { token } : {}, address: "10.0.0.9" },
  };
  connectionHandler!(socket);
  return socket;
};
const handlerOf = (socket: MockSocket, event: string): ((...a: unknown[]) => void) | undefined =>
  (socket.on.mock.calls as Array<[string, (...a: unknown[]) => void]>).find(
    (c) => c[0] === event,
  )?.[1];
const deliver = (delta: Record<string, unknown>): void => {
  const onMessage = (mockRedisOn.mock.calls as Array<[string, (c: string, d: string) => void]>).find(
    (c) => c[0] === "message",
  )![1];
  onMessage("kaiban-state-events", JSON.stringify(delta));
};
const snapshotOf = (socket: MockSocket): Record<string, unknown> =>
  socket.emit.mock.calls.at(-1)![1] as Record<string, unknown>;

const ingress = (): { stopAll: ReturnType<typeof vi.fn> } => ({
  stopAll: vi.fn().mockResolvedValue({ ok: true, commandId: "c-1", issuedAt: 5, saved: true }),
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("SocketGateway — control plane off (ES-7)", () => {
  let sg: SocketGateway;
  beforeEach(() => {
    vi.clearAllMocks();
    sg = new SocketGateway(createServer(), redisPublisher, redisSubscriber);
    sg.initialize();
  });
  afterEach(async () => sg.shutdown());

  it("registers no control event and puts no control state in the snapshot", () => {
    deliver({ control: { commandId: "c", issuedAt: 1, outcome: "applied" } });
    const socket = connect();
    expect(handlerOf(socket, "control:stop-all")).toBeUndefined();
    expect(socket.emit).not.toHaveBeenCalled(); // empty snapshot, nothing sent
    sg.noteStop({ commandId: "c", issuedAt: 1, issuedBy: "x" });
    expect(mockIoEmit).not.toHaveBeenCalledWith("state:update", expect.objectContaining({ controlPlane: expect.anything() }));
  });
});

describe("SocketGateway — control plane on", () => {
  let sg: SocketGateway;
  let control: ReturnType<typeof ingress>;
  const make = async (): Promise<void> => {
    control = ingress();
    sg = new SocketGateway(createServer(), redisPublisher, redisSubscriber, {
      control: control as unknown as EmergencyStopIngress,
    });
    sg.initialize();
    await flush();
  };
  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => sg.shutdown());

  it("the snapshot says the control plane is on, with no stop yet", async () => {
    await make();
    expect(snapshotOf(connect())).toEqual({ controlPlane: { enabled: true, acks: 0 } });
  });

  it("noteStop (control channel, incl. CLI stops) sets the last stop, resets acks, and tells every board", async () => {
    await make();
    deliver({ control: { commandId: "a", issuedAt: 10, issuedBy: "x", outcome: "applied" } });
    sg.noteStop({ commandId: "cli", issuedAt: 20, issuedBy: "cli", reason: "r" });
    const plane = { enabled: true, lastStop: { commandId: "cli", issuedAt: 20, issuedBy: "cli", reason: "r" }, acks: 0 };
    expect(mockIoEmit).toHaveBeenCalledWith("state:update", { controlPlane: plane });
    expect(snapshotOf(connect())["controlPlane"]).toEqual(plane);
  });

  it("noteStop ignores a stop no newer than the last one (e.g. the saved one after a live ack)", async () => {
    await make();
    deliver({ control: { commandId: "live", issuedAt: 50, issuedBy: "ops", outcome: "applied" } });
    mockIoEmit.mockClear();
    sg.noteStop({ commandId: "saved", issuedAt: 10, issuedBy: "x" });
    sg.noteStop({ commandId: "live", issuedAt: 50, issuedBy: "ops" });
    expect(mockIoEmit).not.toHaveBeenCalled();
    expect(snapshotOf(connect())["controlPlane"]).toMatchObject({ lastStop: { commandId: "live" }, acks: 1 });
  });

  it("the socket event passes the handshake token, payload and address; the ack carries the result", async () => {
    await make();
    const socket = connect("tok");
    const ack = vi.fn();
    handlerOf(socket, "control:stop-all")!({ reason: "runaway" }, ack);
    await flush();
    expect(control.stopAll).toHaveBeenCalledWith("tok", { reason: "runaway" }, "10.0.0.9");
    expect(ack).toHaveBeenCalledWith({ ok: true, commandId: "c-1", issuedAt: 5, saved: true });
  });

  it("a refusal is acked as { ok: false, error } and works without an ack callback", async () => {
    await make();
    control.stopAll.mockResolvedValue({ ok: false, status: 401, error: "Missing board token" });
    const socket = connect();
    const ack = vi.fn();
    handlerOf(socket, "control:stop-all")!({}, ack);
    await flush();
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "Missing board token" });
    handlerOf(socket, "control:stop-all")!({});
    await flush();
    expect(control.stopAll).toHaveBeenCalledTimes(2);
  });

  it("control deltas update the latest stop and count node acks for it (ES-9)", async () => {
    await make();
    const stop = { commandId: "c-2", issuedAt: 20, issuedBy: "ops" };
    deliver({ control: { ...stop, nodeId: "gateway", outcome: "issued", aborted: 0, at: 20 } });
    deliver({ control: { ...stop, nodeId: "n1", outcome: "applied", aborted: 2, at: 21 } });
    deliver({ control: { ...stop, nodeId: "n2", outcome: "noop", aborted: 0, at: 21 } });
    deliver({ control: { commandId: "old", issuedAt: 5, issuedBy: "x", outcome: "applied" } });
    deliver({ control: "not an object" });
    expect(snapshotOf(connect())["controlPlane"]).toEqual({
      enabled: true,
      lastStop: { commandId: "c-2", issuedAt: 20, issuedBy: "ops" },
      acks: 2,
    });
    expect(mockIoEmit).toHaveBeenCalledWith("state:update", expect.objectContaining({ control: expect.anything() }));
  });

  it("a newer stop resets the ack count", async () => {
    await make();
    deliver({ control: { commandId: "a", issuedAt: 1, issuedBy: "x", outcome: "applied" } });
    deliver({ control: { commandId: "b", issuedAt: 2, issuedBy: "x", reason: "again", outcome: "issued" } });
    expect(snapshotOf(connect())["controlPlane"]).toEqual({
      enabled: true,
      lastStop: { commandId: "b", issuedAt: 2, issuedBy: "x", reason: "again" },
      acks: 0,
    });
  });

  it("ignores a control delta without a command id or moment; a missing issuer shows as unknown", async () => {
    await make();
    deliver({ control: { issuedAt: 1, outcome: "applied" } });
    deliver({ control: { commandId: "z", issuedAt: "soon" } });
    deliver({ control: { commandId: "z", issuedAt: 99, outcome: "applied" } });
    expect(snapshotOf(connect())["controlPlane"]).toEqual({
      enabled: true,
      lastStop: { commandId: "z", issuedAt: 99, issuedBy: "unknown" },
      acks: 1,
    });
  });
});
