// SPDX-License-Identifier: GPL-3.0-only
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
    connectionDetail: '',
    controlError: null,
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

    it('skips a malformed agent delta with no agentId (never keys the map by "undefined")', () => {
      useBoardStore.getState().applyDelta({ agents: [ag({ agentId: undefined })] });
      expect(useBoardStore.getState().agents.has('undefined' as unknown as string)).toBe(false);
      expect(useBoardStore.getState().agents.size).toBe(0);
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

    it('skips a malformed task delta with no taskId (never keys the map by "undefined")', () => {
      useBoardStore.getState().applyDelta({ tasks: [tk({ taskId: undefined })] });
      expect(useBoardStore.getState().tasks.has('undefined' as unknown as string)).toBe(false);
      expect(useBoardStore.getState().tasks.size).toBe(0);
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

  describe('applyDelta — a new run starts clean', () => {
    it('drops the previous run metadata even when the RUNNING delta carries its own', () => {
      useBoardStore.getState().applyDelta({
        teamWorkflowStatus: 'FINISHED',
        metadata: { startTime: 100, endTime: 200, totalTokens: 4321, estimatedCost: 0.05 },
      });
      useBoardStore.getState().applyDelta({ teamWorkflowStatus: 'RUNNING', metadata: { startTime: 900 } });
      expect(useBoardStore.getState().metadata).toEqual({ startTime: 900 });
    });
  });

  describe('applyDelta — agent heartbeats', () => {
    it('logs an agent row only when its status or task changed', () => {
      const agentRows = () => useBoardStore.getState().log.filter((e) => e.type === 'AGENT').length;
      useBoardStore.getState().applyDelta({ agents: [ag({ status: 'IDLE' as const })] });
      expect(agentRows()).toBe(1);
      useBoardStore.getState().applyDelta({ agents: [ag({ status: 'IDLE' as const })] }); // heartbeat
      expect(agentRows()).toBe(1);
      useBoardStore.getState().applyDelta({ agents: [ag({ status: 'EXECUTING' as const, currentTaskId: 't1' })] });
      expect(agentRows()).toBe(2);
      useBoardStore.getState().applyDelta({ agents: [ag({ status: 'EXECUTING' as const, currentTaskId: 't2' })] });
      expect(agentRows()).toBe(3);
    });

    it('still merges the agent when the heartbeat is not logged', () => {
      useBoardStore.getState().applyDelta({ agents: [ag({ status: 'IDLE' as const })] });
      useBoardStore.getState().applyDelta({ agents: [ag({ status: 'IDLE' as const, role: 'editor' })] });
      expect(useBoardStore.getState().agents.get('a1')?.role).toBe('editor');
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

    it('keeps the refusal reason as detail and in the log, as an ERROR row', () => {
      useBoardStore.getState().setConnectionStatus('error', 'Invalid or expired board token');
      expect(useBoardStore.getState().connectionDetail).toBe('Invalid or expired board token');
      const row = useBoardStore.getState().log.find((e) => e.type === 'ERROR');
      expect(row?.message).toBe('error: Invalid or expired board token');
    });

    it('clears the detail on the next status without one', () => {
      useBoardStore.getState().setConnectionStatus('error', 'x');
      useBoardStore.getState().setConnectionStatus('live');
      expect(useBoardStore.getState().connectionDetail).toBe('');
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

    it('clears a STOP ALL error', () => {
      useBoardStore.getState().setControlError('refused');
      expect(useBoardStore.getState().controlError).toBe('refused');
      useBoardStore.getState().resetState();
      expect(useBoardStore.getState().controlError).toBeNull();
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

describe('boardStore — emergency STOP ALL (ADR-025)', () => {
  beforeEach(() => {
    resetStore();
    useBoardStore.setState({ controlPlane: null });
  });

  it('starts with the control plane unknown (null)', () => {
    expect(useBoardStore.getState().controlPlane).toBeNull();
  });

  it('takes the control plane state from the gateway snapshot', () => {
    useBoardStore.getState().applyDelta({
      controlPlane: { enabled: true, acks: 0 },
    });
    expect(useBoardStore.getState().controlPlane).toEqual({ enabled: true, acks: 0 });
  });

  it('an issued stop becomes the last stop; node acks for it are counted and logged', () => {
    const { applyDelta } = useBoardStore.getState();
    applyDelta({ controlPlane: { enabled: true, acks: 0 } });
    const stop = { commandId: 'c-1', issuedAt: 1_000, issuedBy: 'ops', reason: 'runaway' };
    applyDelta({ control: { ...stop, nodeId: 'gateway', outcome: 'issued', aborted: 0, at: 1_000 } });
    applyDelta({ control: { ...stop, nodeId: 'n1', agentId: 'writer', outcome: 'applied', aborted: 2, at: 1_001 } });
    applyDelta({ control: { ...stop, nodeId: 'n2', outcome: 'noop', aborted: 0, at: 1_002 } });

    expect(useBoardStore.getState().controlPlane).toEqual({ enabled: true, lastStop: stop, acks: 2 });
    const messages = useBoardStore.getState().log.map((l) => l.message);
    expect(messages).toContain('🛑 STOP ALL issued by ops — runaway');
    expect(messages).toContain('🛑 writer on n1: applied, 2 task(s) killed');
    expect(messages).toContain('🛑 n2: noop, 0 task(s) killed');
    expect(useBoardStore.getState().log[0]!.highlight).toBe(true);
  });

  it('an older ack does not replace a newer stop; a newer stop resets the count', () => {
    const { applyDelta } = useBoardStore.getState();
    applyDelta({ controlPlane: { enabled: true, lastStop: { commandId: 'b', issuedAt: 20, issuedBy: 'x' }, acks: 3 } });
    applyDelta({ control: { commandId: 'a', issuedAt: 10, issuedBy: 'x', nodeId: 'n', outcome: 'applied', aborted: 0, at: 11 } });
    expect(useBoardStore.getState().controlPlane?.acks).toBe(3);
    applyDelta({ control: { commandId: 'c', issuedAt: 30, issuedBy: 'y', nodeId: 'gateway', outcome: 'issued', aborted: 0, at: 30 } });
    expect(useBoardStore.getState().controlPlane).toEqual({
      enabled: true,
      lastStop: { commandId: 'c', issuedAt: 30, issuedBy: 'y' },
      acks: 0,
    });
  });

  it('a control ack without control-plane state (control plane off) only logs', () => {
    useBoardStore.getState().applyDelta({
      control: { commandId: 'a', issuedAt: 1, issuedBy: 'x', nodeId: 'gateway', outcome: 'issued', aborted: 0, at: 1 },
    });
    expect(useBoardStore.getState().controlPlane).toBeNull();
    expect(useBoardStore.getState().log[0]!.message).toBe('🛑 STOP ALL issued by x');
  });

  it('a STOPPED task gets the stop icon and is highlighted in the log', () => {
    useBoardStore.getState().applyDelta({ tasks: [tk({ status: 'STOPPED' })] });
    const entry = useBoardStore.getState().log[0]!;
    expect(entry.message).toBe('⏹ Write intro → STOPPED');
    expect(entry.highlight).toBe(true);
  });

  it('resetState clears the control-plane state (the next snapshot restores it)', () => {
    useBoardStore.getState().applyDelta({ controlPlane: { enabled: true, acks: 1 } });
    useBoardStore.getState().resetState();
    expect(useBoardStore.getState().controlPlane).toBeNull();
  });
});
