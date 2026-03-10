import 'dotenv/config';
import { BullMQDriver } from '../../src/infrastructure/messaging/bullmq-driver';
import { AgentActor } from '../../src/application/actor/AgentActor';
import { createKaibanTaskHandler } from '../../src/infrastructure/kaibanjs/kaiban-agent-bridge';
import { AgentStatePublisher } from '../../src/adapters/state/agent-state-publisher';
import { researcherConfig, RESEARCHER_QUEUE } from './team-config';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const redisUrl = new URL(REDIS_URL);

const driver = new BullMQDriver({
  connection: { host: redisUrl.hostname, port: parseInt(redisUrl.port || '6379', 10) },
});

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
