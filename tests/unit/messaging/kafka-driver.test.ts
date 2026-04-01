import { describe, it, expect, vi, beforeEach } from "vitest";
import { KafkaDriver } from "../../../src/infrastructure/messaging/kafka-driver";

const mockSend = vi.fn().mockResolvedValue(undefined);
const mockProducerConnect = vi.fn().mockResolvedValue(undefined);
const mockProducerDisconnect = vi.fn().mockResolvedValue(undefined);
const mockRun = vi.fn().mockResolvedValue(undefined);
const mockConsumerConnect = vi.fn().mockResolvedValue(undefined);
const mockConsumerDisconnect = vi.fn().mockResolvedValue(undefined);
const mockConsumerSubscribe = vi.fn().mockResolvedValue(undefined);

const mockProducer = {
  connect: mockProducerConnect,
  disconnect: mockProducerDisconnect,
  send: mockSend,
};
const mockConsumer = {
  connect: mockConsumerConnect,
  disconnect: mockConsumerDisconnect,
  subscribe: mockConsumerSubscribe,
  run: mockRun,
};

vi.mock("kafkajs", () => ({
  Kafka: vi.fn().mockImplementation(function () {
    return {
      producer: vi.fn().mockReturnValue(mockProducer),
      consumer: vi.fn().mockReturnValue(mockConsumer),
    };
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

describe("KafkaDriver", () => {
  let driver: KafkaDriver;
  beforeEach(() => {
    vi.clearAllMocks();
    driver = new KafkaDriver({
      brokers: ["l:9092"],
      clientId: "c",
      groupId: "g",
    });
  });

  it("publish() connects and sends with trace headers", async () => {
    await driver.publish("t", {
      taskId: "x",
      agentId: "a",
      data: {},
      timestamp: 0,
    });
    expect(mockProducerConnect).toHaveBeenCalledOnce();
    const sentValue = JSON.parse(
      mockSend.mock.calls[0][0].messages[0].value,
    ) as { traceHeaders: unknown };
    expect(sentValue.traceHeaders).toBeDefined();
  });

  it("producer not reconnected on second publish", async () => {
    await driver.publish("t", {
      taskId: "x",
      agentId: "a",
      data: {},
      timestamp: 0,
    });
    await driver.publish("t", {
      taskId: "y",
      agentId: "a",
      data: {},
      timestamp: 0,
    });
    expect(mockProducerConnect).toHaveBeenCalledOnce();
  });

  it("subscribe() connects consumer", async () => {
    await driver.subscribe("t", vi.fn());
    expect(mockConsumerConnect).toHaveBeenCalledOnce();
    expect(mockConsumerSubscribe).toHaveBeenCalledWith({
      topic: "t",
      fromBeginning: false,
    });
    expect(mockRun).toHaveBeenCalledOnce();
  });

  it("consumer not reconnected on second subscribe", async () => {
    await driver.subscribe("t", vi.fn());
    await driver.subscribe("t2", vi.fn());
    expect(mockConsumerConnect).toHaveBeenCalledOnce();
  });

  it("eachMessage extracts trace context and invokes handler", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    await driver.subscribe("t", handler);
    const runCb = mockRun.mock.calls[0][0] as {
      eachMessage: (m: { message: { value: Buffer | null } }) => Promise<void>;
    };
    const p = {
      taskId: "x",
      agentId: "a",
      data: {},
      timestamp: 0,
      traceHeaders: {},
    };
    await runCb.eachMessage({
      message: { value: Buffer.from(JSON.stringify(p)) },
    });
    expect(handler).toHaveBeenCalledWith(p);
  });

  it("eachMessage skips when message.value is null", async () => {
    const handler = vi.fn();
    await driver.subscribe("t", handler);
    const runCb = mockRun.mock.calls[0][0] as {
      eachMessage: (m: { message: { value: null } }) => Promise<void>;
    };
    await runCb.eachMessage({ message: { value: null } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("unsubscribe() disconnects consumer when connected", async () => {
    await driver.subscribe("t", vi.fn());
    await driver.unsubscribe("t");
    expect(mockConsumerDisconnect).toHaveBeenCalledOnce();
  });

  it("unsubscribe() does nothing when not connected", async () => {
    await driver.unsubscribe("t");
    expect(mockConsumerDisconnect).not.toHaveBeenCalled();
  });

  it("disconnect() disconnects both when connected", async () => {
    await driver.publish("t", {
      taskId: "x",
      agentId: "y",
      data: {},
      timestamp: 0,
    });
    await driver.subscribe("t", vi.fn());
    await driver.disconnect();
    expect(mockProducerDisconnect).toHaveBeenCalledOnce();
    expect(mockConsumerDisconnect).toHaveBeenCalledOnce();
  });

  it("disconnect() does nothing when not connected", async () => {
    await driver.disconnect();
    expect(mockProducerDisconnect).not.toHaveBeenCalled();
    expect(mockConsumerDisconnect).not.toHaveBeenCalled();
  });

  it("eachMessage handles payload without traceHeaders (covers ?? {} branch)", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    await driver.subscribe("t", handler);
    const runCb = mockRun.mock.calls[0][0] as {
      eachMessage: (m: { message: { value: Buffer } }) => Promise<void>;
    };
    // Payload with no traceHeaders — hits ?? {} fallback
    const p = { taskId: "x", agentId: "a", data: {}, timestamp: 0 };
    await runCb.eachMessage({
      message: { value: Buffer.from(JSON.stringify(p)) },
    });
    expect(handler).toHaveBeenCalledWith(p);
  });
});
