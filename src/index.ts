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
  McpConfig,
  MessagingDriver,
  TlsConfig,
} from "./main/config";

// ── Actor runtime ────────────────────────────────────────────────────────────
export { AgentActor } from "./application/actor/AgentActor";
export type {
  TaskHandler,
  AgentActorDeps,
} from "./application/actor/AgentActor";

// ── Messaging ────────────────────────────────────────────────────────────────
export { BullMQDriver } from "./infrastructure/messaging/bullmq-driver";
export { KafkaDriver } from "./infrastructure/messaging/kafka-driver";
export { AmqpDriver } from "./infrastructure/messaging/amqp-driver";
export * from "./infrastructure/messaging/interfaces";
export * from "./infrastructure/messaging/channels";

// ── KaibanJS bridge ──────────────────────────────────────────────────────────
export * from "./infrastructure/kaibanjs/kaiban-agent-bridge";
export { KaibanTeamBridge } from "./infrastructure/kaibanjs/kaiban-team-bridge";

// ── Federation (A2A / MCP) ───────────────────────────────────────────────────
// A2A is served by the official @a2a-js/sdk v0.3 server (ADR-015). The custom
// `A2AConnector` was removed; these are the SDK-bridging building blocks.
export { KaibanAgentExecutor } from "./infrastructure/federation/a2a-executor";
export type { KaibanExecutorDeps } from "./infrastructure/federation/a2a-executor";
export { RedisTaskStore } from "./infrastructure/federation/a2a-task-store";
export type { RedisTaskStoreOptions } from "./infrastructure/federation/a2a-task-store";
export { AgentStatusTracker } from "./infrastructure/federation/agent-status-tracker";
export {
  buildAgentCard,
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
} from "./infrastructure/federation/a2a-agent-card";
export type { AgentCardInput } from "./infrastructure/federation/a2a-agent-card";
export {
  validateTaskInput,
  A2A_INPUT_CAPS,
} from "./infrastructure/federation/a2a-input-validation";
export type {
  ValidatedTaskInput,
  ValidationResult,
  A2AInputError,
} from "./infrastructure/federation/a2a-input-validation";
export { buildA2AStack } from "./infrastructure/federation/a2a-gateway-factory";
export type {
  A2AStack,
  A2AStackOptions,
} from "./infrastructure/federation/a2a-gateway-factory";
export { MCPFederationClient } from "./infrastructure/federation/mcp-client";
// MCP server (Phase M, ADR-017): internal Tools/Resources/Prompts/Elicitation
// surface over Streamable HTTP. A2A stays the public front door; MCP is internal.
export {
  buildMcpServer,
  MCP_TOOL_DISPATCH,
  MCP_RESOURCE_AGENTS,
  MCP_RESOURCE_AGENT_STATUS,
  MCP_PROMPT_DELEGATE,
} from "./infrastructure/federation/mcp-server";
export type {
  McpServerDeps,
  McpAllowList,
  McpDispatchInput,
  McpDispatchResult,
  McpAgentSummary,
  McpAgentStatusDetail,
} from "./infrastructure/federation/mcp-server";
export { createMcpHttpHandler } from "./infrastructure/federation/mcp-http";
export type { McpHttpHandler } from "./infrastructure/federation/mcp-http";

// ── Orchestration / resilience (master plan §B5.1 Phase R, ADR-018) ──────────
// Crash-safe single-active orchestrator (Redis checkpoint→resume, taskId
// idempotency) + resilience helpers (DLQ replay, readiness probes, graceful
// drain). Single-active — no leader election; failover = checkpoint, not HA.
export {
  WorkflowOrchestrator,
  InMemoryCheckpointStore,
  RedisCheckpointStore,
} from "./shared/orchestrator";
export type {
  RouterLike,
  StepCheckpoint,
  WorkflowCheckpoint,
  CheckpointStore,
  RunStepOptions,
  WorkflowOrchestratorOptions,
  RedisCheckpointStoreOptions,
} from "./shared/orchestrator";
export { replayDlq, DLQ_POISON_REASONS } from "./resilience/dlq-replay";
export type {
  DlqReplayDeps,
  DlqReplayResult,
  DlqRecord,
} from "./resilience/dlq-replay";
export {
  buildReadinessProbe,
  buildStartupProbe,
} from "./resilience/health";
export type {
  ProbeCheck,
  ProbeResult,
  ReadinessDeps,
} from "./resilience/health";
export { gracefulShutdown } from "./resilience/graceful-shutdown";
export type {
  ShutdownStep,
  GracefulShutdownOptions,
} from "./resilience/graceful-shutdown";

// ── Economics / FinOps (master plan §B5.1 Phase E, ADR-019) ──────────────────
// Fleet-wide cost control layered on top of the per-task token accounting (which
// it does NOT change — §B1.3 COST guard). All default-OFF (EconomicsConfig.enabled).
export * from "./economics/types";
export { RateCostLimiter, detectSpendAnomaly } from "./economics/rate-cost-limiter";
export type { RateCostLimiterDeps } from "./economics/rate-cost-limiter";
export { CostReservation } from "./economics/cost-reservation";
export type { CostReservationDeps } from "./economics/cost-reservation";
export { priceUsage, effectiveCacheHitRate } from "./economics/cache-accounting";
export { routeModel, estimatedStepCost } from "./economics/model-router";

// ── Governance & enforcement (master plan §B5.1 Phase G, ADR-020) ────────────
// External Action Gate (opt-in/no-op when unconfigured; when enabled, non-bypassable),
// hash-chained tamper-evident audit, policy-as-code, agent registry + kill-switch.
// All default-OFF (GovernanceConfig.enabled).
export * from "./governance/types";
export {
  ActionGate,
  firewallValidator,
  breakerValidator,
  costValidator,
} from "./governance/action-gate";
export type {
  ActionGateDeps,
  CostReservationLike,
} from "./governance/action-gate";
export { AuditLog } from "./governance/audit-log";
export { PolicyEngine, loadPolicySet } from "./governance/policy-engine";
export { AgentRegistry } from "./governance/registry";

// ── Memory hardening (master plan §B5.1 Phase G) ─────────────────────────────
// Tenant-keyspaced store with provenance/trust tags, retrieval-time RBAC, TTL
// eviction, and revoke-poisoned-entry.
export { SecureMemoryStore } from "./memory/secure-memory-store";
export type {
  TrustLevel,
  Classification,
  MemoryRole,
  MemoryProvenance,
  MemoryEntry,
  PutOptions,
  GetOptions,
} from "./memory/secure-memory-store";

// ── Gateway / adapters ───────────────────────────────────────────────────────
export { GatewayApp, SlidingWindowRateLimiter } from "./adapters/gateway/GatewayApp";
export type { GatewayAppDeps } from "./adapters/gateway/GatewayApp";
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
