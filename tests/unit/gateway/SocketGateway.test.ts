import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "http";
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
const mockRedisPublisher = { publish: mockPublish, quit: mockQuit };

const mockEmit = vi.fn();
const mockIoClose = vi.fn().mockImplementation((cb?: () => void) => {
  if (cb) cb();
});
const mockAdapter = vi.fn();

// Capture connection callbacks so tests can simulate socket connections
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
      adapter: mockAdapter,
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
vi.mock("../../../src/infrastructure/security/channel-signing", () => ({
  unwrapVerified: vi.fn((payload) => {
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }),
  wrapSigned: vi.fn((payload) => JSON.stringify({ ...payload, _signed: true })),
}));

describe("SocketGateway", () => {
  let sg: SocketGateway;
  const httpServer = createServer();

  beforeEach(() => {
    vi.clearAllMocks();
    connectionHandler = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sg = new SocketGateway(
      httpServer,
      mockRedisPublisher as any,
      mockRedisSubscriber as any,
    );
  });

  afterEach(async () => {
    await sg.shutdown();
  });

  function getRedisMessageHandler(): (channel: string, data: string) => void {
    const calls = mockRedisOn.mock.calls as Array<
      [string, (...args: unknown[]) => void]
    >;
    const onCall = calls.find((args) => args[0] === "message");
    return onCall![1] as (channel: string, data: string) => void;
  }

  it("initialize() attaches Redis adapter to Socket.io", () => {
    sg.initialize();
    expect(mockAdapter).toHaveBeenCalledWith("mock-redis-adapter");
  });

  it("initialize() subscribes to kaiban-state-events on Redis", () => {
    sg.initialize();
    expect(mockSubscribe).toHaveBeenCalledWith("kaiban-state-events");
  });

  it("a Redis message triggers io.emit(state:update)", () => {
    sg.initialize();
    getRedisMessageHandler()(
      "kaiban-state-events",
      JSON.stringify({ stateUpdate: { count: 1 } }),
    );
    expect(mockEmit).toHaveBeenCalledWith("state:update", {
      stateUpdate: { count: 1 },
    });
  });

  it("invalid JSON in Redis message is caught and logged (warn on bad/unsigned message)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    sg.initialize();
    getRedisMessageHandler()("kaiban-state-events", "{invalid}");
    // unwrapVerified returns null on bad JSON → triggers 'Rejected unsigned/invalid' warn
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Rejected"));
    warnSpy.mockRestore();
  });

  it("shutdown() resolves without calling io.close when not initialized", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uninitSg = new SocketGateway(
      httpServer,
      mockRedisPublisher as any,
      mockRedisSubscriber as any,
    );
    await expect(uninitSg.shutdown()).resolves.not.toThrow();
    expect(mockIoClose).not.toHaveBeenCalled();
  });

  it("sends accumulated snapshot to newly connected socket", () => {
    sg.initialize();
    // Simulate a delta arriving before the client connects
    getRedisMessageHandler()(
      "kaiban-state-events",
      JSON.stringify({
        teamWorkflowStatus: "RUNNING",
        agents: [
          {
            agentId: "researcher",
            name: "Ava",
            role: "Researcher",
            status: "EXECUTING",
            currentTaskId: "task-1",
          },
        ],
      }),
    );

    // Simulate a new socket connection
    const mockSocket = makeMockSocket();
    connectionHandler!(mockSocket);

    expect(mockSocket.emit).toHaveBeenCalledWith(
      "state:update",
      expect.objectContaining({
        teamWorkflowStatus: "RUNNING",
        agents: expect.arrayContaining([
          expect.objectContaining({ agentId: "researcher" }),
        ]),
      }),
    );
  });

  it("does not emit snapshot to socket when snapshot is empty", () => {
    sg.initialize();
    const mockSocket = makeMockSocket();
    connectionHandler!(mockSocket);
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });

  it("responds to state:request with current snapshot", () => {
    sg.initialize();
    getRedisMessageHandler()(
      "kaiban-state-events",
      JSON.stringify({
        tasks: [
          {
            taskId: "t-1",
            title: "Research task",
            status: "DOING",
            assignedToAgentId: "researcher",
          },
        ],
      }),
    );

    const mockSocket = makeMockSocket();
    connectionHandler!(mockSocket);

    // Find the state:request handler registered on the socket
    const socketOnCalls = mockSocket.on.mock.calls as Array<
      [string, () => void]
    >;
    const stateRequestHandler = socketOnCalls.find(
      ([ev]) => ev === "state:request",
    )?.[1];
    expect(stateRequestHandler).toBeDefined();

    mockSocket.emit.mockClear();
    stateRequestHandler!();

    expect(mockSocket.emit).toHaveBeenCalledWith(
      "state:update",
      expect.objectContaining({
        tasks: expect.arrayContaining([
          expect.objectContaining({ taskId: "t-1" }),
        ]),
      }),
    );
  });

  it("merges multiple deltas into snapshot", () => {
    sg.initialize();
    const handle = getRedisMessageHandler();
    handle(
      "kaiban-state-events",
      JSON.stringify({
        agents: [
          {
            agentId: "researcher",
            name: "Ava",
            role: "R",
            status: "EXECUTING",
            currentTaskId: "t1",
          },
        ],
      }),
    );
    handle(
      "kaiban-state-events",
      JSON.stringify({
        agents: [
          {
            agentId: "writer",
            name: "Kai",
            role: "W",
            status: "IDLE",
            currentTaskId: null,
          },
        ],
      }),
    );

    const mockSocket = makeMockSocket();
    connectionHandler!(mockSocket);

    const call = (
      mockSocket.emit.mock.calls as Array<[string, Record<string, unknown>]>
    ).find(([ev]) => ev === "state:update");
    const agents = call![1]["agents"] as Record<string, unknown>[];
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a["agentId"])).toContain("researcher");
    expect(agents.map((a) => a["agentId"])).toContain("writer");
  });

  it("clears tasks in snapshot when workflow restarts from a terminal state", () => {
    sg.initialize();
    const handle = getRedisMessageHandler();

    handle(
      "kaiban-state-events",
      JSON.stringify({
        teamWorkflowStatus: "FINISHED",
        tasks: [
          {
            taskId: "old-task",
            title: "Old",
            status: "DONE",
            assignedToAgentId: "writer",
          },
        ],
      }),
    );
    handle(
      "kaiban-state-events",
      JSON.stringify({ teamWorkflowStatus: "RUNNING" }),
    );

    const mockSocket = makeMockSocket();
    connectionHandler!(mockSocket);

    const call = (
      mockSocket.emit.mock.calls as Array<[string, Record<string, unknown>]>
    ).find(([ev]) => ev === "state:update");
    expect(call![1]["tasks"]).toBeUndefined(); // tasks cleared
    expect(call![1]["teamWorkflowStatus"]).toBe("RUNNING");
  });

  type HitlHandler = (
    payload: unknown,
    ack?: (r: { ok: boolean; error?: string }) => void,
  ) => void;

  function getHitlHandler(mockSocket: MockSocket): HitlHandler {
    const socketOnCalls = mockSocket.on.mock.calls as Array<
      [string, HitlHandler]
    >;
    const handler = socketOnCalls.find(([ev]) => ev === "hitl:decision")?.[1];
    expect(handler).toBeDefined();
    return handler!;
  }

  it("publishes valid hitl:decision to Redis", () => {
    sg.initialize();
    const mockSocket = makeMockSocket();
    connectionHandler!(mockSocket);

    getHitlHandler(mockSocket)({ taskId: "task-42", decision: "PUBLISH" });
    expect(mockPublish).toHaveBeenCalledWith(
      "kaiban-hitl-decisions",
      JSON.stringify({ taskId: "task-42", decision: "PUBLISH", _signed: true }),
    );
  });

  it("calls ack with ok:true after successful Redis publish", async () => {
    sg.initialize();
    const mockSocket = makeMockSocket();
    connectionHandler!(mockSocket);

    const ack = vi.fn();
    getHitlHandler(mockSocket)({ taskId: "task-42", decision: "REVISE" }, ack);
    await Promise.resolve(); // flush microtasks (mockPublish resolves immediately)
    expect(ack).toHaveBeenCalledWith({ ok: true });
  });

  it("calls ack with ok:false for invalid payload", () => {
    sg.initialize();
    const mockSocket = makeMockSocket();
    connectionHandler!(mockSocket);

    const ack1 = vi.fn();
    const ack2 = vi.fn();
    getHitlHandler(mockSocket)(null, ack1);
    getHitlHandler(mockSocket)(
      { taskId: "task-1", decision: "BADVALUE" },
      ack2,
    );
    expect(ack1).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(ack2).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it("ignores invalid hitl:decision payloads without ack", () => {
    sg.initialize();
    const mockSocket = makeMockSocket();
    connectionHandler!(mockSocket);

    getHitlHandler(mockSocket)(null);
    getHitlHandler(mockSocket)({ taskId: "task-1", decision: "BADVALUE" });
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
