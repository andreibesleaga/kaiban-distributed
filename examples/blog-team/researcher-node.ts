import 'dotenv/config';
import { AgentActor } from '../../src/application/actor/AgentActor';
import { createKaibanTaskHandler } from '../../src/infrastructure/kaibanjs/kaiban-agent-bridge';
import { AgentStatePublisher } from '../../src/adapters/state/agent-state-publisher';
import { researcherConfig, RESEARCHER_QUEUE } from './team-config';
import { createDriver } from './driver-factory';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

// Each worker uses a unique consumer group suffix to avoid competing consumers
const driver = createDriver('-researcher');
const statePublisher = new AgentStatePublisher(REDIS_URL, {
  agentId: 'researcher',
  name: 'Ava',
  role: 'News Researcher',
});

const kaibanHandler = createKaibanTaskHandler(researcherConfig, driver);
const handler = statePublisher.wrapHandler(kaibanHandler);
const actor = new AgentActor('researcher', driver, RESEARCHER_QUEUE, handler);

actor.start()
  .then(() => {
    console.log('[Researcher] Node started — subscribed to:', RESEARCHER_QUEUE);
    statePublisher.publishIdle();
  })
  .catch((err: unknown) => { console.error('[Researcher] Startup failed:', err); process.exit(1); });

process.on('SIGTERM', async () => {
  console.log('[Researcher] Shutting down...');
  await actor.stop();
  await driver.disconnect();
  await statePublisher.disconnect();
  process.exit(0);
});
