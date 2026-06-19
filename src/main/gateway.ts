import { createServer } from "http";
import { Redis } from "ioredis";
import { loadConfig } from "./config";
import { buildMessagingDriver, initRuntimeTelemetry } from "./runtime";
import { createDriver, getDriverType } from "../shared/driver-factory";
import { CompletionRouter } from "../shared/completion-router";
import { buildA2AStack } from "../infrastructure/federation/a2a-gateway-factory";
import { GatewayApp } from "../adapters/gateway/GatewayApp";
import { SocketGateway } from "../adapters/gateway/SocketGateway";
import { createStructuredLogger } from "../shared/structured-logger";

const log = createStructuredLogger({ component: "gateway" });

/**
 * Gateway role (Finding #1 fix / ADR-013).
 *
 * The gateway is the HTTP / WebSocket / A2A front door ONLY. It MUST NOT build
 * any task-consuming AgentActors: handler-less actors used to subscribe to
 * `kaiban-agents-{id}` and silently discard every task they won, competing with
 * the real worker nodes. Task execution lives exclusively in the worker role
 * (`worker.ts`). The gateway publishes A2A-received tasks onto the messaging
 * channels via the SDK-backed `KaibanAgentExecutor`; workers consume them.
 *
 * A2A surface (ADR-015): the official `@a2a-js/sdk` v0.3 server is mounted behind
 * the gateway's security middleware. The custom `A2AConnector` has been removed.
 */
export async function runGateway(): Promise<void> {
  const config = loadConfig();

  initRuntimeTelemetry(config);

  // Driver used to PUBLISH A2A tasks onto agent mailboxes.
  const messagingDriver = buildMessagingDriver(config);

  // Router that resolves A2A task results. BullMQ uses one driver for both the
  // completed + failed channels; Kafka needs a second consumer group (I5/router).
  const isKafka = getDriverType() === "kafka";
  const completedDriver = createDriver("-gateway-completed");
  const failedDriver = isKafka ? createDriver("-gateway-failed") : completedDriver;
  const router = new CompletionRouter(completedDriver, failedDriver);

  const redisOpts = config.redis.tls
    ? {
        tls: {
          ca: config.redis.tls.ca,
          cert: config.redis.tls.cert,
          key: config.redis.tls.key,
        },
      }
    : {};
  const redisSocketPub = new Redis(config.redis.url, redisOpts);
  const redisSocketSub = new Redis(config.redis.url, redisOpts);
  const redisHitlPub = new Redis(config.redis.url, redisOpts);

  const a2a = buildA2AStack({
    driver: messagingDriver,
    router,
    redisUrl: config.redis.url,
    name: config.serviceName,
    version: "2.0.0",
    baseUrl: process.env["A2A_PUBLIC_URL"] ?? `http://localhost:${config.port}`,
    agentIds: config.agentIds,
    timeoutMs: config.agentTimeoutMs,
    jwtEnabled: Boolean(config.security.a2aJwtSecret),
  });
  await a2a.start();

  const gateway = new GatewayApp({
    requestHandler: a2a.requestHandler,
    statusTracker: a2a.statusTracker,
    trustProxy: config.security.trustProxy,
  });
  const httpServer = createServer(gateway.app);
  const socketGateway = new SocketGateway(
    httpServer,
    redisSocketPub,
    redisSocketSub,
    {
      validHitlDecisions: config.validHitlDecisions,
      hitlPublisher: redisHitlPub,
    },
  );

  socketGateway.initialize();

  httpServer.listen(config.port, () => {
    log.info({ port: config.port }, "Gateway listening (HTTP/WebSocket/A2A)");
  });

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "Shutting down gateway");
    await socketGateway.shutdown();
    await a2a.close();
    if (isKafka) await failedDriver.disconnect();
    await completedDriver.disconnect();
    await messagingDriver.disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
