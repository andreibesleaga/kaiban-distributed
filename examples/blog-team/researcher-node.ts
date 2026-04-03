import 'dotenv/config';
import { startAgentNode } from '../../src/shared';
import { researcherConfig, RESEARCHER_QUEUE } from './team-config';

startAgentNode({
  agentId:     process.env['AGENT_ID'] ?? 'researcher',
  queue:       RESEARCHER_QUEUE,
  agentConfig: researcherConfig,
  displayName: 'Ava',
  role:        'News Researcher',
  label:       '[Researcher]',
}).catch((err: unknown) => { console.error('[Researcher] Startup failed:', err); process.exit(1); });
