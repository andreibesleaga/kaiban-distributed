import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../../src/main/config';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      AGENT_IDS: 'researcher,writer',
      REDIS_URL: 'redis://localhost:6379',
      MESSAGING_DRIVER: 'bullmq',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads default BullMQ config', () => {
    const config = loadConfig();
    expect(config.messagingDriver).toBe('bullmq');
    expect(config.redis.host).toBe('localhost');
    expect(config.redis.port).toBe(6379);
    expect(config.agentIds).toEqual(['researcher', 'writer']);
  });

  it('loads Kafka driver when MESSAGING_DRIVER=kafka', () => {
    process.env['MESSAGING_DRIVER'] = 'kafka';
    process.env['KAFKA_BROKERS'] = 'kafka:29092,kafka2:29092';
    const config = loadConfig();
    expect(config.messagingDriver).toBe('kafka');
    expect(config.kafka.brokers).toEqual(['kafka:29092', 'kafka2:29092']);
  });

  it('throws on invalid MESSAGING_DRIVER value', () => {
    process.env['MESSAGING_DRIVER'] = 'rabbitmq';
    expect(() => loadConfig()).toThrow('MESSAGING_DRIVER must be "bullmq" or "kafka"');
  });

  it('throws when AGENT_IDS is not set', () => {
    delete process.env['AGENT_IDS'];
    expect(() => loadConfig()).toThrow('Required environment variable "AGENT_IDS" is not set');
  });

  it('parses Redis URL with explicit port', () => {
    process.env['REDIS_URL'] = 'redis://redis-host:6380';
    const config = loadConfig();
    expect(config.redis.host).toBe('redis-host');
    expect(config.redis.port).toBe(6380);
  });

  it('defaults port to 6379 when Redis URL has no port (covers || fallback branch)', () => {
    // redis://hostname with no explicit port → parsed.port is '' → || '6379' fallback
    process.env['REDIS_URL'] = 'redis://redis-host';
    const config = loadConfig();
    expect(config.redis.host).toBe('redis-host');
    expect(config.redis.port).toBe(6379);
  });

  it('applies defaults for optional env vars', () => {
    delete process.env['PORT'];
    delete process.env['SERVICE_NAME'];
    delete process.env['KAFKA_CLIENT_ID'];
    delete process.env['KAFKA_GROUP_ID'];
    const config = loadConfig();
    expect(config.port).toBe(3000);
    expect(config.serviceName).toBe('kaiban-worker');
    expect(config.kafka.clientId).toBe('kaiban-worker');
    expect(config.kafka.groupId).toBe('kaiban-group');
  });

  it('otelEndpoint is undefined when not set', () => {
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    const config = loadConfig();
    expect(config.otelEndpoint).toBeUndefined();
  });

  it('otelEndpoint is set when env var is present', () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://otel:4318/v1/traces';
    const config = loadConfig();
    expect(config.otelEndpoint).toBe('http://otel:4318/v1/traces');
  });
});
