import 'dotenv/config';
import { startAgentNode } from '../../src/shared';
import { editorConfig, EDITOR_QUEUE } from './team-config';

startAgentNode({
  agentId:     process.env['AGENT_ID'] ?? 'editor',
  queue:       EDITOR_QUEUE,
  agentConfig: editorConfig,
  displayName: 'Morgan',
  role:        'Chief Research Editor',
  label:       '[Editor]',
}).catch((err: unknown) => { console.error('[Editor] Startup failed:', err); process.exit(1); });
