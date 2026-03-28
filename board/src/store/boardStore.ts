import { create } from 'zustand';
import type {
  AgentDelta,
  BoardState,
  ConnectionStatus,
  LogEntry,
  Metadata,
  StateDelta,
  TaskDelta,
  WorkflowStatus,
} from '../types/board';

const MAX_LOG_ENTRIES = 200;
let logIdCounter = 0;

function nowTime(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

const AGENT_ICONS: Record<string, string> = {
  IDLE: '⚪',
  EXECUTING: '🟢',
  THINKING: '🔵',
  ERROR: '🔴',
};

const TASK_ICONS: Record<string, string> = {
  DOING: '🔵',
  DONE: '✅',
  BLOCKED: '🔴',
  AWAITING_VALIDATION: '⏸',
};

interface BoardActions {
  applyDelta: (delta: StateDelta) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  addLog: (type: string, message: string, highlight?: boolean) => void;
}

const initialState: BoardState = {
  agents: new Map(),
  tasks: new Map(),
  workflowStatus: 'INITIAL',
  metadata: null,
  topic: '',
  connectionStatus: 'connecting',
  log: [],
};

export const useBoardStore = create<BoardState & BoardActions>((set) => ({
  ...initialState,

  applyDelta(delta: StateDelta) {
    set((state) => {
      const next = { ...state };

      // Workflow status
      if (delta.teamWorkflowStatus) {
        const incoming = delta.teamWorkflowStatus as WorkflowStatus;
        // New workflow run: clear tasks from the previous run so the board starts fresh
        if (incoming === 'RUNNING' &&
            (state.workflowStatus === 'FINISHED' || state.workflowStatus === 'STOPPED' || state.workflowStatus === 'ERRORED')) {
          next.tasks = new Map();
          next.metadata = null;
          next.topic = '';
        }
        next.workflowStatus = incoming;
      }

      // Topic from inputs
      if (delta.inputs?.topic) {
        next.topic = String(delta.inputs.topic);
      }

      // Agents — shallow-merge by agentId
      if (Array.isArray(delta.agents) && delta.agents.length > 0) {
        const agentMap = new Map(next.agents); // use next.agents (may have been cleared above)
        for (const a of delta.agents) {
          agentMap.set(a.agentId, { ...(agentMap.get(a.agentId) ?? {} as AgentDelta), ...a });
        }
        next.agents = agentMap;
      }

      // Tasks — shallow-merge by taskId
      if (Array.isArray(delta.tasks) && delta.tasks.length > 0) {
        const taskMap = new Map(next.tasks); // use next.tasks (may have been cleared above)
        for (const t of delta.tasks) {
          taskMap.set(t.taskId, { ...(taskMap.get(t.taskId) ?? {} as TaskDelta), ...t });
        }
        next.tasks = taskMap;
      }

      // Metadata — deep merge
      if (delta.metadata) {
        next.metadata = { ...(state.metadata ?? {}), ...delta.metadata } as Metadata;
      }

      // Build log entries for this delta
      const newEntries: LogEntry[] = [];

      if (delta.teamWorkflowStatus) {
        newEntries.push({
          id: ++logIdCounter,
          time: nowTime(),
          type: 'WORKFLOW',
          message: `Status → ${delta.teamWorkflowStatus}`,
          highlight: true,
        });
      }

      for (const a of delta.agents ?? []) {
        const icon = AGENT_ICONS[a.status] ?? '⬡';
        const taskRef = a.currentTaskId ? ` [${a.currentTaskId.slice(-8)}]` : '';
        newEntries.push({
          id: ++logIdCounter,
          time: nowTime(),
          type: 'AGENT',
          message: `${icon} ${a.name || a.agentId} → ${a.status}${taskRef}`,
          highlight: a.status === 'EXECUTING' || a.status === 'ERROR',
        });
      }

      for (const t of delta.tasks ?? []) {
        const icon = TASK_ICONS[t.status] ?? '📋';
        const preview = t.result ? ` — ${t.result.slice(0, 60)}` : '';
        newEntries.push({
          id: ++logIdCounter,
          time: nowTime(),
          type: 'TASK',
          message: `${icon} ${(t.title || t.taskId).slice(0, 50)} → ${t.status}${preview}`,
          highlight: ['DONE', 'BLOCKED', 'AWAITING_VALIDATION'].includes(t.status),
        });
      }

      if (newEntries.length > 0) {
        const combined = [...newEntries, ...state.log];
        next.log = combined.slice(0, MAX_LOG_ENTRIES);
      }

      return next;
    });
  },

  setConnectionStatus(status: ConnectionStatus) {
    set((state) => {
      const entry: LogEntry = {
        id: ++logIdCounter,
        time: nowTime(),
        type: status === 'live' ? 'CONNECT' : status === 'disconnected' ? 'DISCONNECT' : 'STATUS',
        message: status === 'live' ? 'Connected to gateway' : status === 'disconnected' ? 'Disconnected' : status,
        highlight: status === 'live',
      };
      return {
        connectionStatus: status,
        log: [entry, ...state.log].slice(0, MAX_LOG_ENTRIES),
      };
    });
  },

  addLog(type: string, message: string, highlight = false) {
    set((state) => {
      const entry: LogEntry = { id: ++logIdCounter, time: nowTime(), type, message, highlight };
      return { log: [entry, ...state.log].slice(0, MAX_LOG_ENTRIES) };
    });
  },
}));
