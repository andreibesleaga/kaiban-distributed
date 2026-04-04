import { describe, it, expect, beforeEach } from 'vitest';
import { useBoardStore } from '../boardStore';

// Helper: reset to initial state before each test
function resetStore() {
  useBoardStore.setState({
    agents: new Map(),
    tasks: new Map(),
    workflowStatus: 'INITIAL',
    metadata: null,
    topic: '',
    connectionStatus: 'connecting',
    log: [],
  });
}

// Minimal valid agent — currentTaskId is required by AgentDelta
const ag = (overrides: object) => ({
  agentId: 'a1',
  name: 'Researcher',
  role: 'researcher',
  status: 'IDLE' as const,
  currentTaskId: null as string | null,
  ...overrides,
});

// Minimal valid task — assignedToAgentId is required by TaskDelta
const tk = (overrides: object) => ({
  taskId: 't1',
  title: 'Write intro',
  status: 'DOING' as const,
  assignedToAgentId: 'a1',
  ...overrides,
});

describe('boardStore', () => {
  beforeEach(() => {
    resetStore();
  });

  // ─── applyDelta ──────────────────────────────────────────────────────────

  describe('applyDelta — workflow status', () => {
    it('updates workflowStatus from delta', () => {
      useBoardStore.getState().applyDelta({ teamWorkflowStatus: 'RUNNING' });
      expect(useBoardStore.getState().workflowStatus).toBe('RUNNING');
    });

    it('logs a WORKFLOW entry on status change', () => {
      useBoardStore.getState().applyDelta({ teamWorkflowStatus: 'FINISHED' });
      const log = useBoardStore.getState().log;
      expect(log.some((e) => e.type === 'WORKFLOW' && e.message.includes('FINISHED'))).toBe(true);
    });

    it('workflow log entry is highlighted', () => {
      useBoardStore.getState().applyDelta({ teamWorkflowStatus: 'RUNNING' });
      const log = useBoardStore.getState().log;
      const entry = log.find((e) => e.type === 'WORKFLOW');
      expect(entry?.highlight).toBe(true);
    });
  });

  describe('applyDelta — topic', () => {
    it('sets topic from inputs', () => {
      useBoardStore.getState().applyDelta({ inputs: { topic: 'AI ethics' } });
      expect(useBoardStore.getState().topic).toBe('AI ethics');
    });

    it('does not change topic when inputs.topic is absent', () => {
      useBoardStore.setState({ topic: 'Prior topic' });
      useBoardStore.getState().applyDelta({ teamWorkflowStatus: 'RUNNING' });
      expect(useBoardStore.getState().topic).toBe('Prior topic');
    });
  });

  describe('applyDelta — agents', () => {
    it('adds new agents', () => {
      useBoardStore.getState().applyDelta({ agents: [ag({ name: 'Researcher' })] });
      expect(useBoardStore.getState().agents.get('a1')?.name).toBe('Researcher');
    });

    it('shallow-merges existing agent fields', () => {
      useBoardStore.getState().applyDelta({ agents: [ag({ status: 'IDLE' as const })] });
      useBoardStore.getState().applyDelta({ agents: [ag({ status: 'EXECUTING' as const })] });
      const agent = useBoardStore.getState().agents.get('a1');
      expect(agent?.status).toBe('EXECUTING');
      expect(agent?.name).toBe('Researcher');
    });

    it('logs an AGENT entry for non-THINKING status', () => {
      useBoardStore.getState().applyDelta({ agents: [ag({ status: 'EXECUTING' as const })] });
      const log = useBoardStore.getState().log;
      expect(log.some((e) => e.type === 'AGENT')).toBe(true);
    });

    it('logs an LLM entry for THINKING status', () => {
      useBoardStore.getState().applyDelta({
        agents: [ag({ agentId: 'a1', name: 'Writer', role: 'writer', status: 'THINKING' as const })],
      });
      const log = useBoardStore.getState().log;
      expect(log.some((e) => e.type === 'LLM' && e.message.includes('Writer'))).toBe(true);
    });

    it('highlights EXECUTING agent log entries', () => {
      useBoardStore.getState().applyDelta({ agents: [ag({ status: 'EXECUTING' as const })] });
      const log = useBoardStore.getState().log;
      const entry = log.find((e) => e.type === 'AGENT' && e.message.includes('EXECUTING'));
      expect(entry?.highlight).toBe(true);
    });
  });

  describe('applyDelta — tasks', () => {
    it('adds new tasks', () => {
      useBoardStore.getState().applyDelta({ tasks: [tk({ title: 'Write intro' })] });
      expect(useBoardStore.getState().tasks.get('t1')?.title).toBe('Write intro');
    });

    it('shallow-merges existing task fields', () => {
      useBoardStore.getState().applyDelta({ tasks: [tk({ status: 'DOING' as const })] });
      useBoardStore.getState().applyDelta({ tasks: [tk({ status: 'DONE' as const, result: 'Done!' })] });
      const task = useBoardStore.getState().tasks.get('t1');
      expect(task?.status).toBe('DONE');
      expect(task?.result).toBe('Done!');
    });

    it('logs a TASK entry on task update', () => {
      useBoardStore.getState().applyDelta({ tasks: [tk({ status: 'DONE' as const })] });
      const log = useBoardStore.getState().log;
      expect(log.some((e) => e.type === 'TASK')).toBe(true);
    });

    it('highlights DONE task log entries', () => {
      useBoardStore.getState().applyDelta({ tasks: [tk({ status: 'DONE' as const })] });
      const log = useBoardStore.getState().log;
      const entry = log.find((e) => e.type === 'TASK' && e.message.includes('DONE'));
      expect(entry?.highlight).toBe(true);
    });

    it('highlights BLOCKED task log entries', () => {
      useBoardStore.getState().applyDelta({ tasks: [tk({ status: 'BLOCKED' as const })] });
      const log = useBoardStore.getState().log;
      const entry = log.find((e) => e.type === 'TASK');
      expect(entry?.highlight).toBe(true);
    });
  });

  describe('applyDelta — task clearing on new run', () => {
    it('clears tasks when RUNNING after FINISHED', () => {
      useBoardStore.setState({ workflowStatus: 'FINISHED' });
      useBoardStore.getState().applyDelta({ tasks: [tk({ taskId: 't-old', status: 'DONE' as const })] });
      useBoardStore.getState().applyDelta({ teamWorkflowStatus: 'RUNNING' });
      expect(useBoardStore.getState().tasks.size).toBe(0);
    });

    it('clears tasks when RUNNING after STOPPED', () => {
      useBoardStore.setState({ workflowStatus: 'STOPPED' });
      useBoardStore.getState().applyDelta({ tasks: [tk({ taskId: 't-old', status: 'DONE' as const })] });
      useBoardStore.getState().applyDelta({ teamWorkflowStatus: 'RUNNING' });
      expect(useBoardStore.getState().tasks.size).toBe(0);
    });

    it('does NOT clear tasks when going RUNNING from INITIAL', () => {
      useBoardStore.setState({ workflowStatus: 'INITIAL' });
      useBoardStore.getState().applyDelta({ tasks: [tk({ status: 'DOING' as const })] });
      useBoardStore.getState().applyDelta({ teamWorkflowStatus: 'RUNNING' });
      expect(useBoardStore.getState().tasks.size).toBeGreaterThan(0);
    });
  });

  describe('applyDelta — metadata', () => {
    it('sets metadata from delta', () => {
      useBoardStore.getState().applyDelta({ metadata: { estimatedCost: 0.05, totalTokens: 1000 } });
      expect(useBoardStore.getState().metadata?.estimatedCost).toBe(0.05);
    });

    it('deep-merges metadata across deltas', () => {
      useBoardStore.getState().applyDelta({ metadata: { estimatedCost: 0.01, totalTokens: 200 } });
      useBoardStore.getState().applyDelta({ metadata: { estimatedCost: 0.03, totalTokens: 600 } });
      expect(useBoardStore.getState().metadata?.estimatedCost).toBe(0.03);
    });
  });

  // ─── setConnectionStatus ─────────────────────────────────────────────────

  describe('setConnectionStatus', () => {
    it('updates connectionStatus', () => {
      useBoardStore.getState().setConnectionStatus('live');
      expect(useBoardStore.getState().connectionStatus).toBe('live');
    });

    it('logs a CONNECT entry when status is live', () => {
      useBoardStore.getState().setConnectionStatus('live');
      const log = useBoardStore.getState().log;
      expect(log.some((e) => e.type === 'CONNECT')).toBe(true);
    });

    it('highlights the CONNECT log entry', () => {
      useBoardStore.getState().setConnectionStatus('live');
      const entry = useBoardStore.getState().log.find((e) => e.type === 'CONNECT');
      expect(entry?.highlight).toBe(true);
    });

    it('logs a DISCONNECT entry when status is disconnected', () => {
      useBoardStore.getState().setConnectionStatus('disconnected');
      const log = useBoardStore.getState().log;
      expect(log.some((e) => e.type === 'DISCONNECT')).toBe(true);
    });

    it('logs a STATUS entry for connecting status', () => {
      useBoardStore.getState().setConnectionStatus('connecting');
      const log = useBoardStore.getState().log;
      expect(log.some((e) => e.type === 'STATUS')).toBe(true);
    });
  });

  // ─── addLog ──────────────────────────────────────────────────────────────

  describe('addLog', () => {
    it('prepends an entry to the log', () => {
      useBoardStore.getState().addLog('AGENT', 'Agent started');
      const log = useBoardStore.getState().log;
      expect(log[0].message).toBe('Agent started');
    });

    it('stores type and message correctly', () => {
      useBoardStore.getState().addLog('TASK', 'Task finished', true);
      const entry = useBoardStore.getState().log[0];
      expect(entry.type).toBe('TASK');
      expect(entry.message).toBe('Task finished');
      expect(entry.highlight).toBe(true);
    });

    it('highlight defaults to false', () => {
      useBoardStore.getState().addLog('LLM', 'LLM responded');
      expect(useBoardStore.getState().log[0].highlight).toBe(false);
    });

    it('each entry gets a unique id', () => {
      useBoardStore.getState().addLog('AGENT', 'A');
      useBoardStore.getState().addLog('AGENT', 'B');
      const [first, second] = useBoardStore.getState().log;
      expect(first.id).not.toBe(second.id);
    });
  });

  // ─── log cap ─────────────────────────────────────────────────────────────

  describe('log cap (MAX_LOG_ENTRIES = 200)', () => {
    it('does not exceed 200 log entries', () => {
      for (let i = 0; i < 210; i++) {
        useBoardStore.getState().addLog('AGENT', `Event ${i}`);
      }
      expect(useBoardStore.getState().log.length).toBe(200);
    });
  });

  // ─── resetState ──────────────────────────────────────────────────────────

  describe('resetState', () => {
    it('clears tasks', () => {
      useBoardStore.getState().applyDelta({ tasks: [tk({})] });
      useBoardStore.getState().resetState();
      expect(useBoardStore.getState().tasks.size).toBe(0);
    });

    it('clears agents', () => {
      useBoardStore.getState().applyDelta({ agents: [ag({})] });
      useBoardStore.getState().resetState();
      expect(useBoardStore.getState().agents.size).toBe(0);
    });

    it('resets workflowStatus to INITIAL', () => {
      useBoardStore.getState().applyDelta({ teamWorkflowStatus: 'FINISHED' });
      useBoardStore.getState().resetState();
      expect(useBoardStore.getState().workflowStatus).toBe('INITIAL');
    });

    it('clears topic', () => {
      useBoardStore.getState().applyDelta({ inputs: { topic: 'Old topic' } });
      useBoardStore.getState().resetState();
      expect(useBoardStore.getState().topic).toBe('');
    });

    it('clears metadata', () => {
      useBoardStore.getState().applyDelta({ metadata: { estimatedCost: 0.1, totalTokens: 500 } });
      useBoardStore.getState().resetState();
      expect(useBoardStore.getState().metadata).toBeNull();
    });

    it('preserves log entries after reset', () => {
      useBoardStore.getState().addLog('AGENT', 'Some log');
      useBoardStore.getState().resetState();
      expect(useBoardStore.getState().log.length).toBeGreaterThan(0);
    });

    it('preserves connectionStatus after reset', () => {
      useBoardStore.getState().setConnectionStatus('live');
      useBoardStore.getState().resetState();
      expect(useBoardStore.getState().connectionStatus).toBe('live');
    });
  });
});
