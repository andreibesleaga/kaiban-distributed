/**
 * E2E: KafkaDriver Integration
 * Requires: Kafka + Zookeeper running via docker-compose (started by kafkaSetup.ts)
 * Start with: npm run test:e2e:kafka
 */
import { describe, it, expect, afterEach } from 'vitest';
import { KafkaDriver } from '../../src/infrastructure/messaging/kafka-driver';
import type { MessagePayload } from '../../src/infrastructure/messaging/interfaces';

const KAFKA_BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');

describe('E2E: KafkaDriver', () => {
  const drivers: KafkaDriver[] = [];

  afterEach(async () => {
    await Promise.all(drivers.map((d) => d.disconnect()));
    drivers.length = 0;
  });

  it('publishes a message and the consumer receives it', async () => {
    const topic = `kaiban-e2e-test-${Date.now()}`;

    const producer = new KafkaDriver({ brokers: KAFKA_BROKERS, clientId: 'e2e-producer', groupId: 'e2e-group-pub' });
    const consumer = new KafkaDriver({ brokers: KAFKA_BROKERS, clientId: 'e2e-consumer', groupId: `e2e-group-sub-${Date.now()}` });
    drivers.push(producer, consumer);

    const received: MessagePayload[] = [];
    await consumer.subscribe(topic, async (payload) => { received.push(payload); });

    // Give consumer time to join the group
    await new Promise((r) => setTimeout(r, 5000));

    const msg: MessagePayload = {
      taskId: 'kafka-e2e-task-001',
      agentId: 'e2e-agent',
      data: { instruction: 'Kafka round-trip test' },
      timestamp: Date.now(),
    };
    await producer.publish(topic, msg);

    // Wait for message delivery
    await new Promise((r) => setTimeout(r, 5000));

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].taskId).toBe('kafka-e2e-task-001');
    expect(received[0].data['instruction']).toBe('Kafka round-trip test');
  }, 30000);

  it('unsubscribe stops consumer from receiving further messages', async () => {
    const topic = `kaiban-e2e-unsub-${Date.now()}`;
    const driver = new KafkaDriver({ brokers: KAFKA_BROKERS, clientId: 'e2e-unsub', groupId: `e2e-unsub-${Date.now()}` });
    drivers.push(driver);

    const received: MessagePayload[] = [];
    await driver.subscribe(topic, async (p) => { received.push(p); });
    await new Promise((r) => setTimeout(r, 500));

    await driver.unsubscribe(topic);
    await driver.publish(topic, { taskId: 'after-unsub', agentId: 'a', data: {}, timestamp: Date.now() });
    await new Promise((r) => setTimeout(r, 2000));

    expect(received.filter((m) => m.taskId === 'after-unsub')).toHaveLength(0);
  }, 20000);
});
