import { readFileSync } from 'fs';

export type MessagingDriver = 'bullmq' | 'kafka';

export interface TlsConfig {
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
  rejectUnauthorized: boolean;
}

export interface AppConfig {
  port: number;
  serviceName: string;
  otelEndpoint?: string;
  messagingDriver: MessagingDriver;
  redis: {
    host: string;
    port: number;
    url: string;
    tls?: TlsConfig;
  };
  kafka: {
    brokers: string[];
    clientId: string;
    groupId: string;
    ssl?: TlsConfig;
  };
  agentIds: string[];
  security: {
    semanticFirewallEnabled: boolean;
    semanticFirewallLlmUrl?: string;
    jitTokensEnabled: boolean;
    circuitBreakerEnabled: boolean;
    circuitBreakerThreshold: number;
    circuitBreakerWindowMs: number;
  };
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Required environment variable "${key}" is not set`);
  return value;
}

function getEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function getBoolEnv(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (!val) return defaultValue;
  return val === 'true' || val === '1';
}

function parseMessagingDriver(value: string): MessagingDriver {
  if (value === 'kafka' || value === 'bullmq') return value;
  throw new Error(`MESSAGING_DRIVER must be "bullmq" or "kafka", got: "${value}"`);
}

function loadTlsConfig(caPath?: string, certPath?: string, keyPath?: string): TlsConfig | undefined {
  if (!caPath || !certPath || !keyPath) return undefined;
  return {
    ca: readFileSync(caPath),
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    rejectUnauthorized: getBoolEnv('TLS_REJECT_UNAUTHORIZED', true),
  };
}

export function loadConfig(): AppConfig {
  const agentIdsRaw = requireEnv('AGENT_IDS');
  const redisUrl = getEnv('REDIS_URL', 'redis://localhost:6379');
  const parsed = new URL(redisUrl);

  return {
    port: parseInt(getEnv('PORT', '3000'), 10),
    serviceName: getEnv('SERVICE_NAME', 'kaiban-worker'),
    otelEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
    messagingDriver: parseMessagingDriver(getEnv('MESSAGING_DRIVER', 'bullmq')),
    redis: {
      url: redisUrl,
      host: parsed.hostname,
      port: parseInt(parsed.port || '6379', 10),
      tls: loadTlsConfig(
        process.env['REDIS_TLS_CA'],
        process.env['REDIS_TLS_CERT'],
        process.env['REDIS_TLS_KEY'],
      ),
    },
    kafka: {
      brokers: getEnv('KAFKA_BROKERS', 'localhost:9092').split(','),
      clientId: getEnv('KAFKA_CLIENT_ID', 'kaiban-worker'),
      groupId: getEnv('KAFKA_GROUP_ID', 'kaiban-group'),
      ssl: loadTlsConfig(
        process.env['KAFKA_SSL_CA'],
        process.env['KAFKA_SSL_CERT'],
        process.env['KAFKA_SSL_KEY'],
      ),
    },
    agentIds: agentIdsRaw.split(',').map((id) => id.trim()).filter(Boolean),
    security: {
      semanticFirewallEnabled: getBoolEnv('SEMANTIC_FIREWALL_ENABLED', false),
      semanticFirewallLlmUrl: process.env['SEMANTIC_FIREWALL_LLM_URL'],
      jitTokensEnabled: getBoolEnv('JIT_TOKENS_ENABLED', false),
      circuitBreakerEnabled: getBoolEnv('CIRCUIT_BREAKER_ENABLED', false),
      circuitBreakerThreshold: parseInt(getEnv('CIRCUIT_BREAKER_THRESHOLD', '10'), 10),
      circuitBreakerWindowMs: parseInt(getEnv('CIRCUIT_BREAKER_WINDOW_MS', '60000'), 10),
    },
  };
}
