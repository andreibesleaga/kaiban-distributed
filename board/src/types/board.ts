// SPDX-License-Identifier: GPL-3.0-only
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
  | 'AWAITING_VALIDATION'
  | 'STOPPED';

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
  tokens?: number;
  cost?: number;
}

export interface Metadata {
  totalTokens?: number;
  estimatedCost?: number;
  startTime?: number;
  endTime?: number;
}

// ─── Emergency STOP ALL (ADR-025; only with CONTROL_PLANE_ENABLED) ──────────

/** The latest emergency stop: everything sent at or before `issuedAt` was killed. */
export interface StopInfo {
  commandId: string;
  issuedAt: number;
  issuedBy: string;
  reason?: string;
}

/** How the gateway (`issued`) or a node (`applied` / `noop`) handled a stop. */
export interface ControlAck extends StopInfo {
  nodeId: string;
  agentId?: string;
  outcome: 'applied' | 'noop' | 'issued';
  aborted: number;
  at: number;
}

/** In the gateway snapshot only when the control plane is on. */
export interface ControlPlaneState {
  enabled: true;
  lastStop?: StopInfo;
  /** Node acknowledgements for `lastStop`. */
  acks: number;
}

export interface StateDelta {
  teamWorkflowStatus?: WorkflowStatus;
  agents?: AgentDelta[];
  tasks?: TaskDelta[];
  metadata?: Metadata;
  inputs?: { topic?: string; [key: string]: unknown };
  control?: ControlAck;
  controlPlane?: ControlPlaneState;
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
  /** null until the gateway says the control plane is on. */
  controlPlane: ControlPlaneState | null;
  /** Why the last STOP ALL failed (refused, unconfirmed, not connected); null when none. */
  controlError: string | null;
  /** Reason shown next to the connection badge (refusal message, session end); '' when none. */
  connectionDetail: string;
}
