/**
 * The shared Redis connection helper: REDIS_URL (password, user, db,
 * `rediss://`) and REDIS_TLS_* must reach every Redis client and the BullMQ
 * and Kafka drivers. One test per call site proves the options arrive.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const h = vi.hoisted(() => ({
  Redis: vi.fn(),
  BullMQDriver: vi.fn(),
  KafkaDriver: vi.fn(),
}));

vi.mock("ioredis", () => ({
  Redis: h.Redis.mockImplementation(function () {
    return {
      on: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(1),
      get: vi.fn().mockResolvedValue(null),
      quit: vi.fn().mockResolvedValue("OK"),
      disconnect: vi.fn(),
      brpop: vi.fn(() => new Promise(() => {})),
      defineCommand: vi.fn(),
    };
  }),
}));
vi.mock("../../../src/infrastructure/messaging/bullmq-driver", () => ({
  BullMQDriver: h.BullMQDriver,
}));
vi.mock("../../../src/infrastructure/messaging/kafka-driver", () => ({
  KafkaDriver: h.KafkaDriver,
}));

import {
  createRedisClient,
  redisClientOptions,
  redisConnectionFromUrl,
} from "../../../src/shared/redis-connection";
import { createDriver } from "../../../src/shared/driver-factory";
import { buildMessagingDriver } from "../../../src/main/runtime";
import { loadConfig } from "../../../src/main/config";
import { AgentStatePublisher } from "../../../src/adapters/state/agent-state-publisher";
import { DistributedStateMiddleware } from "../../../src/adapters/state/distributedMiddleware";
import { ControlSubscriber } from "../../../src/infrastructure/control/control-channel";
import { RedisTaskStore } from "../../../src/infrastructure/federation/a2a-task-store";
import { AgentStatusTracker } from "../../../src/infrastructure/federation/agent-status-tracker";
import { OrchestratorStatePublisher } from "../../../src/shared/orchestrator-state-publisher";
import { RedisCheckpointStore } from "../../../src/shared/orchestrator";
import { connectRedis } from "../../../src/main/stop-all";
import { waitForHITLDecision } from "../../../src/shared/hitl";

const URL_WITH_AUTH = "rediss://default:p%40ss@cache.example:6380/2";
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kaiban-tls-"));
  for (const f of ["ca", "cert", "key"])
    writeFileSync(join(dir, `${f}.pem`), f);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ENV_KEYS = [
  "REDIS_URL",
  "REDIS_TLS_CA",
  "REDIS_TLS_CERT",
  "REDIS_TLS_KEY",
  "KAFKA_SSL_CA",
  "KAFKA_SSL_CERT",
  "KAFKA_SSL_KEY",
  "MESSAGING_DRIVER",
  "AGENT_IDS",
  "TLS_REJECT_UNAUTHORIZED",
];
function setRedisTls(): void {
  process.env["REDIS_TLS_CA"] = join(dir, "ca.pem");
  process.env["REDIS_TLS_CERT"] = join(dir, "cert.pem");
  process.env["REDIS_TLS_KEY"] = join(dir, "key.pem");
}
function lastRedisOptions(): Record<string, unknown> {
  const calls = h.Redis.mock.calls;
  return calls[calls.length - 1]![1] as Record<string, unknown>;
}
function expectMtls(opts: Record<string, unknown>): void {
  expect(opts["tls"]).toEqual({
    ca: Buffer.from("ca"),
    cert: Buffer.from("cert"),
    key: Buffer.from("key"),
    rejectUnauthorized: true,
  });
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.clearAllMocks();
});

describe("redisConnectionFromUrl", () => {
  it("keeps only host and port for a plain URL", () => {
    expect(redisConnectionFromUrl("redis://h:6381")).toEqual({
      host: "h",
      port: 6381,
    });
  });
  it("defaults to localhost:6379", () => {
    expect(redisConnectionFromUrl()).toEqual({ host: "localhost", port: 6379 });
  });
  it("carries user, decoded password, db and rediss TLS", () => {
    expect(redisConnectionFromUrl(URL_WITH_AUTH)).toEqual({
      host: "cache.example",
      port: 6380,
      username: "default",
      password: "p@ss",
      db: 2,
      tls: {},
    });
  });
  it("accepts a password-only URL", () => {
    expect(redisConnectionFromUrl("redis://:s3cret@r:6379")).toEqual({
      host: "r",
      port: 6379,
      password: "s3cret",
    });
  });
  it("adds the client certificate when mTLS material is given", () => {
    setRedisTls();
    const conn = redisConnectionFromUrl("redis://r:6379", {
      ca: Buffer.from("ca"),
      cert: Buffer.from("cert"),
      key: Buffer.from("key"),
      rejectUnauthorized: false,
    });
    expect(conn.tls).toMatchObject({ rejectUnauthorized: false });
  });
});

describe("redisClientOptions / createRedisClient", () => {
  it("returns the extras untouched without REDIS_TLS_*", () => {
    expect(redisClientOptions({ lazyConnect: false })).toEqual({
      lazyConnect: false,
    });
  });
  it("adds the REDIS_TLS_* client certificate", () => {
    setRedisTls();
    expectMtls(
      redisClientOptions({ lazyConnect: false }) as Record<string, unknown>,
    );
  });
  it("honours TLS_REJECT_UNAUTHORIZED=false", () => {
    setRedisTls();
    process.env["TLS_REJECT_UNAUTHORIZED"] = "false";
    expect(redisClientOptions().tls).toMatchObject({
      rejectUnauthorized: false,
    });
  });
  it("passes the full URL (password, db) to ioredis", () => {
    createRedisClient(URL_WITH_AUTH);
    expect(h.Redis).toHaveBeenCalledWith(URL_WITH_AUTH, {});
  });
});

describe("drivers", () => {
  it("createDriver: BullMQ gets password, user, db and TLS from REDIS_URL", () => {
    process.env["REDIS_URL"] = URL_WITH_AUTH;
    createDriver("w");
    expect(h.BullMQDriver).toHaveBeenCalledWith({
      connection: expect.objectContaining({
        host: "cache.example",
        port: 6380,
        username: "default",
        password: "p@ss",
        db: 2,
      }),
    });
  });
  it("createDriver: BullMQ gets the REDIS_TLS_* client certificate", () => {
    setRedisTls();
    createDriver("w");
    expectMtls(h.BullMQDriver.mock.calls[0]![0] as Record<string, unknown>);
  });
  it("createDriver: Kafka gets KAFKA_SSL_*", () => {
    process.env["MESSAGING_DRIVER"] = "kafka";
    process.env["KAFKA_SSL_CA"] = join(dir, "ca.pem");
    process.env["KAFKA_SSL_CERT"] = join(dir, "cert.pem");
    process.env["KAFKA_SSL_KEY"] = join(dir, "key.pem");
    createDriver("w");
    expect(h.KafkaDriver.mock.calls[0]![0]).toMatchObject({
      ssl: {
        ca: Buffer.from("ca"),
        cert: Buffer.from("cert"),
        key: Buffer.from("key"),
      },
    });
  });
  it("createDriver: Kafka has no ssl key without KAFKA_SSL_*", () => {
    process.env["MESSAGING_DRIVER"] = "kafka";
    createDriver("w");
    expect(h.KafkaDriver.mock.calls[0]![0]).not.toHaveProperty("ssl");
  });
  it("buildMessagingDriver: the gateway's dispatch driver gets password and db", () => {
    process.env["AGENT_IDS"] = "a";
    process.env["REDIS_URL"] = URL_WITH_AUTH;
    buildMessagingDriver(loadConfig());
    expect(h.BullMQDriver.mock.calls[0]![0]).toMatchObject({
      connection: { password: "p@ss", username: "default", db: 2, port: 6380 },
    });
  });
});

describe("every ioredis call site receives REDIS_TLS_* and the full URL", () => {
  beforeEach(() => {
    setRedisTls();
  });
  const info = { id: "a", name: "A", role: "r", kind: "worker" } as never;

  it("AgentStatePublisher", () => {
    new AgentStatePublisher(URL_WITH_AUTH, info);
    expect(h.Redis.mock.calls[0]![0]).toBe(URL_WITH_AUTH);
    expectMtls(lastRedisOptions());
  });
  it("DistributedStateMiddleware", () => {
    new DistributedStateMiddleware(URL_WITH_AUTH);
    expectMtls(lastRedisOptions());
  });
  it("ControlSubscriber (subscriber and reader)", async () => {
    const sub = new ControlSubscriber({
      redisUrl: URL_WITH_AUTH,
      onCommand: vi.fn(),
    } as never);
    await sub.start().catch(() => undefined);
    expect(h.Redis).toHaveBeenCalledTimes(2);
    for (const call of h.Redis.mock.calls) {
      expect(call[0]).toBe(URL_WITH_AUTH);
      expectMtls(call[1] as Record<string, unknown>);
    }
  });
  it("RedisTaskStore (A2A task store)", () => {
    new RedisTaskStore(URL_WITH_AUTH);
    expectMtls(lastRedisOptions());
  });
  it("AgentStatusTracker", () => {
    new AgentStatusTracker(URL_WITH_AUTH);
    expectMtls(lastRedisOptions());
  });
  it("OrchestratorStatePublisher", () => {
    new OrchestratorStatePublisher(URL_WITH_AUTH);
    expectMtls(lastRedisOptions());
  });
  it("RedisCheckpointStore", () => {
    new RedisCheckpointStore(URL_WITH_AUTH);
    expectMtls(lastRedisOptions());
  });
  it("stop-all CLI client", () => {
    connectRedis(URL_WITH_AUTH);
    expect(h.Redis.mock.calls[0]![0]).toBe(URL_WITH_AUTH);
    expectMtls(lastRedisOptions());
    expect(lastRedisOptions()).toMatchObject({ maxRetriesPerRequest: 2 });
  });
  it("HITL subscriber and poller", () => {
    void waitForHITLDecision({
      redisUrl: URL_WITH_AUTH,
      taskId: "t",
      timeoutMs: 1,
    } as never).catch(() => undefined);
    expect(h.Redis.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of h.Redis.mock.calls)
      expectMtls(call[1] as Record<string, unknown>);
  });
});
