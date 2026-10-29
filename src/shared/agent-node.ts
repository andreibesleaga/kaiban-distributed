// SPDX-License-Identifier: Apache-2.0
/**
 * Single-function bootstrap for agent worker nodes — shared across all examples.
 *
 * Consolidates the ~25 lines of identical boilerplate in every *-node.ts file into
 * a single `startAgentNode(config)` call. After calling this function the worker:
 *
 *   1. Creates a messaging driver (BullMQ or Kafka via MESSAGING_DRIVER env var).
 *   2. Builds security deps (firewall / circuit-breaker / token-provider from env).
 *   3. Creates an AgentStatePublisher → publishes IDLE to the board.
 *   4. Wraps the KaibanJS handler with state tracking.
 *   5. Starts the AgentActor on the configured queue.
 *   6. Registers a SIGTERM handler for graceful shutdown.
 *
 * Usage:
 *   import 'dotenv/config';
 *   import { startAgentNode } from '../../src/shared';
 *   import { researcherConfig, RESEARCHER_QUEUE } from './team-config';
 *
 *   await startAgentNode({
 *     agentId:     process.env['AGENT_ID'] ?? 'researcher',
 *     queue:       RESEARCHER_QUEUE,
 *     agentConfig: researcherConfig,
 *     displayName: 'Ava',
 *     role:        'News Researcher',
 *     label:       '[Researcher]',
 *   });
 */

import { AgentActor } from "../application/actor/AgentActor";
import {
  createKaibanTaskHandler,
  type KaibanAgentConfig,
} from "../infrastructure/kaibanjs/kaiban-agent-bridge";
import {
  AgentStatePublisher,
  type AgentInfo,
} from "../adapters/state/agent-state-publisher";
import { createDriver } from "./driver-factory";
import { buildSecurityDeps } from "./build-security-deps";
import { resolveSpendCaps } from "./budget";
import { gracefulShutdown } from "../resilience/graceful-shutdown";
import { createStructuredLogger } from "./structured-logger";
import { registerNodeDrain } from "./process-drain";

const log = createStructuredLogger({ component: "agent-node" });

/** Bounded deadline (ms) for a worker node's graceful drain on SIGTERM. */
const NODE_SHUTDOWN_DEADLINE_MS = 25_000;

export interface AgentNodeConfig {
  /** Unique agent identifier (also used as messaging group suffix). */
  agentId: string;
  /** Queue / topic name the actor listens on. */
  queue: string;
  /** KaibanJS agent configuration (model, tools, system prompt, …). */
  agentConfig: KaibanAgentConfig;
  /** Human-readable display name shown on the board (e.g. 'Ava'). */
  displayName: string;
  /** Role description shown on the board (e.g. 'News Researcher'). */
  role: string;
  /** Log prefix used in console output (e.g. '[Researcher]'). */
  label: string;
  /** Redis URL for the AgentStatePublisher. Defaults to REDIS_URL env var or localhost. */
  redisUrl?: string;
}

/**
 * Build the worker's `AgentStatePublisher` with the per-agent and per-task
 * token caps resolved from the environment (MAX_TOKEN_BUDGET /
 * MAX_TASK_TOKEN_BUDGET; defaults 200 000 / 50 000, the literal `unlimited`
 * removes one). `startAgentNode` uses it; a custom worker entry point that
 * cannot use `startAgentNode` (e.g. the global-research searcher) calls it
 * directly so it gets the same caps instead of none.
 */
export function createAgentStatePublisher(
  redisUrl: string,
  agentInfo: AgentInfo,
  env: NodeJS.ProcessEnv = process.env,
): AgentStatePublisher {
  const caps = resolveSpendCaps(env);
  return new AgentStatePublisher(redisUrl, agentInfo, {
    maxTokenBudget: caps.maxTokenBudget,
    maxTaskTokenBudget: caps.maxTaskTokenBudget,
  });
}

/**
 * Starts a kaiban-distributed agent node with a single call.
 * Resolves once the actor has started and the initial IDLE state has been published.
 */
export async function startAgentNode(config: AgentNodeConfig): Promise<void> {
  const { agentId, queue, agentConfig, displayName, role, label } = config;
  const redisUrl =
    config.redisUrl ?? process.env["REDIS_URL"] ?? "redis://localhost:6379";

  const driver = createDriver(agentId);
  const { actorDeps, tokenProvider } = buildSecurityDeps();

  // Per-agent and per-task token caps, enforced by the publisher's wrapHandler
  // before and after every task attempt (attempts whose KaibanJS workflow ends
  // BLOCKED included).
  const statePublisher = createAgentStatePublisher(redisUrl, {
    agentId,
    name: displayName,
    role,
  });
  const handler = statePublisher.wrapHandler(
    createKaibanTaskHandler(agentConfig, driver, tokenProvider),
  );
  // AGENT_TIMEOUT_MS bounds each task attempt on this worker (unset = 5 min default).
  const taskTimeoutMs = positiveIntEnv("AGENT_TIMEOUT_MS");
  // RETRY_ON_TIMEOUT=true|1 re-enables bounded retry of a timed-out task (default: off).
  const retryOnTimeout = boolEnv("RETRY_ON_TIMEOUT");
  const actor = new AgentActor(agentId, driver, queue, handler, {
    ...actorDeps,
    ...(taskTimeoutMs !== undefined ? { taskTimeoutMs } : {}),
    ...(retryOnTimeout ? { retryOnTimeout } : {}),
  });

  await actor.start();
  log.info({ label, agent: displayName, queue }, "Agent node started");
  statePublisher.publishIdle();

  // Graceful drain (Phase R): stop the actor (no new work) → drain in-flight →
  // close driver → close publisher, ordered + best-effort, within a bounded
  // deadline (after which the orchestrator SIGKILLs anyway). SIGTERM and SIGINT
  // drain every node of this process together, once, then flush telemetry and
  // exit (process-drain.ts).
  registerNodeDrain(async (): Promise<boolean> => {
    const result = await gracefulShutdown({
      deadlineMs: NODE_SHUTDOWN_DEADLINE_MS,
      steps: [
        { name: "stop-actor", run: (): Promise<void> => actor.stop() },
        { name: "close-driver", run: (): Promise<void> => driver.disconnect() },
        { name: "close-publisher", run: (): Promise<void> => statePublisher.disconnect() },
      ],
    });
    return !result.timedOut && result.errors.length === 0;
  });
}

/** A positive integer from the environment, or undefined (unset, text, 0, negative). */
function positiveIntEnv(name: string): number | undefined {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** True only for the literals "true" or "1" (the repo's boolean env convention). */
function boolEnv(name: string): boolean {
  const v = process.env[name];
  return v === "true" || v === "1";
}
