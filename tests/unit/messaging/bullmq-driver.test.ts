import { describe, it, expect, vi, beforeEach } from "vitest";
import { BullMQDriver } from "../../../src/infrastructure/messaging/bullmq-driver";
import { Queue, Worker } from "bullmq";

const mockWorkerClose = vi.fn();
const mockQueueClose = vi.fn();
const mockQueueAdd = vi.fn().mockResolvedValue({ id: "j" });

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(function () {
    return { add: mockQueueAdd, close: mockQueueClose };
  }),
  Worker: vi.fn().mockImplementation(function (_name: string, processor: (job: { data: unknown }) => Promise<void>) {
    return { close: mockWorkerClose, _processor: processor };
  }),
}));

vi.mock("@opentelemetry/api", () => ({
  context: { active: vi.fn().mockReturnValue({}), with: vi.fn().mockImplementation((_ctx, fn) => fn()) },
  propagation: { inject: vi.fn(), extract: vi.fn().mockReturnValue({}) },
  ROOT_CONTEXT: {},
}));

describe("BullMQDriver", () => {
  const cfg = { connection: { host: "localhost", port: 6379 } };
  beforeEach(() => { vi.clearAllMocks(); });

  it("creates a Queue on first publish", async () => {
    const driver = new BullMQDriver(cfg);
    await driver.publish("q", { taskId: "t", agentId: "a", data: {}, timestamp: 0 });
    expect(Queue).toHaveBeenCalledOnce();
  });

  it("reuses Queue on second publish to same queue", async () => {
    const driver = new BullMQDriver(cfg);
    await driver.publish("q", { taskId: "t", agentId: "a", data: {}, timestamp: 0 });
    await driver.publish("q", { taskId: "t2", agentId: "a", data: {}, timestamp: 0 });
    expect(Queue).toHaveBeenCalledOnce();
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
  });

  it("injects trace headers into published payload", async () => {
    const driver = new BullMQDriver(cfg);
    await driver.publish("q", { taskId: "t", agentId: "a", data: {}, timestamp: 0 });
    const published = mockQueueAdd.mock.calls[0][1] as { traceHeaders: unknown };
    expect(published.traceHeaders).toBeDefined();
  });

  it("creates Worker on first subscribe", async () => {
    const driver = new BullMQDriver(cfg);
    await driver.subscribe("q", vi.fn());
    expect(Worker).toHaveBeenCalledOnce();
  });

  it("reuses Worker on second subscribe to same queue", async () => {
    const driver = new BullMQDriver(cfg);
    await driver.subscribe("q", vi.fn());
    await driver.subscribe("q", vi.fn());
    expect(Worker).toHaveBeenCalledOnce();
  });

  it("Worker processor extracts trace context and calls handler", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const driver = new BullMQDriver(cfg);
    await driver.subscribe("q", handler);
    const processor = vi.mocked(Worker).mock.calls[0][1] as (job: { data: unknown }) => Promise<void>;
    const payload = { taskId: "t", agentId: "a", data: {}, timestamp: 0, traceHeaders: {} };
    await processor({ data: payload });
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it("unsubscribe() closes the worker (worker exists — true branch)", async () => {
    const driver = new BullMQDriver(cfg);
    await driver.subscribe("q", vi.fn());
    await driver.unsubscribe("q");
    expect(mockWorkerClose).toHaveBeenCalledOnce();
  });

  it("unsubscribe() does nothing when queue not subscribed (worker undefined — false branch)", async () => {
    const driver = new BullMQDriver(cfg);
    await driver.unsubscribe("never-subscribed");
    expect(mockWorkerClose).not.toHaveBeenCalled();
  });

  it("after unsubscribe, re-subscribing creates a new worker", async () => {
    const driver = new BullMQDriver(cfg);
    await driver.subscribe("q", vi.fn());
    await driver.unsubscribe("q");
    await driver.subscribe("q", vi.fn());
    expect(Worker).toHaveBeenCalledTimes(2);
  });

  it("disconnect() closes all queues and workers", async () => {
    const driver = new BullMQDriver(cfg);
    await driver.publish("q", { taskId: "t", agentId: "a", data: {}, timestamp: 0 });
    await driver.subscribe("q", vi.fn());
    await driver.disconnect();
    expect(mockQueueClose).toHaveBeenCalledOnce();
    expect(mockWorkerClose).toHaveBeenCalledOnce();
  });

  it("Worker processor handles payload without traceHeaders (covers ?? {} branch)", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const driver = new BullMQDriver(cfg);
    await driver.subscribe("q", handler);
    const processor = vi.mocked(Worker).mock.calls[0][1] as (job: { data: unknown }) => Promise<void>;
    // Payload with no traceHeaders — should hit the ?? {} fallback
    const payload = { taskId: "t", agentId: "a", data: {}, timestamp: 0 };
    await processor({ data: payload });
    expect(handler).toHaveBeenCalledWith(payload);
  });
});