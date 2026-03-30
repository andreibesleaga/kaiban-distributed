/**
 * Messaging driver factory for the global-research example.
 * MESSAGING_DRIVER=bullmq (default) → BullMQDriver (Redis)
 * MESSAGING_DRIVER=kafka            → KafkaDriver
 *
 * For Kafka: each worker gets a unique consumer groupId suffix so messages
 * route correctly to the right node.
 */
import { BullMQDriver } from '../../src/infrastructure/messaging/bullmq-driver';
import { KafkaDriver } from '../../src/infrastructure/messaging/kafka-driver';
import type { IMessagingDriver } from '../../src/infrastructure/messaging/interfaces';

export type DriverType = 'bullmq' | 'kafka';

// Suppress KafkaJS v2 partitioner migration warning
process.env['KAFKAJS_NO_PARTITIONER_WARNING'] = '1';

export function getDriverType(): DriverType {
  return process.env['MESSAGING_DRIVER'] === 'kafka' ? 'kafka' : 'bullmq';
}

/**
 * Creates the configured messaging driver.
 * @param groupIdSuffix Appended to Kafka consumer group to make it unique per role.
 *   e.g. 'searcher' → 'kaiban-group-searcher'
 *   For orchestrator create TWO with different suffixes (completed / failed).
 */
export function createDriver(groupIdSuffix = ''): IMessagingDriver {
  if (getDriverType() === 'kafka') {
    const brokers = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
    const clientId = process.env['KAFKA_CLIENT_ID'] ?? 'kaiban-worker';
    const base = process.env['KAFKA_GROUP_ID'] ?? 'kaiban-group';
    const suffix = groupIdSuffix.startsWith("-") ? groupIdSuffix.slice(1) : groupIdSuffix;
    const groupId = suffix ? `${base}-${suffix}` : base;
    console.log(`[Driver] Kafka  brokers=${brokers.join(',')}  group=${groupId}`);
    return new KafkaDriver({ brokers, clientId, groupId });
  }

  const url = new URL(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
  const host = url.hostname;
  const port = parseInt(url.port || '6379', 10);
  console.log(`[Driver] BullMQ  redis=${host}:${port}`);
  return new BullMQDriver({ connection: { host, port } });
}
