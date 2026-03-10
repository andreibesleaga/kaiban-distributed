import { describe, it, expect, vi, beforeEach } from "vitest";
import { BullMQDriver } from "../../../src/infrastructure/messaging/bullmq-driver";
import { Queue, Worker } from "bullmq";

vi.mock("bullmq", () => {
  return {
    Queue: vi.fn().mockImplementation(function () {
      return {
        add: vi.fn().mockResolvedValue({ id: "mock-job" }),
        close: vi.fn(),
      };
    }),
    Worker: vi.fn().mockImplementation(function () {
      return {
        close: vi.fn(),
      };
    }),
  };
});

describe("BullMQDriver (TDD unit spec)", () => {
  const mockConfig = {
    connection: { host: "localhost", port: 6379 },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes seamlessly and creates a queue instance on publish", async () => {
    const driver = new BullMQDriver(mockConfig);

    await driver.publish("test-queue", {
      taskId: "task-123",
      agentId: "agent-xy",
      data: { hello: "world" },
      timestamp: Date.now(),
    });

    expect(Queue).toHaveBeenCalledWith("test-queue", {
      connection: mockConfig.connection,
    });
  });

  it("subscribing attaches a BullMQ Worker", async () => {
    const driver = new BullMQDriver(mockConfig);
    const mockHandler = vi.fn().mockResolvedValue(undefined);

    await driver.subscribe("test-queue", mockHandler);
    expect(Worker).toHaveBeenCalledWith("test-queue", expect.any(Function), {
      connection: mockConfig.connection,
    });
  });
});
