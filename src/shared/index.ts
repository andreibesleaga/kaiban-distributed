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

export { startAgentNode } from "./agent-node";
export type { AgentNodeConfig } from "./agent-node";
