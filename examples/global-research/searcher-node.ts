// SPDX-License-Identifier: GPL-3.0-only
import 'dotenv/config';
import { hostname } from 'os';
import { AgentActor, type TaskHandler } from '../../src/application/actor/AgentActor';
import { createKaibanTaskHandler } from '../../src/infrastructure/kaibanjs/kaiban-agent-bridge';
import type { MessagePayload } from '../../src/infrastructure/messaging/interfaces';
import {
  createDriver,
  createAgentStatePublisher,
  controlPlaneEnabled,
  attachEmergencyStop,
} from '../../src/shared';
import { searcherConfig, SEARCHER_QUEUE } from './team-config';
import { assignSearcherId } from './searcher-id';
import { buildSecurityDeps } from '../../src/shared';
import { actorTimeoutOptionsFromEnv, registerWorkerDrain } from '../../src/shared/agent-node';
import { createRedisClient } from '../../src/shared/redis-connection';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const CHAOS_MODE = process.env['CHAOS_MODE'] === 'true';

/**
 * A replica claims the next free index (searcher-0, searcher-1, …) matching the
 * orchestrator's buildSwarmAgents() cards, and keeps it across an in-place restart
 * (see searcher-id.ts). Set SEARCHER_ID explicitly to override (single-process dev).
 */
async function claimSearcherId(): Promise<string> {
  if (process.env['SEARCHER_ID']) return process.env['SEARCHER_ID'];
  const tmp = createRedisClient(REDIS_URL);
  try {
    // Host name alone would make local replicas on one machine share an id; the
    // pid tells them apart, and in a restarted container it is the same again.
    return await assignSearcherId(tmp, `${hostname()}:${process.pid}`);
  } finally {
    await tmp.quit();
  }
}

async function main(): Promise<void> {
  const SEARCHER_ID = await claimSearcherId();

  const driver = createDriver('searcher');
  const { actorDeps, tokenProvider } = buildSecurityDeps();

  // SEARCHER_ID is e.g. "searcher-2" → display name is "Zara-2"
  const displayName = SEARCHER_ID.startsWith('searcher-')
    ? `Zara-${SEARCHER_ID.slice('searcher-'.length)}`
    : `Zara-${SEARCHER_ID}`;

  // Same capped publisher as startAgentNode (MAX_TOKEN_BUDGET / MAX_TASK_TOKEN_BUDGET).
  const statePublisher = createAgentStatePublisher(REDIS_URL, {
    agentId: SEARCHER_ID, name: displayName, role: 'Web Research Specialist',
  });

  // Wrap handler with chaos simulation (20% crash rate)
  function wrapWithChaos(handler: TaskHandler): TaskHandler {
    return async (payload: MessagePayload, signal?: AbortSignal): Promise<unknown> => {
      if (CHAOS_MODE && Math.random() < 0.2) {
        console.error(`[Searcher:${SEARCHER_ID}] CHAOS: simulating crash mid-task`);
        process.exit(1); // BullMQ auto-reassigns to another worker
      }
      return handler(payload, signal);
    };
  }

  const baseHandler = createKaibanTaskHandler(searcherConfig, driver, tokenProvider);
  const handler = statePublisher.wrapHandler(
    CHAOS_MODE ? wrapWithChaos(baseHandler) : baseHandler
  );
  // Routing ID is 'searcher' (matches agentId in tasks); display ID via statePublisher is SEARCHER_ID
  // Same AGENT_TIMEOUT_MS / RETRY_ON_TIMEOUT handling and bounded drain as startAgentNode.
  const actor = new AgentActor('searcher', driver, SEARCHER_QUEUE, handler, {
    ...actorDeps,
    ...actorTimeoutOptionsFromEnv(),
    onEmergencyStop: (payload): void => statePublisher.publishStopped(payload),
  });

  if (CHAOS_MODE) console.log(`[Searcher:${SEARCHER_ID}] CHAOS MODE ENABLED (20% crash rate)`);

  // Emergency STOP ALL (ADR-025), only with CONTROL_PLANE_ENABLED=true. Attached
  // before start so the saved stop is read before the first task is taken.
  const control = controlPlaneEnabled()
    ? await attachEmergencyStop({ actor, publisher: statePublisher, redisUrl: REDIS_URL, agentId: SEARCHER_ID })
    : null;

  await actor.start();
  console.log(`[Searcher:${SEARCHER_ID}] Zara started → ${SEARCHER_QUEUE}${CHAOS_MODE ? ' [CHAOS]' : ''}`);
  statePublisher.publishIdle();

  registerWorkerDrain({ actor, control, driver, statePublisher });
}

main().catch((err: unknown) => {
  console.error('[Searcher] Startup failed:', err);
  process.exit(1);
});
