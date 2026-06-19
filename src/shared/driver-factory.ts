/**
 * Messaging driver factory — shared across all examples.
 *
 * MESSAGING_DRIVER=bullmq (default) → BullMQDriver (Redis)
 * MESSAGING_DRIVER=kafka            → KafkaDriver
 *
 * For Kafka: each worker gets a unique consumer groupId suffix so messages
 * route correctly to the right node.
 * For orchestrator: create TWO drivers with different suffixes
 *   (e.g. '-orchestrator-completed' / '-orchestrator-failed').
 */
import { BullMQDriver } from "../infrastructure/messaging/bullmq-driver";
import { KafkaDriver } from "../infrastructure/messaging/kafka-driver";
import { AmqpDriver } from "../infrastructure/messaging/amqp-driver";
import type { IMessagingDriver } from "../infrastructure/messaging/interfaces";
import { createLogger } from "./logger";

export type DriverType = "bullmq" | "kafka" | "amqp";

// Suppress KafkaJS v2 partitioner migration warning
process.env["KAFKAJS_NO_PARTITIONER_WARNING"] = "1";

const log = createLogger("Driver");

/** Returns the configured driver: 'kafka' / 'amqp' (seam) / 'bullmq' (default). */
export function getDriverType(): DriverType {
  const v = process.env["MESSAGING_DRIVER"];
  if (v === "kafka") return "kafka";
  if (v === "amqp") return "amqp";
  return "bullmq";
}

/**
 * Creates the configured messaging driver.
 *
 * @param groupIdSuffix Appended to the Kafka consumer group ID to make it unique per role.
 *   e.g. 'researcher' → 'kaiban-group-researcher'
 *   Leading '-' is stripped automatically.
 */
export function createDriver(groupIdSuffix = ""): IMessagingDriver {
  const type = getDriverType();
  if (type === "kafka") return createKafkaDriver(groupIdSuffix);
  if (type === "amqp") {
    // Unimplemented universal-AMQP seam — methods throw on use (roadmap).
    log.info("AMQP driver selected — unimplemented seam (use bullmq or kafka)");
    return new AmqpDriver();
  }
  return createBullMQDriver();
}

function createKafkaDriver(groupIdSuffix: string): IMessagingDriver {
  const brokers = (process.env["KAFKA_BROKERS"] ?? "localhost:9092").split(",");
  const clientId = process.env["KAFKA_CLIENT_ID"] ?? "kaiban-worker";
  const base = process.env["KAFKA_GROUP_ID"] ?? "kaiban-group";
  const suffix = groupIdSuffix.startsWith("-")
    ? groupIdSuffix.slice(1)
    : groupIdSuffix;
  const groupId = suffix ? `${base}-${suffix}` : base;
  log.info(`Kafka  brokers=${brokers.join(",")}  group=${groupId}`);
  return new KafkaDriver({ brokers, clientId, groupId });
}

function createBullMQDriver(): IMessagingDriver {
  const url = new URL(process.env["REDIS_URL"] ?? "redis://localhost:6379");
  const host = url.hostname;
  const port = parseInt(url.port || "6379", 10);
  log.info(`BullMQ  redis=${host}:${port}`);
  return new BullMQDriver({ connection: { host, port } });
}
