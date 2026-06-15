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

// ── Shared mock state (hoisted so vi.mock factories can reference it) ─────────
const h = vi.hoisted(() => {
  const actorStart = vi.fn(() => Promise.resolve());
  const actorStop = vi.fn(() => Promise.resolve());
  const socketInit = vi.fn();
  const socketShutdown = vi.fn(() => Promise.resolve());
  const driverDisconnect = vi.fn(() => Promise.resolve());
  const listen = vi.fn((_port: number, cb: () => void) => cb());
  // Constructor mocks MUST use `function` expressions (arrows are not
  // constructable and `new X()` would throw "is not a constructor").
  return {
    actorStart,
    actorStop,
    socketInit,
    socketShutdown,
    driverDisconnect,
    listen,
    BullMQDriver: vi.fn(function () {
      return { disconnect: driverDisconnect };
    }),
    KafkaDriver: vi.fn(function () {
      return { disconnect: driverDisconnect };
    }),
    AgentActor: vi.fn(function () {
      return { start: actorStart, stop: actorStop };
    }),
    SocketGateway: vi.fn(function () {
      return { initialize: socketInit, shutdown: socketShutdown };
    }),
    GatewayApp: vi.fn(function () {
      return { app: {} };
    }),
    A2AConnector: vi.fn(function () {
      return {};
    }),
    HeuristicFirewall: vi.fn(function () {
      return {};
    }),
    SlidingWindowBreaker: vi.fn(function () {
      return {};
    }),
    EnvTokenProvider: vi.fn(function () {
      return {};
    }),
    initTelemetry: vi.fn(),
    Redis: vi.fn(function () {
      return {};
    }),
    createServer: vi.fn(() => ({ listen })),
  };
});

vi.mock("dotenv/config", () => ({}));
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
vi.mock("../../../src/infrastructure/federation/a2a-connector", () => ({
  A2AConnector: h.A2AConnector,
}));
vi.mock("../../../src/adapters/gateway/GatewayApp", () => ({
  GatewayApp: h.GatewayApp,
}));
vi.mock("../../../src/adapters/gateway/SocketGateway", () => ({
  SocketGateway: h.SocketGateway,
}));
vi.mock("../../../src/infrastructure/security/heuristic-firewall", () => ({
  HeuristicFirewall: h.HeuristicFirewall,
}));
vi.mock("../../../src/infrastructure/security/env-token-provider", () => ({
  EnvTokenProvider: h.EnvTokenProvider,
}));
vi.mock("../../../src/infrastructure/security/sliding-window-breaker", () => ({
  SlidingWindowBreaker: h.SlidingWindowBreaker,
}));

const handlers: Record<string, (...a: unknown[]) => void> = {};
const ORIGINAL_ENV = { ...process.env };
let exitSpy: ReturnType<typeof vi.spyOn>;
let tlsDir: string;

beforeAll(() => {
  tlsDir = mkdtempSync(join(tmpdir(), "kaiban-tls-"));
  for (const f of ["ca.pem", "cert.pem", "key.pem"]) {
    writeFileSync(join(tlsDir, f), "dummy");
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  for (const k of Object.keys(handlers)) delete handlers[k];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as (code?: number) => never);
  vi.spyOn(process, "on").mockImplementation(((
    event: string,
    cb: (...a: unknown[]) => void,
  ) => {
    handlers[event] = cb;
    return process;
  }) as typeof process.on);
  // minimal valid config
  process.env["AGENT_IDS"] = "alpha,beta";
  process.env["REDIS_URL"] = "redis://localhost:6379";
  delete process.env["MESSAGING_DRIVER"];
  for (const k of [
    "SEMANTIC_FIREWALL_ENABLED",
    "CIRCUIT_BREAKER_ENABLED",
    "JIT_TOKENS_ENABLED",
    "REDIS_TLS_CA",
    "REDIS_TLS_CERT",
    "REDIS_TLS_KEY",
  ]) {
    delete process.env[k];
  }
});

describe("main/index bootstrap", () => {
  it("wires BullMQ driver, no security, no TLS, and drains on SIGTERM", async () => {
    process.env["MESSAGING_DRIVER"] = "bullmq";
    await import("../../../src/main/index");
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalled());

    expect(h.BullMQDriver).toHaveBeenCalledTimes(1);
    expect(h.KafkaDriver).not.toHaveBeenCalled();
    expect(h.HeuristicFirewall).not.toHaveBeenCalled();
    expect(h.AgentActor).toHaveBeenCalledTimes(2); // alpha + beta
    expect(h.socketInit).toHaveBeenCalledTimes(1);
    expect(h.actorStart).toHaveBeenCalledTimes(2);
    expect(handlers["SIGTERM"]).toBeDefined();

    await handlers["SIGTERM"]!();
    await vi.waitFor(() => expect(h.driverDisconnect).toHaveBeenCalled());
    expect(h.actorStop).toHaveBeenCalledTimes(2);
    expect(h.socketShutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("wires Kafka driver, all security enabled, redis TLS, and drains on SIGINT", async () => {
    process.env["MESSAGING_DRIVER"] = "kafka";
    process.env["SEMANTIC_FIREWALL_ENABLED"] = "true";
    process.env["CIRCUIT_BREAKER_ENABLED"] = "true";
    process.env["JIT_TOKENS_ENABLED"] = "true";
    process.env["REDIS_TLS_CA"] = join(tlsDir, "ca.pem");
    process.env["REDIS_TLS_CERT"] = join(tlsDir, "cert.pem");
    process.env["REDIS_TLS_KEY"] = join(tlsDir, "key.pem");

    await import("../../../src/main/index");
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalled());

    expect(h.KafkaDriver).toHaveBeenCalledTimes(1);
    expect(h.BullMQDriver).not.toHaveBeenCalled();
    expect(h.HeuristicFirewall).toHaveBeenCalledTimes(1);
    expect(h.SlidingWindowBreaker).toHaveBeenCalledTimes(1);
    expect(h.EnvTokenProvider).toHaveBeenCalledTimes(1);
    // Redis constructed with TLS options (pub + sub + hitl = 3)
    expect(h.Redis).toHaveBeenCalledTimes(3);

    expect(handlers["SIGINT"]).toBeDefined();
    await handlers["SIGINT"]!();
    await vi.waitFor(() => expect(h.driverDisconnect).toHaveBeenCalled());
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits non-zero on fatal startup error (missing AGENT_IDS)", async () => {
    delete process.env["AGENT_IDS"];
    await import("../../../src/main/index");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    expect(h.listen).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  if (tlsDir) rmSync(tlsDir, { recursive: true, force: true });
});
