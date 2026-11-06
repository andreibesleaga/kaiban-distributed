import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/infrastructure/messaging/bullmq-driver", () => ({ BullMQDriver: vi.fn() }));
vi.mock("../../../src/infrastructure/messaging/kafka-driver", () => ({ KafkaDriver: vi.fn() }));

import { buildMessagingDriver } from "../../../src/main/runtime";
import { loadConfig } from "../../../src/main/config";

describe("buildMessagingDriver", () => {
  beforeEach(() => {
    process.env["AGENT_IDS"] = "a";
  });
  afterEach(() => {
    delete process.env["AGENT_IDS"];
    delete process.env["MESSAGING_DRIVER"];
  });

  it("fails at boot for the unimplemented amqp seam instead of falling back to BullMQ", () => {
    process.env["MESSAGING_DRIVER"] = "amqp";
    expect(() => buildMessagingDriver(loadConfig())).toThrow(/amqp.*not implemented/);
  });
});
