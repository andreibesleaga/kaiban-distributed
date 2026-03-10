export type AgentStatus = 'IDLE' | 'THINKING' | 'EXECUTING' | 'ERROR';

const VALID_AGENT_STATUSES: ReadonlySet<string> = new Set<AgentStatus>([
  'IDLE',
  'THINKING',
  'EXECUTING',
  'ERROR',
]);

export interface DistributedAgentState {
  agentId: string;
  status: AgentStatus;
  currentTaskId: string | null;
  memory: Record<string, unknown>;
  version: string;
}

export function isDistributedAgentState(value: unknown): value is DistributedAgentState {
  if (value === null || value === undefined || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v['agentId'] !== 'string') return false;
  if (typeof v['status'] !== 'string' || !VALID_AGENT_STATUSES.has(v['status'])) return false;
  if (typeof v['version'] !== 'string') return false;
  return true;
}
