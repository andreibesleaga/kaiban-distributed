/* v8 ignore file — barrel re-exports are not executable statements */
/**
 * Public API for `src/shared` — barrel re-export of all shared utilities.
 *
 * Import everything a kaiban-distributed example needs from a single path:
 *
 *   import {
 *     createLogger,
 *     createDriver, getDriverType,
 *     buildSecurityDeps,
 *     buildLLMConfig,
 *     parseHandlerResult, parseRecommendation, parseScore, normaliseEditorialText,
 *     CompletionRouter,
 *     createRpcClient,
 *     waitForHITLDecision,
 *     OrchestratorStatePublisher,
 *     startAgentNode,
 *   } from '../../src/shared';
 */

export { createLogger } from "./logger";
export type { Logger } from "./logger";

export { getDriverType, createDriver } from "./driver-factory";
export type { DriverType } from "./driver-factory";

export { getBoolEnv, buildSecurityDeps } from "./build-security-deps";

export { buildLLMConfig } from "./build-llm-config";

export {
  parseHandlerResult,
  parseRecommendation,
  parseScore,
  normaliseEditorialText,
} from "./parse-handler-result";
export type { HandlerResult } from "./parse-handler-result";

export { CompletionRouter } from "./completion-router";

export { createRpcClient } from "./rpc-client";
export type { RpcClient } from "./rpc-client";

export { waitForHITLDecision } from "./hitl";
export type { HitlDecision, HitlOptions } from "./hitl";

export { OrchestratorStatePublisher } from "./orchestrator-state-publisher";

export {
  WorkflowOrchestrator,
  InMemoryCheckpointStore,
  RedisCheckpointStore,
  spendOfHandlerResult,
} from "./orchestrator";
export type {
  WorkflowStop,
  WorkflowStopReason,
  RouterLike,
  StepCheckpoint,
  WorkflowCheckpoint,
  CheckpointStore,
  RunStepOptions,
  WorkflowOrchestratorOptions,
  RedisCheckpointStoreOptions,
} from "./orchestrator";

export { startAgentNode } from "./agent-node";
export type { AgentNodeConfig } from "./agent-node";

export { dispatchToAgent, AGENT_CHANNEL_PREFIX } from "./dispatch";
export type { DispatchParams } from "./dispatch";

export {
  BudgetExceededError,
  workflowBudgetFromEnv,
  resolveSpendCaps,
  parseCapEnv,
  resetCapWarnings,
  formatCap,
  overBudgetReason,
  assertWithinBudget,
  DEFAULT_MAX_WORKFLOW_COST_USD,
  DEFAULT_MAX_TOKEN_BUDGET,
  DEFAULT_MAX_TASK_TOKEN_BUDGET,
  UNLIMITED,
  UNLIMITED_SENTINEL,
} from "./budget";
export type { SpendTotals, WorkflowBudget, SpendCaps } from "./budget";
// Base class of every error the actor does not retry (BudgetExceededError extends it).
export { DomainError, NonRetryableError } from "../domain/errors/DomainError";
