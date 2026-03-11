import 'dotenv/config';
import { AgentActor } from '../../src/application/actor/AgentActor';
import { createKaibanTaskHandler } from '../../src/infrastructure/kaibanjs/kaiban-agent-bridge';
import { AgentStatePublisher } from '../../src/adapters/state/agent-state-publisher';
import { createDriver } from './driver-factory';
import { researcherConfig, RESEARCHER_QUEUE } from './team-config';
import { buildSecurityDeps } from './build-security-deps';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const driver = createDriver('researcher');
const { actorDeps, tokenProvider } = buildSecurityDeps();

const statePublisher = new AgentStatePublisher(REDIS_URL, {
  agentId: 'researcher', name: 'Ava', role: 'News Researcher',
});

const handler = statePublisher.wrapHandler(createKaibanTaskHandler(researcherConfig, driver, tokenProvider));
const actor = new AgentActor('researcher', driver, RESEARCHER_QUEUE, handler, actorDeps);

actor.start()
  .then(() => { console.log('[Researcher] Ava started →', RESEARCHER_QUEUE); statePublisher.publishIdle(); })
  .catch((err: unknown) => { console.error('[Researcher] Startup failed:', err); process.exit(1); });

process.on('SIGTERM', async () => {
  await actor.stop(); await driver.disconnect(); await statePublisher.disconnect(); process.exit(0);
});
