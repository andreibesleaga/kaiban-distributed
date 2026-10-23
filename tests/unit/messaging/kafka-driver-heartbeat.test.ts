/**
 * KafkaDriver — heartbeats during long handlers so the worker is not evicted
 * from the consumer group (session timeout) and the task re-run elsewhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KafkaDriver } from "../../../src/infrastructure/messaging/kafka-driver";

const mockRun = vi.fn().mockResolvedValue(undefined);
const mockConsumer = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn().mockResolvedValue(undefined),
  run: mockRun,
};
const mockProducer = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue(undefined),
};

vi.mock("kafkajs", () => ({
  Kafka: vi.fn().mockImplementation(function () {
    return {
      producer: vi.fn().mockReturnValue(mockProducer),
      consumer: vi.fn().mockReturnValue(mockConsumer),
    };
  }),
}));

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

type EachMessage = (m: {
  message: { value: Buffer };
  heartbeat: () => Promise<void>;
}) => Promise<void>;

const message = { value: Buffer.from(JSON.stringify({ taskId: "t1" })) };

async function subscribeWith(
  handler: () => Promise<void>,
): Promise<EachMessage> {
  const driver = new KafkaDriver({
    brokers: ["b:9092"],
    clientId: "c",
    groupId: "g",
  });
  await driver.subscribe("topic", handler);
  return (mockRun.mock.calls[0][0] as { eachMessage: EachMessage }).eachMessage;
}

describe("KafkaDriver — heartbeat during long tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("heartbeats every 3 s while the handler runs and stops afterwards", async () => {
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const eachMessage = await subscribeWith(
      () => new Promise<void>((r) => setTimeout(r, 90_000)),
    );
    const done = eachMessage({ message, heartbeat });
    await vi.advanceTimersByTimeAsync(90_000);
    await done;
    expect(heartbeat).toHaveBeenCalledTimes(30);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeat).toHaveBeenCalledTimes(30);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer and propagates the error when the handler throws", async () => {
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const eachMessage = await subscribeWith(() =>
      Promise.reject(new Error("boom")),
    );
    await expect(eachMessage({ message, heartbeat })).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs and swallows heartbeat failures; the handler still completes", async () => {
    const heartbeat = vi
      .fn()
      .mockRejectedValue(new Error("REBALANCE_IN_PROGRESS"));
    const handler = vi
      .fn()
      .mockImplementation(() => new Promise<void>((r) => setTimeout(r, 7_000)));
    const eachMessage = await subscribeWith(handler);
    const done = eachMessage({ message, heartbeat });
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(done).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining("REBALANCE") }),
      "Kafka heartbeat failed during task",
    );
  });

  it("does not start a heartbeat for an unparseable message", async () => {
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const eachMessage = await subscribeWith(() => Promise.resolve());
    await eachMessage({ message: { value: Buffer.from("{nope") }, heartbeat });
    expect(vi.getTimerCount()).toBe(0);
    expect(heartbeat).not.toHaveBeenCalled();
  });
});
