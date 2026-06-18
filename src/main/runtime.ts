import { initTelemetry } from "../infrastructure/telemetry/telemetry";
import { loadConfig } from "./config";
import { BullMQDriver } from "../infrastructure/messaging/bullmq-driver";
import { KafkaDriver } from "../infrastructure/messaging/kafka-driver";
import { type IMessagingDriver } from "../infrastructure/messaging/interfaces";
import { createStructuredLogger } from "../shared/structured-logger";

const log = createStructuredLogger({ component: "runtime" });

export type AppConfig = ReturnType<typeof loadConfig>;

/** Build the messaging driver (BullMQ or Kafka) from config. */
export function buildMessagingDriver(config: AppConfig): IMessagingDriver {
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
    connection: { host: config.redis.host, port: config.redis.port },
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
