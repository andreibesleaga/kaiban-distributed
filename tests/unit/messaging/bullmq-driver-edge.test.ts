/**
 * BullMQDriver — edge cases and TLS constructor branch coverage.
 *
 * Covers: TLS constructor path (line 19), multi-queue isolation,
 * publish job name, concurrent operations, disconnect edge cases.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BullMQDriver } from "../../../src/infrastructure/messaging/bullmq-driver";
import { Queue, Worker } from "bullmq";

const mockWorkerClose = vi.fn();
const mockQueueClose = vi.fn();
const mockQueueAdd = vi.fn().mockResolvedValue({ id: "j" });

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(function (name: string) {
    return { add: mockQueueAdd, close: mockQueueClose, _name: name };
  }),
  Worker: vi.fn().mockImplementation(function (
    name: string,
    processor: (job: { data: unknown }) => Promise<void>,
  ) {
    return { close: mockWorkerClose, _processor: processor, _name: name };
  }),
}));

vi.mock("@opentelemetry/api", () => ({
  context: {
    active: vi.fn().mockReturnValue({}),
    with: vi.fn().mockImplementation((_ctx, fn) => fn()),
  },
  propagation: { inject: vi.fn(), extract: vi.fn().mockReturnValue({}) },
  ROOT_CONTEXT: {},
}));

describe("BullMQDriver — TLS constructor (line 19 branch)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges TLS config into connection when tls is provided", () => {
    const tls = {
      ca: Buffer.from("ca-cert"),
      cert: Buffer.from("client-cert"),
      key: Buffer.from("client-key"),
      rejectUnauthorized: true,
    };
    const driver = new BullMQDriver({
      connection: { host: "redis", port: 6380 },
      tls,
    });
    // Trigger Queue creation to expose the stored config
    void driver.publish("q", {
      taskId: "t",
      agentId: "a",
      data: {},
      timestamp: 0,
    });
    const queueCtor = vi.mocked(Queue).mock.calls[0];
    const opts = queueCtor[1] as { connection: Record<string, unknown> };
    expect(opts.connection["tls"]).toBeDefined();
    expect((opts.connection["tls"] as Record<string, unknown>)["ca"]).toBe(
      tls.ca,
    );
    expect(
      (opts.connection["tls"] as Record<string, unknown>)["rejectUnauthorized"],
    ).toBe(true);
  });

  it("does NOT include tls in connection when tls is omitted", async () => {
    const driver = new BullMQDriver({
      connection: { host: "redis", port: 6379 },
    });
    await driver.publish("q", {
      taskId: "t",
      agentId: "a",
      data: {},
      timestamp: 0,
    });
    const opts = vi.mocked(Queue).mock.calls[0][1] as {
      connection: Record<string, unknown>;
    };
    expect(opts.connection["tls"]).toBeUndefined();
  });

  it("TLS driver publishes successfully using the merged connection config", async () => {
    const tls = {
      ca: Buffer.from("ca"),
      cert: Buffer.from("c"),
      key: Buffer.from("k"),
      rejectUnauthorized: false,
    };
    const driver = new BullMQDriver({
      connection: { host: "redis", port: 6380 },
      tls,
    });
    await driver.publish("queue", {
      taskId: "task-tls",
      agentId: "a",
      data: {},
      timestamp: 0,
    });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "task-tls",
      expect.objectContaining({ taskId: "task-tls" }),
    );
  });
});

describe("BullMQDriver — multi-queue isolation", () => {
  const cfg = { connection: { host: "localhost", port: 6379 } };
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates separate Queue instances for different queue names", async () => {
    const driver = new BullMQDriver(cfg);
    await driver.publish("q1", {
      taskId: "t1",
      agentId: "a",
      data: {},
      timestamp: 0,
    });
    await driver.publish("q2", {
      taskId: "t2",
      agentId: "a",
      data: {},
      timestamp: 0,
    });
    expect(Queue).toHaveBeenCalledTimes(2);
  });

  it("creates separate Worker instances for different queue subscriptions", async () => {
    const driver = new BullMQDriver(cfg);
    await driver.subscribe("q1", vi.fn());
    await driver.subscribe("q2", vi.fn());
    expect(Worker).toHaveBeenCalledTimes(2);
  });

  it("uses taskId as the BullMQ job name", async () => {
    const driver = new BullMQDriver(cfg);
    await driver.publish("q", {
      taskId: "my-task-123",
      agentId: "a",
      data: {},
      timestamp: 0,
    });
    expect(mockQueueAdd).toHaveBeenCalledWith("my-task-123", expect.anything());
  });

  it("disconnect closes all queues and workers from different queue names", async () => {
    const driver = new BullMQDriver(cfg);
    await driver.publish("q1", {
      taskId: "t1",
      agentId: "a",
      data: {},
      timestamp: 0,
    });
    await driver.publish("q2", {
      taskId: "t2",
      agentId: "a",
      data: {},
      timestamp: 0,
    });
    await driver.subscribe("q1", vi.fn());
    await driver.subscribe("q2", vi.fn());
    await driver.disconnect();
    expect(mockQueueClose).toHaveBeenCalledTimes(2);
    expect(mockWorkerClose).toHaveBeenCalledTimes(2);
  });

  it("disconnect on fresh driver (no queues/workers) does not throw", async () => {
    const driver = new BullMQDriver(cfg);
    await expect(driver.disconnect()).resolves.toBeUndefined();
  });

  it("unsubscribe then re-subscribe creates a new worker on the same queue", async () => {
    const driver = new BullMQDriver(cfg);
    await driver.subscribe("q", vi.fn());
    await driver.unsubscribe("q");
    await driver.subscribe("q", vi.fn());
    expect(Worker).toHaveBeenCalledTimes(2);
  });

  it("worker processor passes full payload including all fields", async () => {
    const driver = new BullMQDriver(cfg);
    const received: unknown[] = [];
    await driver.subscribe("q", async (p) => {
      received.push(p);
    });
    const processor = vi.mocked(Worker).mock.calls[0][1] as (job: {
      data: unknown;
    }) => Promise<void>;
    const payload = {
      taskId: "t",
      agentId: "a",
      data: { foo: "bar" },
      timestamp: 999,
      traceHeaders: {},
    };
    await processor({ data: payload });
    expect(received[0]).toMatchObject({
      taskId: "t",
      data: { foo: "bar" },
      timestamp: 999,
    });
  });
});

describe("BullMQDriver — publish payload enrichment", () => {
  const cfg = { connection: { host: "localhost", port: 6379 } };
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds traceHeaders to the published payload", async () => {
    const driver = new BullMQDriver(cfg);
    await driver.publish("q", {
      taskId: "t",
      agentId: "a",
      data: { x: 1 },
      timestamp: 0,
    });
    const published = mockQueueAdd.mock.calls[0][1] as Record<string, unknown>;
    expect(published["traceHeaders"]).toBeDefined();
    expect(typeof published["traceHeaders"]).toBe("object");
  });

  it("preserves original payload fields alongside traceHeaders", async () => {
    const driver = new BullMQDriver(cfg);
    const original = {
      taskId: "orig-task",
      agentId: "agent-x",
      data: { key: "val" },
      timestamp: 12345,
    };
    await driver.publish("q", original);
    const published = mockQueueAdd.mock.calls[0][1] as Record<string, unknown>;
    expect(published["taskId"]).toBe("orig-task");
    expect(published["agentId"]).toBe("agent-x");
    expect((published["data"] as Record<string, string>)["key"]).toBe("val");
    expect(published["timestamp"]).toBe(12345);
  });
});
