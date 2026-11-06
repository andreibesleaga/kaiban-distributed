// SPDX-License-Identifier: Apache-2.0
import { initTelemetry } from "../infrastructure/telemetry/telemetry";
import { loadConfig } from "./config";
import { BullMQDriver } from "../infrastructure/messaging/bullmq-driver";
import { KafkaDriver } from "../infrastructure/messaging/kafka-driver";
import { type IMessagingDriver } from "../infrastructure/messaging/interfaces";
import { createStructuredLogger } from "../shared/structured-logger";
import { redisConnectionFromUrl } from "../shared/redis-connection";

const log = createStructuredLogger({ component: "runtime" });

export type AppConfig = ReturnType<typeof loadConfig>;

/** Build the messaging driver (BullMQ or Kafka) from config. */
export function buildMessagingDriver(config: AppConfig): IMessagingDriver {
  if (config.messagingDriver === "amqp") {
    // The AMQP driver is an unimplemented seam: fail at boot, not on the first task.
    throw new Error(
      'MESSAGING_DRIVER="amqp" is not implemented (roadmap). Use "bullmq" or "kafka".',
    );
  }
  if (config.messagingDriver === "kafka") {
    log.info(
      { driver: "kafka", brokers: config.kafka.brokers },
      "Messaging driver selected",
    );
    return new KafkaDriver({
      ...config.kafka,
      ssl: config.kafka.ssl,
    });
  }
  log.info(
    { driver: "bullmq", redis: `${config.redis.host}:${config.redis.port}` },
    "Messaging driver selected",
  );
  return new BullMQDriver({
    connection: redisConnectionFromUrl(config.redis.url),
    tls: config.redis.tls,
  });
}

/** Initialize telemetry once per process. */
export function initRuntimeTelemetry(config: AppConfig): void {
  initTelemetry({
    serviceName: config.serviceName,
    exporterEndpoint: config.otelEndpoint,
  });
}
