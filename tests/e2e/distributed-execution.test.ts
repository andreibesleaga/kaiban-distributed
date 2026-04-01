/**
 * E2E: Distributed Task Execution
 * Requires: Redis and Kafka running via docker-compose (started by globalSetup)
 *
 * Tests acceptance criteria from tests/e2e/acceptance-criteria.md:
 * 1. Distributed task execution via real Redis/BullMQ
 * 2. Fault tolerance: retry + DLQ on failure
 */
import { describe, it, expect, afterEach } from "vitest";

import { BullMQDriver } from "../../src/infrastructure/messaging/bullmq-driver";
import { AgentActor } from "../../src/application/actor/AgentActor";
import { DistributedStateMiddleware } from "../../src/adapters/state/distributedMiddleware";
import Redis from "ioredis";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

describe("E2E: Distributed Task Execution", () => {
  const drivers: BullMQDriver[] = [];

  afterEach(async () => {
    await Promise.all(drivers.map((d) => d.disconnect()));
    drivers.length = 0;
  });

  it("Scenario 1: Task published to queue is consumed by AgentActor", async () => {
    const url = new URL(REDIS_URL);
    const connConfig = {
      connection: {
        host: url.hostname,
        port: parseInt(url.port || "6379", 10),
      },
    };

    const publisherDriver = new BullMQDriver(connConfig);
    const consumerDriver = new BullMQDriver(connConfig);
    drivers.push(publisherDriver, consumerDriver);

    const actor = new AgentActor(
      "e2e-agent-1",
      consumerDriver,
      "e2e-queue-agent1",
    );
    await actor.start();

    // Give worker time to attach
    await new Promise((r) => setTimeout(r, 200));

    // Track completion
    let completedTaskId: string | null = null;
    await publisherDriver.subscribe(
      "kaiban-events-completed",
      async (payload) => {
        if (payload.agentId === "e2e-agent-1") {
          completedTaskId = payload.taskId;
        }
      },
    );

    // Publish a task
    await publisherDriver.publish("e2e-queue-agent1", {
      taskId: "e2e-task-001",
      agentId: "e2e-agent-1",
      data: { instruction: "do e2e work" },
      timestamp: Date.now(),
    });

    // Wait for completion
    await new Promise((r) => setTimeout(r, 500));
    expect(completedTaskId).toBe("e2e-task-001");
  }, 15000);

  it("Scenario 2: Fault tolerance - retry on failure publishes to DLQ", async () => {
    const url = new URL(REDIS_URL);
    const connConfig = {
      connection: {
        host: url.hostname,
        port: parseInt(url.port || "6379", 10),
      },
    };

    const driver = new BullMQDriver(connConfig);
    drivers.push(driver);

    // Task handler that always throws
    const failingHandler = async (): Promise<void> => {
      throw new Error("simulated crash");
    };

    const actor = new AgentActor(
      "e2e-agent-fail",
      driver,
      "e2e-queue-fail",
      failingHandler,
    );
    await actor.start();

    await new Promise((r) => setTimeout(r, 200));

    let dlqTaskId: string | null = null;
    await driver.subscribe("kaiban-events-failed", async (payload) => {
      if (payload.agentId === "e2e-agent-fail") {
        dlqTaskId = payload.taskId;
      }
    });

    await driver.publish("e2e-queue-fail", {
      taskId: "e2e-task-fail",
      agentId: "e2e-agent-fail",
      data: {},
      timestamp: Date.now(),
    });

    // Retry has backoff: 100ms + 200ms + 400ms = ~700ms minimum
    await new Promise((r) => setTimeout(r, 1500));
    expect(dlqTaskId).toBe("e2e-task-fail");
  }, 15000);

  it("Scenario 3: DistributedStateMiddleware publishes state changes via Redis Pub/Sub", async () => {
    // Architecture: state sync uses ioredis pub/sub directly, NOT BullMQ queues.
    const stateChannel = "kaiban-state-events";

    const receivedDeltas: unknown[] = [];

    // Create direct redis subscriber
    const sub = new Redis(REDIS_URL);
    await sub.subscribe(stateChannel);
    sub.on("message", (channel, message) => {
      if (channel === stateChannel) {
        const payload = JSON.parse(message);
        receivedDeltas.push(payload.data?.["stateUpdate"]);
      }
    });

    const middleware = new DistributedStateMiddleware(REDIS_URL, stateChannel);
    interface E2EStore {
      state: Record<string, unknown>;
      setState: (partial: Record<string, unknown>) => void;
    }
    const store: E2EStore = {
      state: { taskCount: 0 },
      setState(partial: Record<string, unknown>): void {
        this.state = { ...this.state, ...partial };
      },
    };
    middleware.attach(store);

    await store.setState({ taskCount: 5 });
    await new Promise((r) => setTimeout(r, 800));

    expect(receivedDeltas.length).toBeGreaterThan(0);
    const delta = receivedDeltas[0] as Record<string, unknown>;
    expect(delta["taskCount"]).toBe(5);

    await sub.quit();
    await middleware.disconnect();
  }, 15000);
});
