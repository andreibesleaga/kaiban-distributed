import 'dotenv/config';
import { AgentActor } from '../../src/application/actor/AgentActor';
import { createKaibanTaskHandler } from '../../src/infrastructure/kaibanjs/kaiban-agent-bridge';
import { AgentStatePublisher } from '../../src/adapters/state/agent-state-publisher';
import { createDriver } from './driver-factory';
import { reviewerConfig, REVIEWER_QUEUE } from './team-config';
import { buildSecurityDeps } from './build-security-deps';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const driver = createDriver('reviewer');
const { actorDeps, tokenProvider } = buildSecurityDeps();

const statePublisher = new AgentStatePublisher(REDIS_URL, {
  agentId: 'reviewer', name: 'Sage', role: 'AI Ethics & Compliance Officer',
});

const handler = statePublisher.wrapHandler(createKaibanTaskHandler(reviewerConfig, driver, tokenProvider));
const actor = new AgentActor('reviewer', driver, REVIEWER_QUEUE, handler, actorDeps);

actor.start()
  .then(() => { console.log('[Reviewer] Sage started →', REVIEWER_QUEUE); statePublisher.publishIdle(); })
  .catch((err: unknown) => { console.error('[Reviewer] Startup failed:', err); process.exit(1); });

process.on('SIGTERM', async () => {
  await actor.stop(); await driver.disconnect(); await statePublisher.disconnect(); process.exit(0);
});
