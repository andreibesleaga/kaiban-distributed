import 'dotenv/config';
import { Redis } from 'ioredis';
import { AgentActor } from '../../src/application/actor/AgentActor';
import { createKaibanTaskHandler } from '../../src/infrastructure/kaibanjs/kaiban-agent-bridge';
import { AgentStatePublisher } from '../../src/adapters/state/agent-state-publisher';
import type { MessagePayload } from '../../src/infrastructure/messaging/interfaces';
import { createDriver } from './driver-factory';
import { searcherConfig, SEARCHER_QUEUE } from './team-config';
import { buildSecurityDeps } from './build-security-deps';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const CHAOS_MODE = process.env['CHAOS_MODE'] === 'true';

/**
 * Each replica atomically claims the next available index from a Redis counter
 * that the orchestrator resets at workflow start.  This gives each container/process
 * a unique ID (searcher-0, searcher-1, …) matching the orchestrator's buildSwarmAgents()
 * entries so the board shows exactly the indexed Zara-N cards and nothing else.
 *
 * Set SEARCHER_ID explicitly to override (e.g. for local single-process dev).
 */
async function assignSearcherId(): Promise<string> {
  if (process.env['SEARCHER_ID']) return process.env['SEARCHER_ID'];
  const tmp = new Redis(REDIS_URL);
  try {
    const idx = (await tmp.incr('kaiban:searcher:reg')) - 1;
    return `searcher-${idx}`;
  } finally {
    await tmp.quit();
  }
}

async function main(): Promise<void> {
  const SEARCHER_ID = await assignSearcherId();

  const driver = createDriver('searcher');
  const { actorDeps, tokenProvider } = buildSecurityDeps();

  // SEARCHER_ID is e.g. "searcher-2" → display name is "Zara-2"
  const displayName = SEARCHER_ID.startsWith('searcher-')
    ? `Zara-${SEARCHER_ID.slice('searcher-'.length)}`
    : `Zara-${SEARCHER_ID}`;

  const statePublisher = new AgentStatePublisher(REDIS_URL, {
    agentId: SEARCHER_ID, name: displayName, role: 'Web Research Specialist',
  });

  // Wrap handler with chaos simulation (20% crash rate)
  function wrapWithChaos(handler: (payload: MessagePayload) => Promise<unknown>) {
    return async (payload: MessagePayload): Promise<unknown> => {
      if (CHAOS_MODE && Math.random() < 0.2) {
        console.error(`[Searcher:${SEARCHER_ID}] CHAOS: simulating crash mid-task`);
        process.exit(1); // BullMQ auto-reassigns to another worker
      }
      return handler(payload);
    };
  }

  const baseHandler = createKaibanTaskHandler(searcherConfig, driver, tokenProvider);
  const handler = statePublisher.wrapHandler(
    CHAOS_MODE ? wrapWithChaos(baseHandler) : baseHandler
  );
  // Routing ID is 'searcher' (matches agentId in tasks); display ID via statePublisher is SEARCHER_ID
  const actor = new AgentActor('searcher', driver, SEARCHER_QUEUE, handler, actorDeps);

  if (CHAOS_MODE) console.log(`[Searcher:${SEARCHER_ID}] CHAOS MODE ENABLED (20% crash rate)`);

  await actor.start();
  console.log(`[Searcher:${SEARCHER_ID}] Zara started → ${SEARCHER_QUEUE}${CHAOS_MODE ? ' [CHAOS]' : ''}`);
  statePublisher.publishIdle();

  process.on('SIGTERM', async () => {
    await actor.stop(); await driver.disconnect(); await statePublisher.disconnect(); process.exit(0);
  });
}

main().catch((err: unknown) => {
  console.error('[Searcher] Startup failed:', err);
  process.exit(1);
});
