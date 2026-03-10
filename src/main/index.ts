import 'dotenv/config';
import { createServer } from 'http';
import { Redis } from 'ioredis';
import { initTelemetry } from '../infrastructure/telemetry/telemetry';
import { loadConfig } from './config';
import { BullMQDriver } from '../infrastructure/messaging/bullmq-driver';
import { KafkaDriver } from '../infrastructure/messaging/kafka-driver';
import { type IMessagingDriver } from '../infrastructure/messaging/interfaces';
import { AgentActor } from '../application/actor/AgentActor';
import { A2AConnector } from '../infrastructure/federation/a2a-connector';
import { GatewayApp } from '../adapters/gateway/GatewayApp';
import { SocketGateway } from '../adapters/gateway/SocketGateway';

function buildMessagingDriver(config: ReturnType<typeof loadConfig>): IMessagingDriver {
  if (config.messagingDriver === 'kafka') {
    console.log(`[kaiban-worker] Messaging: KafkaDriver (brokers: ${config.kafka.brokers.join(',')})`);
    return new KafkaDriver(config.kafka);
  }
  console.log(`[kaiban-worker] Messaging: BullMQDriver (redis: ${config.redis.host}:${config.redis.port})`);
  return new BullMQDriver({ connection: { host: config.redis.host, port: config.redis.port } });
}

async function main(): Promise<void> {
  const config = loadConfig();

  initTelemetry({
    serviceName: config.serviceName,
    exporterEndpoint: config.otelEndpoint,
  });

  const messagingDriver = buildMessagingDriver(config);

  const redisSocketPub = new Redis(config.redis.url);
  const redisSocketSub = new Redis(config.redis.url);

  const actors = config.agentIds.map(
    (agentId) => new AgentActor(agentId, messagingDriver, `kaiban-agents-${agentId}`),
  );

  const agentCard = {
    name: config.serviceName,
    version: '1.0.0',
    description: 'Kaiban distributed agent worker node',
    capabilities: ['tasks.create', 'tasks.get', 'agent.status'],
    endpoints: { rpc: '/a2a/rpc' },
  };

  const connector = new A2AConnector(agentCard, messagingDriver);
  const gateway = new GatewayApp(connector);
  const httpServer = createServer(gateway.app);
  const socketGateway = new SocketGateway(httpServer, redisSocketPub, redisSocketSub);

  socketGateway.initialize();

  await Promise.all(actors.map((actor) => actor.start()));

  httpServer.listen(config.port, () => {
    console.log(`[kaiban-worker] Listening on port ${config.port}`);
    console.log(`[kaiban-worker] Agents: ${config.agentIds.join(', ')}`);
  });

  process.on('SIGTERM', async () => {
    console.log('[kaiban-worker] Shutting down...');
    await socketGateway.shutdown();
    await messagingDriver.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[kaiban-worker] Fatal startup error:', err);
  process.exit(1);
});
