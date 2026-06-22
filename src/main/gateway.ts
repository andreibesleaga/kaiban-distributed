import { createServer } from "http";
import { randomUUID } from "crypto";
import { Redis } from "ioredis";
import { loadConfig } from "./config";
import { buildMessagingDriver, initRuntimeTelemetry } from "./runtime";
import { createDriver, getDriverType } from "../shared/driver-factory";
import { CompletionRouter } from "../shared/completion-router";
import { buildA2AStack } from "../infrastructure/federation/a2a-gateway-factory";
import {
  createMcpHttpHandler,
  type McpHttpHandler,
} from "../infrastructure/federation/mcp-http";
import { validateTaskInput } from "../infrastructure/federation/a2a-input-validation";
import type { AppConfig } from "./config";
import type { IMessagingDriver } from "../infrastructure/messaging/interfaces";
import type { AgentStatusTracker } from "../infrastructure/federation/agent-status-tracker";
import { GatewayApp } from "../adapters/gateway/GatewayApp";
import { SocketGateway } from "../adapters/gateway/SocketGateway";
import { buildReadinessProbe, buildStartupProbe } from "../resilience/health";
import { gracefulShutdown } from "../resilience/graceful-shutdown";
import { createStructuredLogger } from "../shared/structured-logger";

const log = createStructuredLogger({ component: "gateway" });

/** Bounded deadline (ms) for graceful drain — fits inside k8s terminationGracePeriodSeconds. */
const SHUTDOWN_DEADLINE_MS = 25_000;

/** Stop accepting new HTTP connections; resolves once existing ones close. */
function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Build the env-gated MCP Streamable-HTTP handler (Phase M, ADR-017). Returns
 * `undefined` when disabled (default). `dispatch_task` publishes to the agent
 * mailbox through the SAME validated path as A2A (`validateTaskInput` caps +
 * `taskId` dedup); the agent lookups read the live status tracker.
 */
function buildGatewayMcpHandler(
  config: AppConfig,
  driver: Pick<IMessagingDriver, "publish">,
  statusTracker: Pick<AgentStatusTracker, "getStatus" | "hasSeen">,
): McpHttpHandler | undefined {
  if (!config.mcp.enabled) return undefined;
  return createMcpHttpHandler({
    requireDispatchConsent: config.mcp.requireDispatchConsent,
    allow: {
      ...(config.mcp.allowedTools ? { tools: config.mcp.allowedTools } : {}),
      ...(config.mcp.allowedResources
        ? { resources: config.mcp.allowedResources }
        : {}),
      ...(config.mcp.allowedPrompts
        ? { prompts: config.mcp.allowedPrompts }
        : {}),
    },
    dispatchTask: async ({ agentId, instruction, expectedOutput }) => {
      const validation = validateTaskInput({
        agentId,
        instruction,
        ...(expectedOutput !== undefined ? { expectedOutput } : {}),
      });
      if ("error" in validation) throw new Error(validation.error.message);
      const taskId = randomUUID();
      const p = validation.params;
      await driver.publish(`kaiban-agents-${p.agentId}`, {
        taskId,
        agentId: p.agentId,
        data: {
          instruction: p.instruction,
          ...(p.expectedOutput !== undefined
            ? { expectedOutput: p.expectedOutput }
            : {}),
        },
        timestamp: Date.now(),
      });
      return { taskId, status: "submitted" };
    },
    listAgents: () =>
      config.agentIds.map((id) => ({
        id,
        status: statusTracker.getStatus(id),
      })),
    getAgentStatus: (id) => ({
      agentId: id,
      status: statusTracker.getStatus(id),
      seen: statusTracker.hasSeen(id),
    }),
  });
}

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

  // k8s readiness/startup probes (Phase R). Readiness verifies Redis is
  // reachable (a BullMQ broker rides Redis; Kafka producers are created eagerly
  // and a Redis ping still gates the state/HITL plane). Startup flips once the
  // HTTP server is listening.
  let listening = false;
  const readinessProbe = buildReadinessProbe({
    checks: [
      {
        name: "redis",
        check: async (): Promise<boolean> =>
          (await redisSocketPub.ping()) === "PONG",
      },
    ],
  });
  const startupProbe = buildStartupProbe({ started: () => listening });

  // MCP server (Phase M) — internal Tools/Resources/Prompts/Elicitation surface,
  // OFF unless MCP_SERVER_ENABLED. Mounted behind the gateway's security chain.
  const mcpHandler = buildGatewayMcpHandler(
    config,
    messagingDriver,
    a2a.statusTracker,
  );

  const gateway = new GatewayApp({
    requestHandler: a2a.requestHandler,
    statusTracker: a2a.statusTracker,
    trustProxy: config.security.trustProxy,
    readinessProbe,
    startupProbe,
    ...(mcpHandler ? { mcpHandler, mcpPath: config.mcp.path } : {}),
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
    listening = true;
    log.info({ port: config.port }, "Gateway listening (HTTP/WebSocket/A2A)");
  });

  // Graceful drain (Phase R): stop intake → drain sockets → close A2A → close
  // drivers, ordered + best-effort, within a bounded deadline (after which k8s
  // SIGKILLs anyway). Readiness flips closed first so traffic stops being routed.
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "Shutting down gateway");
    listening = false;
    const result = await gracefulShutdown({
      deadlineMs: SHUTDOWN_DEADLINE_MS,
      steps: [
        { name: "stop-http-intake", run: (): Promise<void> => closeServer(httpServer) },
        { name: "drain-sockets", run: (): Promise<void> => socketGateway.shutdown() },
        ...(mcpHandler
          ? [{ name: "close-mcp", run: (): Promise<void> => mcpHandler.close() }]
          : []),
        { name: "close-a2a", run: (): Promise<void> => a2a.close() },
        {
          name: "close-failed-driver",
          run: (): Promise<void> | void =>
            isKafka ? failedDriver.disconnect() : undefined,
        },
        { name: "close-completed-driver", run: (): Promise<void> => completedDriver.disconnect() },
        { name: "close-messaging-driver", run: (): Promise<void> => messagingDriver.disconnect() },
      ],
    });
    log.info(
      { signal, completed: result.completed, timedOut: result.timedOut, errors: result.errors },
      "Gateway shutdown complete",
    );
    process.exit(result.timedOut || result.errors.length > 0 ? 1 : 0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
