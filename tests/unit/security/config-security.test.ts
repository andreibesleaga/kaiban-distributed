import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../../src/main/config';
import { readFileSync } from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, readFileSync: vi.fn().mockReturnValue(Buffer.from('mock-cert-data')) };
});

describe('loadConfig — security fields', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, AGENT_IDS: 'agent-1', REDIS_URL: 'redis://localhost:6379', MESSAGING_DRIVER: 'bullmq' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ── Golden path: all flags default to false ─────────────────────
  it('security flags default to false when no env vars set', () => {
    const config = loadConfig();
    expect(config.security.semanticFirewallEnabled).toBe(false);
    expect(config.security.jitTokensEnabled).toBe(false);
    expect(config.security.circuitBreakerEnabled).toBe(false);
  });

  it('default circuit breaker threshold is 10', () => {
    const config = loadConfig();
    expect(config.security.circuitBreakerThreshold).toBe(10);
  });

  it('default circuit breaker window is 60000ms', () => {
    const config = loadConfig();
    expect(config.security.circuitBreakerWindowMs).toBe(60000);
  });

  // ── Golden path: flags enabled ──────────────────────────────────
  it('SEMANTIC_FIREWALL_ENABLED=true activates firewall', () => {
    process.env['SEMANTIC_FIREWALL_ENABLED'] = 'true';
    const config = loadConfig();
    expect(config.security.semanticFirewallEnabled).toBe(true);
  });

  it('JIT_TOKENS_ENABLED=true activates JIT tokens', () => {
    process.env['JIT_TOKENS_ENABLED'] = 'true';
    const config = loadConfig();
    expect(config.security.jitTokensEnabled).toBe(true);
  });

  it('CIRCUIT_BREAKER_ENABLED=true activates circuit breaker', () => {
    process.env['CIRCUIT_BREAKER_ENABLED'] = 'true';
    const config = loadConfig();
    expect(config.security.circuitBreakerEnabled).toBe(true);
  });

  // ── Edge: getBoolEnv with '1' also returns true ─────────────────
  it('getBoolEnv treats "1" as true', () => {
    process.env['SEMANTIC_FIREWALL_ENABLED'] = '1';
    const config = loadConfig();
    expect(config.security.semanticFirewallEnabled).toBe(true);
  });

  it('getBoolEnv treats random string as false', () => {
    process.env['SEMANTIC_FIREWALL_ENABLED'] = 'yes';
    const config = loadConfig();
    expect(config.security.semanticFirewallEnabled).toBe(false);
  });

  // ── Custom threshold / window ───────────────────────────────────
  it('parses custom CIRCUIT_BREAKER_THRESHOLD', () => {
    process.env['CIRCUIT_BREAKER_THRESHOLD'] = '5';
    const config = loadConfig();
    expect(config.security.circuitBreakerThreshold).toBe(5);
  });

  it('parses custom CIRCUIT_BREAKER_WINDOW_MS', () => {
    process.env['CIRCUIT_BREAKER_WINDOW_MS'] = '30000';
    const config = loadConfig();
    expect(config.security.circuitBreakerWindowMs).toBe(30000);
  });

  // ── Optional LLM URL ───────────────────────────────────────────
  it('SEMANTIC_FIREWALL_LLM_URL is undefined when not set', () => {
    const config = loadConfig();
    expect(config.security.semanticFirewallLlmUrl).toBeUndefined();
  });

  it('SEMANTIC_FIREWALL_LLM_URL is set when env var present', () => {
    process.env['SEMANTIC_FIREWALL_LLM_URL'] = 'http://localhost:11434/api/generate';
    const config = loadConfig();
    expect(config.security.semanticFirewallLlmUrl).toBe('http://localhost:11434/api/generate');
  });
});

describe('loadConfig — TLS fields', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, AGENT_IDS: 'agent-1', REDIS_URL: 'redis://localhost:6379', MESSAGING_DRIVER: 'bullmq' };
    vi.mocked(readFileSync).mockReturnValue(Buffer.from('mock-cert-data'));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('redis.tls is undefined when no TLS env vars set', () => {
    const config = loadConfig();
    expect(config.redis.tls).toBeUndefined();
  });

  it('kafka.ssl is undefined when no SSL env vars set', () => {
    const config = loadConfig();
    expect(config.kafka.ssl).toBeUndefined();
  });

  it('redis.tls is undefined when only partial env vars set (only CA)', () => {
    process.env['REDIS_TLS_CA'] = '/path/to/ca.crt';
    const config = loadConfig();
    expect(config.redis.tls).toBeUndefined();
  });

  it('kafka.ssl is undefined when only partial env vars set (CA + cert, no key)', () => {
    process.env['KAFKA_SSL_CA'] = '/path/to/ca.crt';
    process.env['KAFKA_SSL_CERT'] = '/path/to/cert.crt';
    const config = loadConfig();
    expect(config.kafka.ssl).toBeUndefined();
  });

  it('redis.tls is populated when all three TLS env vars are set', () => {
    process.env['REDIS_TLS_CA'] = '/path/to/ca.crt';
    process.env['REDIS_TLS_CERT'] = '/path/to/cert.crt';
    process.env['REDIS_TLS_KEY'] = '/path/to/key.pem';
    const config = loadConfig();
    expect(config.redis.tls).toBeDefined();
    expect(config.redis.tls!.ca).toBeInstanceOf(Buffer);
    expect(config.redis.tls!.cert).toBeInstanceOf(Buffer);
    expect(config.redis.tls!.key).toBeInstanceOf(Buffer);
    expect(config.redis.tls!.rejectUnauthorized).toBe(true);
  });

  it('kafka.ssl is populated when all three SSL env vars are set', () => {
    process.env['KAFKA_SSL_CA'] = '/path/to/ca.crt';
    process.env['KAFKA_SSL_CERT'] = '/path/to/cert.crt';
    process.env['KAFKA_SSL_KEY'] = '/path/to/key.pem';
    const config = loadConfig();
    expect(config.kafka.ssl).toBeDefined();
    expect(config.kafka.ssl!.ca).toBeInstanceOf(Buffer);
  });

  it('TLS_REJECT_UNAUTHORIZED=false sets rejectUnauthorized to false', () => {
    process.env['REDIS_TLS_CA'] = '/path/to/ca.crt';
    process.env['REDIS_TLS_CERT'] = '/path/to/cert.crt';
    process.env['REDIS_TLS_KEY'] = '/path/to/key.pem';
    process.env['TLS_REJECT_UNAUTHORIZED'] = 'false';
    const config = loadConfig();
    expect(config.redis.tls!.rejectUnauthorized).toBe(false);
  });
});
