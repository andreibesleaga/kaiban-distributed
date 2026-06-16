/* v8 ignore file — barrel re-exports are not executable statements */
/**
 * Public API for the `kaiban-distributed` library.
 *
 * This package is primarily an app/runtime you deploy (Docker/Kubernetes), but
 * its core primitives are also published as a library so you can wire your own
 * agent nodes programmatically:
 *
 *   import { AgentActor, BullMQDriver, createKaibanTaskHandler } from 'kaiban-distributed';
 *
 * The `files` allow-list ships only `dist/src` — examples, the board UI, and
 * tests are excluded from the published package.
 */

// ── Configuration ────────────────────────────────────────────────────────────
export { loadConfig } from "./main/config";
export type {
  AppConfig,
  MessagingDriver,
  TlsConfig,
} from "./main/config";

// ── Actor runtime ────────────────────────────────────────────────────────────
export { AgentActor } from "./application/actor/AgentActor";

// ── Messaging ────────────────────────────────────────────────────────────────
export { BullMQDriver } from "./infrastructure/messaging/bullmq-driver";
export { KafkaDriver } from "./infrastructure/messaging/kafka-driver";
export * from "./infrastructure/messaging/interfaces";
export * from "./infrastructure/messaging/channels";

// ── KaibanJS bridge ──────────────────────────────────────────────────────────
export * from "./infrastructure/kaibanjs/kaiban-agent-bridge";
export { KaibanTeamBridge } from "./infrastructure/kaibanjs/kaiban-team-bridge";

// ── Federation (A2A / MCP) ───────────────────────────────────────────────────
export { A2AConnector } from "./infrastructure/federation/a2a-connector";
export { MCPFederationClient } from "./infrastructure/federation/mcp-client";

// ── Gateway / adapters ───────────────────────────────────────────────────────
export { GatewayApp } from "./adapters/gateway/GatewayApp";
export { SocketGateway } from "./adapters/gateway/SocketGateway";
export { AgentStatePublisher } from "./adapters/state/agent-state-publisher";
export { DistributedStateMiddleware } from "./adapters/state/distributedMiddleware";

// ── Security ─────────────────────────────────────────────────────────────────
export { HeuristicFirewall } from "./infrastructure/security/heuristic-firewall";
export { EnvTokenProvider } from "./infrastructure/security/env-token-provider";
export { SlidingWindowBreaker } from "./infrastructure/security/sliding-window-breaker";
export * from "./infrastructure/security/channel-signing";
export * from "./infrastructure/security/a2a-auth";
export * from "./infrastructure/security/board-auth";
export * from "./domain/security/semantic-firewall";
export * from "./domain/security/circuit-breaker";
export * from "./domain/security/token-provider";

// ── Telemetry ────────────────────────────────────────────────────────────────
export * from "./infrastructure/telemetry/telemetry";
export * from "./infrastructure/telemetry/TraceContext";

// ── Domain ───────────────────────────────────────────────────────────────────
export * from "./domain/entities/DistributedTask";
export * from "./domain/entities/DistributedAgentState";
export * from "./domain/errors/DomainError";
export * from "./domain/result";
