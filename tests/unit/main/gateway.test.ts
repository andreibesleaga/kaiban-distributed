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
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const h = vi.hoisted(() => {
  const socketInit = vi.fn();
  const socketShutdown = vi.fn(() => Promise.resolve());
  const driverDisconnect = vi.fn(() => Promise.resolve());
  const a2aStart = vi.fn(() => Promise.resolve());
  const a2aClose = vi.fn(() => Promise.resolve());
  const listen = vi.fn((_port: number, cb: () => void) => cb());
  const serverClose = vi.fn((cb: (err?: Error) => void) => cb());
  return {
    socketInit,
    socketShutdown,
    driverDisconnect,
    a2aStart,
    a2aClose,
    listen,
    serverClose,
    BullMQDriver: vi.fn(function () {
      return { disconnect: driverDisconnect };
    }),
    KafkaDriver: vi.fn(function () {
      return { disconnect: driverDisconnect };
    }),
    AgentActor: vi.fn(function () {
      return { start: vi.fn(), stop: vi.fn() };
    }),
    SocketGateway: vi.fn(function () {
      return { initialize: socketInit, shutdown: socketShutdown };
    }),
    GatewayApp: vi.fn(function (_deps?: unknown) {
      return { app: {} };
    }),
    buildA2AStack: vi.fn(function () {
      return {
        requestHandler: {},
        statusTracker: {},
        taskStore: {},
        start: a2aStart,
        close: a2aClose,
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
    createServer: vi.fn(() => ({ listen, close: serverClose })),
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
vi.mock("../../../src/adapters/gateway/GatewayApp", () => ({
  GatewayApp: h.GatewayApp,
}));
vi.mock("../../../src/adapters/gateway/SocketGateway", () => ({
  SocketGateway: h.SocketGateway,
}));

import { runGateway } from "../../../src/main/gateway";

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
});
