import 'dotenv/config';
import { startAgentNode } from '../../src/shared';
import { reviewerConfig, REVIEWER_QUEUE } from './team-config';

startAgentNode({
  agentId:     process.env['AGENT_ID'] ?? 'reviewer',
  queue:       REVIEWER_QUEUE,
  agentConfig: reviewerConfig,
  displayName: 'Sage',
  role:        'AI Ethics & Compliance Officer',
  label:       '[Reviewer]',
}).catch((err: unknown) => { console.error('[Reviewer] Startup failed:', err); process.exit(1); });
