import 'dotenv/config';
import { AgentActor } from '../../src/application/actor/AgentActor';
import { createKaibanTaskHandler } from '../../src/infrastructure/kaibanjs/kaiban-agent-bridge';
import { AgentStatePublisher } from '../../src/adapters/state/agent-state-publisher';
import { createDriver } from './driver-factory';
import { editorConfig, EDITOR_QUEUE } from './team-config';
import { buildSecurityDeps } from './build-security-deps';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const driver = createDriver('editor');
const { actorDeps, tokenProvider } = buildSecurityDeps();

const statePublisher = new AgentStatePublisher(REDIS_URL, {
  agentId: 'editor', name: 'Morgan', role: 'Editorial Fact-Checker',
});

const handler = statePublisher.wrapHandler(createKaibanTaskHandler(editorConfig, driver, tokenProvider));
const actor = new AgentActor('editor', driver, EDITOR_QUEUE, handler, actorDeps);

actor.start()
  .then(() => { console.log('[Editor] Morgan started →', EDITOR_QUEUE); statePublisher.publishIdle(); })
  .catch((err: unknown) => { console.error('[Editor] Startup failed:', err); process.exit(1); });

process.on('SIGTERM', async () => {
  await actor.stop(); await driver.disconnect(); await statePublisher.disconnect(); process.exit(0);
});
