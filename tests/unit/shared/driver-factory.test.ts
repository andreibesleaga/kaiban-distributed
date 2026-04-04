import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getDriverType, createDriver } from "../../../src/shared";

const { mockBullMQDisconnect, mockKafkaDisconnect } = vi.hoisted(() => ({
  mockBullMQDisconnect: vi.fn().mockResolvedValue(undefined),
  mockKafkaDisconnect: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/infrastructure/messaging/bullmq-driver", () => ({
  BullMQDriver: vi.fn().mockImplementation(function () {
    return {
      disconnect: mockBullMQDisconnect,
      publish: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };
  }),
}));

vi.mock("../../../src/infrastructure/messaging/kafka-driver", () => ({
  KafkaDriver: vi.fn().mockImplementation(function () {
    return {
      disconnect: mockKafkaDisconnect,
      publish: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };
  }),
}));

describe("getDriverType", () => {
  afterEach(() => {
    delete process.env["MESSAGING_DRIVER"];
  });

  it("returns 'bullmq' by default (no env var)", () => {
    delete process.env["MESSAGING_DRIVER"];
    expect(getDriverType()).toBe("bullmq");
  });

  it("returns 'kafka' when MESSAGING_DRIVER=kafka", () => {
    process.env["MESSAGING_DRIVER"] = "kafka";
    expect(getDriverType()).toBe("kafka");
  });

  it("returns 'bullmq' for any other value", () => {
    process.env["MESSAGING_DRIVER"] = "redis";
    expect(getDriverType()).toBe("bullmq");
  });
});

describe("createDriver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["MESSAGING_DRIVER"];
    delete process.env["REDIS_URL"];
    delete process.env["KAFKA_BROKERS"];
    delete process.env["KAFKA_CLIENT_ID"];
    delete process.env["KAFKA_GROUP_ID"];
  });

  afterEach(() => {
    delete process.env["MESSAGING_DRIVER"];
    delete process.env["REDIS_URL"];
    delete process.env["KAFKA_BROKERS"];
    delete process.env["KAFKA_CLIENT_ID"];
    delete process.env["KAFKA_GROUP_ID"];
  });

  it("creates BullMQDriver when MESSAGING_DRIVER is not set", async () => {
    const { BullMQDriver } =
      await import("../../../src/infrastructure/messaging/bullmq-driver");
    const driver = createDriver("worker");
    expect(BullMQDriver).toHaveBeenCalled();
    expect(driver).toBeDefined();
  });

  it("creates BullMQDriver with parsed REDIS_URL host and port", async () => {
    process.env["REDIS_URL"] = "redis://myhost:6380";
    const { BullMQDriver } =
      await import("../../../src/infrastructure/messaging/bullmq-driver");
    vi.clearAllMocks();
    createDriver();
    expect(BullMQDriver).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: { host: "myhost", port: 6380 },
      }),
    );
  });

  it("creates BullMQDriver with default port 6379 when not specified in URL", async () => {
    process.env["REDIS_URL"] = "redis://localhost";
    const { BullMQDriver } =
      await import("../../../src/infrastructure/messaging/bullmq-driver");
    vi.clearAllMocks();
    createDriver();
    expect(BullMQDriver).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: { host: "localhost", port: 6379 },
      }),
    );
  });

  it("creates KafkaDriver when MESSAGING_DRIVER=kafka", async () => {
    process.env["MESSAGING_DRIVER"] = "kafka";
    const { KafkaDriver } =
      await import("../../../src/infrastructure/messaging/kafka-driver");
    vi.clearAllMocks();
    const driver = createDriver("researcher");
    expect(KafkaDriver).toHaveBeenCalled();
    expect(driver).toBeDefined();
  });

  it("uses custom KAFKA_BROKERS and KAFKA_GROUP_ID when set", async () => {
    process.env["MESSAGING_DRIVER"] = "kafka";
    process.env["KAFKA_BROKERS"] = "broker1:9092,broker2:9092";
    process.env["KAFKA_GROUP_ID"] = "my-group";
    const { KafkaDriver } =
      await import("../../../src/infrastructure/messaging/kafka-driver");
    vi.clearAllMocks();
    createDriver("writer");
    expect(KafkaDriver).toHaveBeenCalledWith(
      expect.objectContaining({
        brokers: ["broker1:9092", "broker2:9092"],
        groupId: "my-group-writer",
      }),
    );
  });

  it("strips leading dash from groupIdSuffix for Kafka", async () => {
    process.env["MESSAGING_DRIVER"] = "kafka";
    const { KafkaDriver } =
      await import("../../../src/infrastructure/messaging/kafka-driver");
    vi.clearAllMocks();
    createDriver("-orchestrator-completed");
    expect(KafkaDriver).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "kaiban-group-orchestrator-completed",
      }),
    );
  });

  it("uses base group ID when no suffix provided for Kafka", async () => {
    process.env["MESSAGING_DRIVER"] = "kafka";
    const { KafkaDriver } =
      await import("../../../src/infrastructure/messaging/kafka-driver");
    vi.clearAllMocks();
    createDriver("");
    expect(KafkaDriver).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "kaiban-group",
      }),
    );
  });

  it("uses default suffix when none provided for BullMQ", async () => {
    const { BullMQDriver } =
      await import("../../../src/infrastructure/messaging/bullmq-driver");
    vi.clearAllMocks();
    createDriver(); // no suffix
    expect(BullMQDriver).toHaveBeenCalled();
  });
});
