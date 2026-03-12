/**
 * KafkaDriver — edge cases and SSL constructor branch coverage.
 *
 * Covers: SSL constructor path (line 24), malformed JSON in eachMessage,
 * multi-topic publishing, message enrichment, error propagation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KafkaDriver } from '../../../src/infrastructure/messaging/kafka-driver';
import { Kafka } from 'kafkajs';

const mockSend               = vi.fn().mockResolvedValue(undefined);
const mockProducerConnect    = vi.fn().mockResolvedValue(undefined);
const mockProducerDisconnect = vi.fn().mockResolvedValue(undefined);
const mockRun                = vi.fn().mockResolvedValue(undefined);
const mockConsumerConnect    = vi.fn().mockResolvedValue(undefined);
const mockConsumerDisconnect = vi.fn().mockResolvedValue(undefined);
const mockSubscribe          = vi.fn().mockResolvedValue(undefined);

const mockProducer = {
  connect: mockProducerConnect,
  disconnect: mockProducerDisconnect,
  send: mockSend,
};
const mockConsumer = {
  connect: mockConsumerConnect,
  disconnect: mockConsumerDisconnect,
  subscribe: mockSubscribe,
  run: mockRun,
};

vi.mock('kafkajs', () => ({
  Kafka: vi.fn().mockImplementation(function () {
    return {
      producer: vi.fn().mockReturnValue(mockProducer),
      consumer: vi.fn().mockReturnValue(mockConsumer),
    };
  }),
}));

vi.mock('@opentelemetry/api', () => ({
  context: { active: vi.fn().mockReturnValue({}), with: vi.fn().mockImplementation((_ctx, fn) => fn()) },
  propagation: { inject: vi.fn(), extract: vi.fn().mockReturnValue({}) },
  ROOT_CONTEXT: {},
}));

describe('KafkaDriver — SSL constructor (line 24 branch)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('passes ssl config to Kafka when ssl is provided', () => {
    const ssl = {
      rejectUnauthorized: true,
      ca: Buffer.from('ca-cert'),
      cert: Buffer.from('client-cert'),
      key: Buffer.from('client-key'),
    };
    new KafkaDriver({ brokers: ['b:9092'], clientId: 'c', groupId: 'g', ssl });
    const kafkaArgs = vi.mocked(Kafka).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(kafkaArgs['ssl']).toBeDefined();
    const sslOpts = kafkaArgs['ssl'] as Record<string, unknown>;
    expect(sslOpts['rejectUnauthorized']).toBe(true);
    expect(Array.isArray(sslOpts['ca'])).toBe(true);
  });

  it('does NOT include ssl in Kafka config when ssl is omitted', () => {
    new KafkaDriver({ brokers: ['b:9092'], clientId: 'c', groupId: 'g' });
    const kafkaArgs = vi.mocked(Kafka).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(kafkaArgs['ssl']).toBeUndefined();
  });

  it('converts Buffer ssl fields to strings for kafkajs', () => {
    const caContent = 'ca-content';
    const ssl = {
      rejectUnauthorized: false,
      ca: Buffer.from(caContent),
      cert: Buffer.from('cert'),
      key: Buffer.from('key'),
    };
    new KafkaDriver({ brokers: ['b:9092'], clientId: 'c', groupId: 'g', ssl });
    const kafkaArgs = vi.mocked(Kafka).mock.calls[0][0] as unknown as Record<string, unknown>;
    const sslOpts = kafkaArgs['ssl'] as Record<string, unknown>;
    // ca is converted to array of strings
    expect((sslOpts['ca'] as string[])[0]).toBe(caContent);
    expect(typeof sslOpts['cert']).toBe('string');
    expect(typeof sslOpts['key']).toBe('string');
  });

  it('SSL driver publishes successfully', async () => {
    const ssl = {
      rejectUnauthorized: true,
      ca: Buffer.from('ca'),
      cert: Buffer.from('c'),
      key: Buffer.from('k'),
    };
    const driver = new KafkaDriver({ brokers: ['b:9092'], clientId: 'c', groupId: 'g', ssl });
    await driver.publish('topic', { taskId: 'ssl-task', agentId: 'a', data: {}, timestamp: 0 });
    expect(mockSend).toHaveBeenCalledOnce();
    const sentValue = JSON.parse(mockSend.mock.calls[0][0].messages[0].value as string) as { taskId: string };
    expect(sentValue.taskId).toBe('ssl-task');
  });
});

describe('KafkaDriver — eachMessage edge cases', () => {
  let driver: KafkaDriver;
  beforeEach(() => {
    vi.clearAllMocks();
    driver = new KafkaDriver({ brokers: ['l:9092'], clientId: 'c', groupId: 'g' });
  });

  it('eachMessage propagates JSON.parse errors (malformed message value)', async () => {
    const handler = vi.fn();
    await driver.subscribe('t', handler);
    const runCb = mockRun.mock.calls[0][0] as {
      eachMessage: (m: { message: { value: Buffer } }) => Promise<void>;
    };
    await expect(
      runCb.eachMessage({ message: { value: Buffer.from('not-valid-json{{{') } }),
    ).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('eachMessage with empty string value throws JSON parse error', async () => {
    const handler = vi.fn();
    await driver.subscribe('t', handler);
    const runCb = mockRun.mock.calls[0][0] as {
      eachMessage: (m: { message: { value: Buffer } }) => Promise<void>;
    };
    await expect(
      runCb.eachMessage({ message: { value: Buffer.from('') } }),
    ).rejects.toThrow();
  });

  it('eachMessage passes complete payload to handler including data field', async () => {
    const received: unknown[] = [];
    await driver.subscribe('t', async (p) => { received.push(p); });
    const runCb = mockRun.mock.calls[0][0] as {
      eachMessage: (m: { message: { value: Buffer } }) => Promise<void>;
    };
    const payload = { taskId: 'x', agentId: 'a', data: { key: 'val' }, timestamp: 123, traceHeaders: {} };
    await runCb.eachMessage({ message: { value: Buffer.from(JSON.stringify(payload)) } });
    expect(received[0]).toMatchObject({ taskId: 'x', data: { key: 'val' }, timestamp: 123 });
  });

  it('publish serialises entire payload including data sub-fields', async () => {
    const payload = {
      taskId: 'full-task',
      agentId: 'agent-k',
      data: { instruction: 'do research', expectedOutput: 'summary', context: 'ctx' },
      timestamp: 42,
    };
    await driver.publish('topic', payload);
    const raw = mockSend.mock.calls[0][0].messages[0].value as string;
    const parsed = JSON.parse(raw) as typeof payload & { traceHeaders: unknown };
    expect(parsed.taskId).toBe('full-task');
    expect(parsed.data.instruction).toBe('do research');
    expect(parsed.traceHeaders).toBeDefined();
  });
});

describe('KafkaDriver — multi-topic and connection management', () => {
  let driver: KafkaDriver;
  beforeEach(() => {
    vi.clearAllMocks();
    driver = new KafkaDriver({ brokers: ['l:9092'], clientId: 'c', groupId: 'g' });
  });

  it('publishes to multiple different topics correctly', async () => {
    await driver.publish('t1', { taskId: 'a', agentId: 'x', data: {}, timestamp: 0 });
    await driver.publish('t2', { taskId: 'b', agentId: 'x', data: {}, timestamp: 0 });
    // Producer connects only once
    expect(mockProducerConnect).toHaveBeenCalledOnce();
    // Both sends go through the single producer
    expect(mockSend).toHaveBeenCalledTimes(2);
    const t1 = mockSend.mock.calls[0][0].topic as string;
    const t2 = mockSend.mock.calls[1][0].topic as string;
    expect(t1).toBe('t1');
    expect(t2).toBe('t2');
  });

  it('unsubscribe sets consumerConnected to false, allowing reconnect', async () => {
    await driver.subscribe('t', vi.fn());
    await driver.unsubscribe('t');
    // After unsubscribe, subscribing again should reconnect
    await driver.subscribe('t2', vi.fn());
    expect(mockConsumerConnect).toHaveBeenCalledTimes(2);
  });

  it('disconnect after publish and subscribe disconnects both', async () => {
    await driver.publish('t', { taskId: 'x', agentId: 'y', data: {}, timestamp: 0 });
    await driver.subscribe('t', vi.fn());
    await driver.disconnect();
    expect(mockProducerDisconnect).toHaveBeenCalledOnce();
    expect(mockConsumerDisconnect).toHaveBeenCalledOnce();
  });

  it('groupId is passed to consumer constructor', () => {
    vi.clearAllMocks();
    new KafkaDriver({ brokers: ['b:9092'], clientId: 'cid', groupId: 'my-group' });
    const kafkaInstance = vi.mocked(Kafka).mock.results[0].value as {
      consumer: ReturnType<typeof vi.fn>;
    };
    expect(kafkaInstance.consumer).toHaveBeenCalledWith({ groupId: 'my-group' });
  });
});
