import { createServer } from "http";
import { Redis } from "ioredis";
import { loadConfig } from "./config";
import { buildMessagingDriver, initRuntimeTelemetry } from "./runtime";
import { A2AConnector } from "../infrastructure/federation/a2a-connector";
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
 * channels; workers consume them.
 */
export async function runGateway(): Promise<void> {
  const config = loadConfig();

  initRuntimeTelemetry(config);

  const messagingDriver = buildMessagingDriver(config);

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

  const agentCard = {
    name: config.serviceName,
    version: "1.0.0",
    description: "Kaiban distributed A2A gateway",
    capabilities: ["tasks.create", "tasks.get", "agent.status"],
    endpoints: { rpc: "/a2a/rpc" },
  };

  const connector = new A2AConnector(agentCard, messagingDriver);
  const gateway = new GatewayApp(connector, {
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
    await messagingDriver.disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
