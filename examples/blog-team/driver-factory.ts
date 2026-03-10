/**
 * Messaging Driver Factory for blog-team example.
 *
 * Creates the correct IMessagingDriver based on MESSAGING_DRIVER env var:
 *   MESSAGING_DRIVER=bullmq  (default) → BullMQDriver via Redis
 *   MESSAGING_DRIVER=kafka            → KafkaDriver via Kafka brokers
 *
 * For Kafka, a `groupIdSuffix` is appended to KAFKA_GROUP_ID to allow
 * separate consumer groups per component (orchestrator-completed, orchestrator-failed,
 * researcher, writer, editor), enabling correct message routing.
 *
 * Usage:
 *   const driver = createDriver();                    // worker node
 *   const driver = createDriver('-orchestrator');      // unique orchestrator group
 */
import { BullMQDriver } from '../../src/infrastructure/messaging/bullmq-driver';
import { KafkaDriver } from '../../src/infrastructure/messaging/kafka-driver';
import type { IMessagingDriver } from '../../src/infrastructure/messaging/interfaces';

export type DriverType = 'bullmq' | 'kafka';

export function getDriverType(): DriverType {
  const d = (process.env['MESSAGING_DRIVER'] ?? 'bullmq').toLowerCase();
  if (d !== 'bullmq' && d !== 'kafka') {
    throw new Error(`MESSAGING_DRIVER must be "bullmq" or "kafka", got: "${d}"`);
  }
  return d;
}

export function createDriver(groupIdSuffix = ''): IMessagingDriver {
  const type = getDriverType();

  if (type === 'kafka') {
    const brokers = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',').map((b) => b.trim());
    const clientId = process.env['KAFKA_CLIENT_ID'] ?? 'kaiban-blog-team';
    const groupId = `${process.env['KAFKA_GROUP_ID'] ?? 'kaiban-blog'}${groupIdSuffix}`;
    console.log(`[factory] KafkaDriver — brokers: ${brokers.join(',')} group: ${groupId}`);
    return new KafkaDriver({ brokers, clientId, groupId });
  }

  const redisUrl = new URL(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
  const host = redisUrl.hostname;
  const port = parseInt(redisUrl.port || '6379', 10);
  console.log(`[factory] BullMQDriver — ${host}:${port}`);
  return new BullMQDriver({ connection: { host, port } });
}
