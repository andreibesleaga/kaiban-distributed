import 'dotenv/config';
import { AgentActor } from '../../src/application/actor/AgentActor';
import { createKaibanTaskHandler } from '../../src/infrastructure/kaibanjs/kaiban-agent-bridge';
import { AgentStatePublisher } from '../../src/adapters/state/agent-state-publisher';
import type { MessagePayload } from '../../src/infrastructure/messaging/interfaces';
import { createDriver } from './driver-factory';
import { searcherConfig, SEARCHER_QUEUE } from './team-config';
import { buildSecurityDeps } from './build-security-deps';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const CHAOS_MODE = process.env['CHAOS_MODE'] === 'true';
// Each replica uses the same agentId 'searcher' so they compete on the same queue
// and merge to one entry in the board snapshot (matching the orchestrator's view).
// Set SEARCHER_ID explicitly to override (e.g. for a single local searcher process).
const SEARCHER_ID = process.env['SEARCHER_ID'] ?? 'searcher';

const driver = createDriver(SEARCHER_ID);
const { actorDeps, tokenProvider } = buildSecurityDeps();

const statePublisher = new AgentStatePublisher(REDIS_URL, {
  agentId: SEARCHER_ID, name: `Zara-${SEARCHER_ID}`, role: 'Web Research Specialist',
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
const actor = new AgentActor(SEARCHER_ID, driver, SEARCHER_QUEUE, handler, actorDeps);

if (CHAOS_MODE) console.log(`[Searcher:${SEARCHER_ID}] CHAOS MODE ENABLED (20% crash rate)`);

actor.start()
  .then(() => {
    console.log(`[Searcher:${SEARCHER_ID}] Zara started → ${SEARCHER_QUEUE}${CHAOS_MODE ? ' [CHAOS]' : ''}`);
    statePublisher.publishIdle();
  })
  .catch((err: unknown) => { console.error(`[Searcher:${SEARCHER_ID}] Startup failed:`, err); process.exit(1); });

process.on('SIGTERM', async () => {
  await actor.stop(); await driver.disconnect(); await statePublisher.disconnect(); process.exit(0);
});
