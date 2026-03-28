// ─── Domain types matching kaiban-distributed's state delta schema ──────────

export type WorkflowStatus =
  | 'INITIAL'
  | 'RUNNING'
  | 'FINISHED'
  | 'STOPPED'
  | 'ERRORED'
  | 'BLOCKED';

export type AgentStatus = 'IDLE' | 'THINKING' | 'EXECUTING' | 'ERROR';

export type TaskStatus =
  | 'TODO'
  | 'DOING'
  | 'DONE'
  | 'BLOCKED'
  | 'AWAITING_VALIDATION';

export type HitlDecision = 'PUBLISH' | 'REVISE' | 'REJECT';

export type ConnectionStatus = 'connecting' | 'live' | 'disconnected' | 'error';

// ─── State delta received on 'state:update' Socket.io event ─────────────────

export interface AgentDelta {
  agentId: string;
  name: string;
  role: string;
  status: AgentStatus;
  currentTaskId: string | null;
}

export interface TaskDelta {
  taskId: string;
  title: string;
  status: TaskStatus;
  assignedToAgentId: string;
  result?: string;
}

export interface Metadata {
  totalTokens?: number;
  estimatedCost?: number;
  startTime?: number;
  endTime?: number;
}

export interface StateDelta {
  teamWorkflowStatus?: WorkflowStatus;
  agents?: AgentDelta[];
  tasks?: TaskDelta[];
  metadata?: Metadata;
  inputs?: { topic?: string; [key: string]: unknown };
}

// ─── Board UI state ──────────────────────────────────────────────────────────

export interface LogEntry {
  id: number;
  time: string;
  type: string;
  message: string;
  highlight: boolean;
}

export interface BoardState {
  agents: Map<string, AgentDelta>;
  tasks: Map<string, TaskDelta>;
  workflowStatus: WorkflowStatus;
  metadata: Metadata | null;
  topic: string;
  connectionStatus: ConnectionStatus;
  log: LogEntry[];
}
