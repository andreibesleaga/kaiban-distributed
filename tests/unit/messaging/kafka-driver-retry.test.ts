import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

describe("KafkaDriver — retry behavior", () => {
  let driver: KafkaDriver;

  beforeEach(() => {
    vi.clearAllMocks();
    driver = new KafkaDriver({
      brokers: ["localhost:9092"],
      clientId: "coverage-client",
      groupId: "coverage-group",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries when Kafka returns a retryable topic error", async () => {
    vi.useFakeTimers();
    mockSend
      .mockRejectedValueOnce({ type: "UNKNOWN_TOPIC_OR_PARTITION" })
      .mockResolvedValueOnce(undefined);

    const publishPromise = driver.publish(
      "topic-a",
      {
        taskId: "task-a",
        agentId: "agent-a",
        data: {},
        timestamp: 0,
      },
      2,
    );

    await vi.runAllTimersAsync();
    await publishPromise;

    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("rethrows the last retryable error after the final attempt", async () => {
    const retryableError = { message: "KafkaJSProtocolError: broker mismatch" };
    mockSend.mockRejectedValue(retryableError);

    await expect(
      driver.publish(
        "topic-b",
        {
          taskId: "task-b",
          agentId: "agent-b",
          data: {},
          timestamp: 0,
        },
        1,
      ),
    ).rejects.toBe(retryableError);

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-retryable producer errors", async () => {
    const fatalError = new Error("access denied");
    mockSend.mockRejectedValue(fatalError);

    await expect(
      driver.publish(
        "topic-c",
        {
          taskId: "task-c",
          agentId: "agent-c",
          data: {},
          timestamp: 0,
        },
        3,
      ),
    ).rejects.toBe(fatalError);

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("treats primitive thrown values as non-retryable", async () => {
    mockSend.mockRejectedValue("fatal string error");

    await expect(
      driver.publish(
        "topic-d",
        {
          taskId: "task-d",
          agentId: "agent-d",
          data: {},
          timestamp: 0,
        },
        3,
      ),
    ).rejects.toBe("fatal string error");

    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});