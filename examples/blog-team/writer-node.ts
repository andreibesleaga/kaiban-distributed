import 'dotenv/config';
import { AgentActor } from '../../src/application/actor/AgentActor';
import { createKaibanTaskHandler } from '../../src/infrastructure/kaibanjs/kaiban-agent-bridge';
import { AgentStatePublisher } from '../../src/adapters/state/agent-state-publisher';
import { createDriver } from './driver-factory';
import { writerConfig, WRITER_QUEUE } from './team-config';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const driver = createDriver('writer');

const statePublisher = new AgentStatePublisher(REDIS_URL, {
  agentId: 'writer', name: 'Kai', role: 'Content Creator',
});

const handler = statePublisher.wrapHandler(createKaibanTaskHandler(writerConfig, driver));
const actor = new AgentActor('writer', driver, WRITER_QUEUE, handler);

actor.start()
  .then(() => { console.log('[Writer] Kai started →', WRITER_QUEUE); statePublisher.publishIdle(); })
  .catch((err: unknown) => { console.error('[Writer] Startup failed:', err); process.exit(1); });

process.on('SIGTERM', async () => {
  await actor.stop(); await driver.disconnect(); await statePublisher.disconnect(); process.exit(0);
});
