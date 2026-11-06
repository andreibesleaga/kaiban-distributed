/**
 * main/gateway — HTTP/WebSocket/A2A front door (Finding #1 fix / ADR-013).
 *
 * The gateway MUST NOT build any task-consuming AgentActor (that is the source of
 * the silent-discard bug). Verifies the gateway wires the driver, A2A stack,
 * socket gateway, and HTTP server — and NEVER constructs an AgentActor.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const h = vi.hoisted(() => {
  const socketInit = vi.fn();
  const socketShutdown = vi.fn(() => Promise.resolve());
  const socketDisconnect = vi.fn();
  const driverDisconnect = vi.fn(() => Promise.resolve());
  const a2aStart = vi.fn(() => Promise.resolve());
  const a2aClose = vi.fn(() => Promise.resolve());
  const listen = vi.fn((_port: number, cb: () => void) => cb());
  const serverClose = vi.fn((cb: (err?: Error) => void) => cb());
  const driverPublish = vi.fn(() => Promise.resolve());
  const getStatus = vi.fn(() => "IDLE");
  const hasSeen = vi.fn(() => true);
  const mcpClose = vi.fn(() => Promise.resolve());
  const mcpHandlePost = vi.fn(() => Promise.resolve());
  const mcpHandleSession = vi.fn(() => Promise.resolve());
  return {
    socketInit,
    socketShutdown,
    socketDisconnect,
    driverDisconnect,
    driverPublish,
    getStatus,
    hasSeen,
    mcpClose,
    a2aStart,
    a2aClose,
    listen,
    serverClose,
    BullMQDriver: vi.fn(function () {
      return { disconnect: driverDisconnect, publish: driverPublish };
    }),
    KafkaDriver: vi.fn(function () {
      return { disconnect: driverDisconnect, publish: driverPublish };
    }),
    AgentActor: vi.fn(function () {
      return { start: vi.fn(), stop: vi.fn() };
    }),
    SocketGateway: vi.fn(function () {
      return {
        initialize: socketInit,
        shutdown: socketShutdown,
        disconnectClients: socketDisconnect,
      };
    }),
    GatewayApp: vi.fn(function (_deps?: unknown) {
      return { app: {} };
    }),
    buildA2AStack: vi.fn(function () {
      return {
        requestHandler: {},
        statusTracker: { getStatus, hasSeen },
        taskStore: {},
        start: a2aStart,
        close: a2aClose,
      };
    }),
    createMcpHttpHandler: vi.fn(function (_deps?: unknown) {
      return {
        handlePost: mcpHandlePost,
        handleSession: mcpHandleSession,
        sessionCount: vi.fn(() => 0),
        close: mcpClose,
      };
    }),
    CompletionRouter: vi.fn(function () {
      return {};
    }),
    createDriver: vi.fn(function () {
      return { disconnect: driverDisconnect };
    }),
    getDriverType: vi.fn(() => "bullmq"),
    initTelemetry: vi.fn(),
    Redis: vi.fn(function () {
      return { ping: vi.fn(() => Promise.resolve("PONG")) };
    }),
    createServer: vi.fn(() => ({
      listen,
      close: serverClose,
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    })),
  };
});

vi.mock("ioredis", () => ({ Redis: h.Redis }));
vi.mock("http", () => ({ createServer: h.createServer }));
vi.mock("../../../src/infrastructure/telemetry/telemetry", () => ({
  initTelemetry: h.initTelemetry,
}));
vi.mock("../../../src/infrastructure/messaging/bullmq-driver", () => ({
  BullMQDriver: h.BullMQDriver,
}));
vi.mock("../../../src/infrastructure/messaging/kafka-driver", () => ({
  KafkaDriver: h.KafkaDriver,
}));
vi.mock("../../../src/application/actor/AgentActor", () => ({
  AgentActor: h.AgentActor,
}));
vi.mock("../../../src/shared/completion-router", () => ({
  CompletionRouter: h.CompletionRouter,
}));
vi.mock("../../../src/shared/driver-factory", () => ({
  createDriver: h.createDriver,
  getDriverType: h.getDriverType,
}));
vi.mock("../../../src/infrastructure/federation/a2a-gateway-factory", () => ({
  buildA2AStack: h.buildA2AStack,
}));
vi.mock("../../../src/infrastructure/federation/mcp-http", () => ({
  createMcpHttpHandler: h.createMcpHttpHandler,
}));
vi.mock("../../../src/adapters/gateway/GatewayApp", () => ({
  GatewayApp: h.GatewayApp,
}));
vi.mock("../../../src/adapters/gateway/SocketGateway", () => ({
  SocketGateway: h.SocketGateway,
}));
const control = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  opts: [] as Array<{ redisUrl: string; onStop: (cmd: unknown) => void }>,
}));
vi.mock("../../../src/infrastructure/control/control-channel", async (orig) => ({
  ...(await orig<typeof import("../../../src/infrastructure/control/control-channel")>()),
  ControlSubscriber: vi.fn(function (opts: { redisUrl: string; onStop: (cmd: unknown) => void }) {
    control.opts.push(opts);
    return { start: control.start, close: control.close };
  }),
}));

import { runGateway } from "../../../src/main/gateway";

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(__dirname, "../../../package.json"), "utf8")) as {
    version: string;
  }
).version;

const ORIGINAL_ENV = { ...process.env };
const handlers: Record<string, (...a: unknown[]) => void> = {};
let exitSpy: ReturnType<typeof vi.spyOn>;
let tlsDir: string;

beforeAll(() => {
  tlsDir = mkdtempSync(join(tmpdir(), "kaiban-gw-tls-"));
  for (const f of ["ca.pem", "cert.pem", "key.pem"]) {
    writeFileSync(join(tlsDir, f), "dummy");
  }
});

afterAll(() => {
  if (tlsDir) rmSync(tlsDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  h.getDriverType.mockReturnValue("bullmq");
  // Restore default mock implementations (clearAllMocks keeps impls, not calls).
  h.listen.mockImplementation((_port: number, cb: () => void) => cb());
  h.Redis.mockImplementation(function () {
    return { ping: vi.fn(() => Promise.resolve("PONG")) };
  });
  for (const k of Object.keys(handlers)) delete handlers[k];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as (
      code?: string | number | null,
    ) => never);
  vi.spyOn(process, "on").mockImplementation(((
    event: string,
    cb: (...a: unknown[]) => void,
  ) => {
    handlers[event] = cb;
    return process;
  }) as typeof process.on);
  process.env["AGENT_IDS"] = "gateway";
  process.env["REDIS_URL"] = "redis://localhost:6379";
  delete process.env["MESSAGING_DRIVER"];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("runGateway", () => {
  it("wires BullMQ + A2A stack + socket + HTTP and NEVER builds an AgentActor", async () => {
    process.env["MESSAGING_DRIVER"] = "bullmq";
    await runGateway();
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalled());

    expect(h.BullMQDriver).toHaveBeenCalledTimes(1);
    expect(h.buildA2AStack).toHaveBeenCalledTimes(1);
    // The agent card version comes from package.json, not a hard-coded string.
    expect(
      (h.buildA2AStack.mock.calls as unknown as [{ version: string }][])[0]![0].version,
    ).toBe(PACKAGE_VERSION);
    expect(h.a2aStart).toHaveBeenCalledTimes(1);
    expect(h.socketInit).toHaveBeenCalledTimes(1);
    // The critical guard: the gateway role consumes NO task channels.
    expect(h.AgentActor).not.toHaveBeenCalled();

    expect(handlers["SIGTERM"]).toBeDefined();
    await handlers["SIGTERM"]!();
    await vi.waitFor(() => expect(h.driverDisconnect).toHaveBeenCalled());
    expect(h.a2aClose).toHaveBeenCalledTimes(1);
    expect(h.socketShutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("shutdown ends the board sockets before waiting for the HTTP server (SEC-V-02)", async () => {
    process.env["MESSAGING_DRIVER"] = "bullmq";
    await runGateway();
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalled());
    await handlers["SIGTERM"]!();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());
    expect(h.socketDisconnect).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("gives A2A/MCP a socket limit beyond the task wait and the socket gateway the proxy setting (SEC-02, SEC-03)", async () => {
    process.env["MESSAGING_DRIVER"] = "bullmq";
    process.env["TRUST_PROXY"] = "true";
    process.env["AGENT_TIMEOUT_MS"] = "2000000";
    await runGateway();
    const appDeps = h.GatewayApp.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(appDeps["longRequestTimeoutMs"]).toBe(2_060_000);
    const socketOpts = (h.SocketGateway.mock.calls.at(-1) as unknown as unknown[])[3] as Record<string, unknown>;
    expect(socketOpts["trustProxy"]).toBe(true);
    delete process.env["TRUST_PROXY"];
    delete process.env["AGENT_TIMEOUT_MS"];
  });

  it("selects the Kafka driver and drains on SIGINT", async () => {
    process.env["MESSAGING_DRIVER"] = "kafka";
    h.getDriverType.mockReturnValue("kafka");
    await runGateway();
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalled());

    expect(h.KafkaDriver).toHaveBeenCalledTimes(1);
    expect(h.BullMQDriver).not.toHaveBeenCalled();
    expect(h.AgentActor).not.toHaveBeenCalled();
    // Kafka needs a separate failed-channel consumer group → two createDriver calls.
    expect(h.createDriver).toHaveBeenCalledTimes(2);

    expect(handlers["SIGINT"]).toBeDefined();
    await handlers["SIGINT"]!();
    await vi.waitFor(() => expect(h.driverDisconnect).toHaveBeenCalled());
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("wires readiness (Redis ping) + startup probes into the GatewayApp", async () => {
    process.env["MESSAGING_DRIVER"] = "bullmq";
    await runGateway();
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalled());

    const deps = h.GatewayApp.mock.calls[0]![0] as {
      readinessProbe: () => Promise<{ ready: boolean }>;
      startupProbe: () => Promise<{ ready: boolean }>;
    };
    // Readiness pings Redis → ready; startup is ready once listen() fired.
    expect((await deps.readinessProbe()).ready).toBe(true);
    expect((await deps.startupProbe()).ready).toBe(true);
  });

  it("readiness is NOT ready when the Redis ping does not return PONG", async () => {
    process.env["MESSAGING_DRIVER"] = "bullmq";
    h.Redis.mockImplementation(function () {
      return { ping: vi.fn(() => Promise.resolve("NOPE")) };
    });
    await runGateway();
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalled());

    const deps = h.GatewayApp.mock.calls[0]![0] as {
      readinessProbe: () => Promise<{ ready: boolean }>;
    };
    expect((await deps.readinessProbe()).ready).toBe(false);
  });

  it("startup is NOT ready before the server begins listening", async () => {
    process.env["MESSAGING_DRIVER"] = "bullmq";
    // Make listen() a no-op so the `listening` latch never flips during boot.
    h.listen.mockImplementationOnce(() => undefined);
    await runGateway();

    const deps = h.GatewayApp.mock.calls[0]![0] as {
      startupProbe: () => Promise<{ ready: boolean }>;
    };
    expect((await deps.startupProbe()).ready).toBe(false);
  });

  it("waits one attempt for a task by default and all attempts with RETRY_ON_TIMEOUT", async () => {
    process.env["MESSAGING_DRIVER"] = "bullmq";
    process.env["AGENT_TIMEOUT_MS"] = "1000";
    await runGateway();
    expect(
      (h.buildA2AStack.mock.calls as unknown as [{ timeoutMs: number }][])[0]![0].timeoutMs,
    ).toBe(1000);

    process.env["RETRY_ON_TIMEOUT"] = "true";
    await runGateway();
    expect(
      (h.buildA2AStack.mock.calls as unknown as [{ timeoutMs: number }][])[1]![0].timeoutMs,
    ).toBe(3 * 1000 + 100 + 200 + 5000);
  });

  it("exits non-zero when a shutdown step fails", async () => {
    process.env["MESSAGING_DRIVER"] = "bullmq";
    h.socketShutdown.mockRejectedValueOnce(new Error("socket drain failed"));
    await runGateway();
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalled());

    await handlers["SIGTERM"]!();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits non-zero when the HTTP server fails to close", async () => {
    process.env["MESSAGING_DRIVER"] = "bullmq";
    // server.close invokes its callback with an error → closeServer rejects.
    h.serverClose.mockImplementationOnce((cb: (err?: Error) => void) =>
      cb(new Error("close failed")),
    );
    await runGateway();
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalled());

    await handlers["SIGTERM"]!();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("constructs the socket Redis clients with TLS options when configured", async () => {
    process.env["MESSAGING_DRIVER"] = "bullmq";
    process.env["REDIS_TLS_CA"] = join(tlsDir, "ca.pem");
    process.env["REDIS_TLS_CERT"] = join(tlsDir, "cert.pem");
    process.env["REDIS_TLS_KEY"] = join(tlsDir, "key.pem");
    await runGateway();
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalled());
    // pub + sub + hitl = 3 Redis clients, each with TLS options.
    expect(h.Redis).toHaveBeenCalledTimes(3);
    const redisCalls = h.Redis.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >;
    expect(redisCalls[0][1]).toHaveProperty("tls");
  });

  it("does NOT build an MCP handler when MCP_SERVER_ENABLED is unset", async () => {
    process.env["MESSAGING_DRIVER"] = "bullmq";
    await runGateway();
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalled());
    expect(h.createMcpHttpHandler).not.toHaveBeenCalled();
    const deps = h.GatewayApp.mock.calls[0]![0] as Record<string, unknown>;
    expect(deps["mcpHandler"]).toBeUndefined();
  });

  it("wires the env-gated MCP handler and drains it on shutdown", async () => {
    process.env["MESSAGING_DRIVER"] = "bullmq";
    process.env["MCP_SERVER_ENABLED"] = "true";
    await runGateway();
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalled());

    expect(h.createMcpHttpHandler).toHaveBeenCalledTimes(1);
    const gwDeps = h.GatewayApp.mock.calls[0]![0] as {
      mcpHandler: unknown;
      mcpPath: string;
    };
    expect(gwDeps.mcpHandler).toBeDefined();
    expect(gwDeps.mcpPath).toBe("/mcp");

    // Exercise the injected capability closures.
    const mcpDeps = h.createMcpHttpHandler.mock.calls[0]![0] as {
      requireDispatchConsent: boolean;
      allow: Record<string, unknown>;
      dispatchTask: (i: {
        agentId: string;
        instruction: string;
        expectedOutput?: string;
      }) => Promise<{ taskId: string; status: string }>;
      listAgents: () => Array<{ id: string; status: string }>;
      getAgentStatus: (id: string) => {
        agentId: string;
        status: string;
        seen: boolean;
      };
    };
    expect(mcpDeps.requireDispatchConsent).toBe(true);
    expect(mcpDeps.allow).toEqual({});

    const dispatched = await mcpDeps.dispatchTask({
      agentId: "gateway",
      instruction: "do it",
      expectedOutput: "x",
    });
    expect(dispatched.status).toBe("submitted");
    expect(h.driverPublish).toHaveBeenCalledWith(
      "kaiban-agents-gateway",
      expect.objectContaining({
        agentId: "gateway",
        data: { instruction: "do it", expectedOutput: "x" },
      }),
    );

    // expectedOutput omitted when absent.
    await mcpDeps.dispatchTask({ agentId: "gateway", instruction: "again" });
    expect(h.driverPublish).toHaveBeenLastCalledWith(
      "kaiban-agents-gateway",
      expect.objectContaining({ data: { instruction: "again" } }),
    );

    // Invalid input rejects before any publish.
    await expect(
      mcpDeps.dispatchTask({ agentId: "", instruction: "x" }),
    ).rejects.toThrow("agentId is required");

    // An id outside AGENT_IDS never reaches a queue (SEC-05).
    h.driverPublish.mockClear();
    await expect(
      mcpDeps.dispatchTask({ agentId: "stranger", instruction: "x" }),
    ).rejects.toThrow("Unknown agentId");
    expect(h.driverPublish).not.toHaveBeenCalled();

    expect(mcpDeps.listAgents()).toEqual([{ id: "gateway", status: "IDLE" }]);
    expect(mcpDeps.getAgentStatus("gateway")).toEqual({
      agentId: "gateway",
      status: "IDLE",
      seen: true,
    });

    // SIGTERM drains the MCP handler.
    await handlers["SIGTERM"]!();
    await vi.waitFor(() => expect(h.mcpClose).toHaveBeenCalledTimes(1));
  });

  it("passes allow-list filters through to the MCP handler", async () => {
    process.env["MESSAGING_DRIVER"] = "bullmq";
    process.env["MCP_SERVER_ENABLED"] = "true";
    process.env["MCP_ALLOWED_TOOLS"] = "dispatch_task";
    process.env["MCP_ALLOWED_RESOURCES"] = "agents";
    process.env["MCP_ALLOWED_PROMPTS"] = "delegate_task";
    await runGateway();
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalled());

    const mcpDeps = h.createMcpHttpHandler.mock.calls[0]![0] as {
      allow: Record<string, string[]>;
    };
    expect(mcpDeps.allow).toEqual({
      tools: ["dispatch_task"],
      resources: ["agents"],
      prompts: ["delegate_task"],
    });
  });
});

describe("runGateway — emergency STOP ALL (ADR-025)", () => {
  it("control plane off (default): no ingress on the HTTP app or the socket gateway", async () => {
    control.start.mockClear();
    await runGateway();
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalled());
    const appDeps = h.GatewayApp.mock.calls[0]![0] as Record<string, unknown>;
    expect(appDeps["emergencyStop"]).toBeUndefined();
    const socketOpts = (h.SocketGateway.mock.calls[0] as unknown as unknown[])[3] as Record<string, unknown>;
    expect(socketOpts["control"]).toBeUndefined();
    expect(control.start).not.toHaveBeenCalled();
    handlers["SIGTERM"]!();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());
  });

  it("control plane on: one ingress shared by the HTTP route and the socket event", async () => {
    process.env["CONTROL_PLANE_ENABLED"] = "true";
    process.env["BOARD_JWT_SECRET"] = "x".repeat(32);
    await runGateway();
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalled());
    const appDeps = h.GatewayApp.mock.calls[0]![0] as Record<string, unknown>;
    const socketOpts = (h.SocketGateway.mock.calls[0] as unknown as unknown[])[3] as Record<string, unknown>;
    expect(appDeps["emergencyStop"]).toBeDefined();
    expect(socketOpts["control"]).toBe(appDeps["emergencyStop"]);
    // The gateway watches the control channel and feeds every stop to the boards.
    expect(control.start).toHaveBeenCalled();
    const sg = h.SocketGateway.mock.results[0]!.value as { noteStop?: ReturnType<typeof vi.fn> };
    sg.noteStop = vi.fn();
    control.opts.at(-1)!.onStop({ commandId: "c", issuedAt: 1, issuedBy: "x" });
    expect(sg.noteStop).toHaveBeenCalledWith({ commandId: "c", issuedAt: 1, issuedBy: "x" });
    handlers["SIGTERM"]!();
    await vi.waitFor(() => expect(control.close).toHaveBeenCalled());
  });

  it("control plane on without BOARD_JWT_SECRET: still mounted, but warns that every stop is refused", async () => {
    process.env["CONTROL_PLANE_ENABLED"] = "true";
    delete process.env["BOARD_JWT_SECRET"];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runGateway();
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalled());
    const appDeps = h.GatewayApp.mock.calls[0]![0] as Record<string, unknown>;
    expect(appDeps["emergencyStop"]).toBeDefined();
    warn.mockRestore();
  });
});
