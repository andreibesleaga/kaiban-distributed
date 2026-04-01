import "dotenv/config";
import { createServer } from "http";
import { Redis } from "ioredis";
import { initTelemetry } from "../infrastructure/telemetry/telemetry";
import { loadConfig } from "./config";
import { BullMQDriver } from "../infrastructure/messaging/bullmq-driver";
import { KafkaDriver } from "../infrastructure/messaging/kafka-driver";
import { type IMessagingDriver } from "../infrastructure/messaging/interfaces";
import { AgentActor } from "../application/actor/AgentActor";
import { A2AConnector } from "../infrastructure/federation/a2a-connector";
import { GatewayApp } from "../adapters/gateway/GatewayApp";
import { SocketGateway } from "../adapters/gateway/SocketGateway";
import type { ISemanticFirewall } from "../domain/security/semantic-firewall";
import type { ICircuitBreaker } from "../domain/security/circuit-breaker";
import type { ITokenProvider } from "../domain/security/token-provider";
import { HeuristicFirewall } from "../infrastructure/security/heuristic-firewall";
import { EnvTokenProvider } from "../infrastructure/security/env-token-provider";
import { SlidingWindowBreaker } from "../infrastructure/security/sliding-window-breaker";

function buildMessagingDriver(
  config: ReturnType<typeof loadConfig>,
): IMessagingDriver {
  if (config.messagingDriver === "kafka") {
    console.log(
      `[kaiban-worker] Messaging: KafkaDriver (brokers: ${config.kafka.brokers.join(",")})`,
    );
    return new KafkaDriver({
      ...config.kafka,
      ssl: config.kafka.ssl,
    });
  }
  console.log(
    `[kaiban-worker] Messaging: BullMQDriver (redis: ${config.redis.host}:${config.redis.port})`,
  );
  return new BullMQDriver({
    connection: { host: config.redis.host, port: config.redis.port },
    tls: config.redis.tls,
  });
}

function buildSecurityDeps(config: ReturnType<typeof loadConfig>): {
  firewall: ISemanticFirewall | undefined;
  circuitBreaker: ICircuitBreaker | undefined;
  tokenProvider: ITokenProvider | undefined;
} {
  const firewall = config.security.semanticFirewallEnabled
    ? new HeuristicFirewall()
    : undefined;

  const circuitBreaker = config.security.circuitBreakerEnabled
    ? new SlidingWindowBreaker(
        config.security.circuitBreakerThreshold,
        config.security.circuitBreakerWindowMs,
      )
    : undefined;

  const tokenProvider = config.security.jitTokensEnabled
    ? new EnvTokenProvider()
    : undefined;

  if (firewall)
    console.log("[kaiban-worker] Security: Semantic Firewall ENABLED");
  if (circuitBreaker)
    console.log("[kaiban-worker] Security: Circuit Breaker ENABLED");
  if (tokenProvider)
    console.log("[kaiban-worker] Security: JIT Token Provider ENABLED");

  return { firewall, circuitBreaker, tokenProvider };
}

async function main(): Promise<void> {
  const config = loadConfig();

  initTelemetry({
    serviceName: config.serviceName,
    exporterEndpoint: config.otelEndpoint,
  });

  const messagingDriver = buildMessagingDriver(config);
  const { firewall, circuitBreaker } = buildSecurityDeps(config);
  // Note: tokenProvider is only relevant in nodes (createKaibanTaskHandler).

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

  const actors = config.agentIds.map(
    (agentId) =>
      new AgentActor(
        agentId,
        messagingDriver,
        `kaiban-agents-${agentId}`,
        undefined,
        { firewall, circuitBreaker, taskTimeoutMs: config.agentTimeoutMs },
      ),
  );

  const agentCard = {
    name: config.serviceName,
    version: "1.0.0",
    description: "Kaiban distributed agent worker node",
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

  await Promise.all(actors.map((actor) => actor.start()));

  httpServer.listen(config.port, () => {
    console.log(`[kaiban-worker] Listening on port ${config.port}`);
    console.log(`[kaiban-worker] Agents: ${config.agentIds.join(", ")}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[kaiban-worker] ${signal} received — shutting down...`);
    await Promise.all(actors.map((actor) => actor.stop()));
    await socketGateway.shutdown();
    await messagingDriver.disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[kaiban-worker] Fatal startup error:", err);
  process.exit(1);
});
