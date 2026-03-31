import 'dotenv/config';
import { AgentActor } from '../../src/application/actor/AgentActor';
import { createKaibanTaskHandler } from '../../src/infrastructure/kaibanjs/kaiban-agent-bridge';
import { AgentStatePublisher } from '../../src/adapters/state/agent-state-publisher';
import { createDriver } from './driver-factory';
import { writerConfig, WRITER_QUEUE } from './team-config';
import { buildSecurityDeps } from './build-security-deps';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const AGENT_ID = process.env['AGENT_ID'] ?? 'writer';
const driver = createDriver(AGENT_ID);
const { actorDeps, tokenProvider } = buildSecurityDeps();

const statePublisher = new AgentStatePublisher(REDIS_URL, {
  agentId: AGENT_ID, name: 'Atlas', role: 'Research Synthesiser',
});

const handler = statePublisher.wrapHandler(createKaibanTaskHandler(writerConfig, driver, tokenProvider));
const actor = new AgentActor(AGENT_ID, driver, WRITER_QUEUE, handler, actorDeps);

actor.start()
  .then(() => { console.log('[Writer] Atlas started →', WRITER_QUEUE); statePublisher.publishIdle(); })
  .catch((err: unknown) => { console.error('[Writer] Startup failed:', err); process.exit(1); });

process.on('SIGTERM', async () => {
  await actor.stop(); await driver.disconnect(); await statePublisher.disconnect(); process.exit(0);
});
