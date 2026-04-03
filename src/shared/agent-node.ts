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
import { AgentStatePublisher } from "../adapters/state/agent-state-publisher";
import { createDriver } from "./driver-factory";
import { buildSecurityDeps } from "./build-security-deps";

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
 * Starts a kaiban-distributed agent node with a single call.
 * Resolves once the actor has started and the initial IDLE state has been published.
 */
export async function startAgentNode(config: AgentNodeConfig): Promise<void> {
  const { agentId, queue, agentConfig, displayName, role, label } = config;
  const redisUrl =
    config.redisUrl ?? process.env["REDIS_URL"] ?? "redis://localhost:6379";

  const driver = createDriver(agentId);
  const { actorDeps, tokenProvider } = buildSecurityDeps();

  const statePublisher = new AgentStatePublisher(redisUrl, {
    agentId,
    name: displayName,
    role,
  });
  const handler = statePublisher.wrapHandler(
    createKaibanTaskHandler(agentConfig, driver, tokenProvider),
  );
  const actor = new AgentActor(agentId, driver, queue, handler, actorDeps);

  await actor.start();
  console.log(`${label} ${displayName} started → ${queue}`);
  statePublisher.publishIdle();

  process.on("SIGTERM", () => {
    void (async (): Promise<void> => {
      await actor.stop();
      await driver.disconnect();
      await statePublisher.disconnect();
      process.exit(0);
    })();
  });
}
