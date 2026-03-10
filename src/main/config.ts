export type MessagingDriver = 'bullmq' | 'kafka';

export interface AppConfig {
  port: number;
  serviceName: string;
  otelEndpoint?: string;
  messagingDriver: MessagingDriver;
  redis: {
    host: string;
    port: number;
    url: string;
  };
  kafka: {
    brokers: string[];
    clientId: string;
    groupId: string;
  };
  agentIds: string[];
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Required environment variable "${key}" is not set`);
  return value;
}

function getEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function parseMessagingDriver(value: string): MessagingDriver {
  if (value === 'kafka' || value === 'bullmq') return value;
  throw new Error(`MESSAGING_DRIVER must be "bullmq" or "kafka", got: "${value}"`);
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
    },
    kafka: {
      brokers: getEnv('KAFKA_BROKERS', 'localhost:9092').split(','),
      clientId: getEnv('KAFKA_CLIENT_ID', 'kaiban-worker'),
      groupId: getEnv('KAFKA_GROUP_ID', 'kaiban-group'),
    },
    agentIds: agentIdsRaw.split(',').map((id) => id.trim()).filter(Boolean),
  };
}
