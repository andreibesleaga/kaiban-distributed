import 'dotenv/config';
import { startAgentNode } from '../../src/shared';
import { writerConfig, WRITER_QUEUE } from './team-config';

startAgentNode({
  agentId:     process.env['AGENT_ID'] ?? 'writer',
  queue:       WRITER_QUEUE,
  agentConfig: writerConfig,
  displayName: 'Atlas',
  role:        'Research Synthesiser',
  label:       '[Writer]',
}).catch((err: unknown) => { console.error('[Writer] Startup failed:', err); process.exit(1); });
