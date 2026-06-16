// @vitest-environment jsdom
//
// Automated accessibility (a11y) tests using axe-core via vitest-axe.
//
// NOTE: these tests run under jsdom (per the pragma above) rather than the
// project-wide happy-dom environment, because axe-core needs a more complete
// DOM implementation (layout/computed-style queries) than happy-dom provides.
//
// Each key component is rendered with minimal props/store state (mirroring the
// per-component tests in src/components/__tests__) and asserted to have no axe
// violations.

import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';

import KanbanBoard from '../components/kanban/KanbanBoard';
import AgentCard from '../components/agents/AgentCard';
import AgentGrid from '../components/agents/AgentGrid';
import EventLog from '../components/log/EventLog';
import EconomicsPanel from '../components/economics/EconomicsPanel';
import Header from '../components/layout/Header';
import { useBoardStore } from '../store/boardStore';
import type { AgentDelta, TaskDelta, LogEntry } from '../types/board';

// Register vitest-axe matchers (toHaveNoViolations) on expect.
expect.extend(axeMatchers);

vi.mock('../store/boardStore', () => ({
  useBoardStore: vi.fn(),
}));

vi.mock('../socket/socketClient', () => ({
  getGatewayUrl: vi.fn(() => 'http://localhost:3000'),
}));

const mockAgents = new Map<string, AgentDelta>([
  ['a1', { agentId: 'a1', name: 'Writer',     role: 'Content Writer',   status: 'EXECUTING', currentTaskId: 't2' }],
  ['a2', { agentId: 'a2', name: 'Researcher', role: 'Research Analyst', status: 'IDLE',      currentTaskId: null }],
]);

const mockTasks = new Map<string, TaskDelta>([
  ['t1', { taskId: 't1', title: 'Research task', status: 'TODO',  assignedToAgentId: 'a1' }],
  ['t2', { taskId: 't2', title: 'Write draft',   status: 'DOING', assignedToAgentId: 'a1' }],
  ['t3', { taskId: 't3', title: 'Final edit',    status: 'DONE',  assignedToAgentId: 'a1', result: 'Done.', tokens: 100, cost: 0.001 }],
]);

const mockLog: LogEntry[] = [
  { id: 1, time: '12:00:00', type: 'WORKFLOW', message: 'Workflow started', highlight: false },
  { id: 2, time: '12:00:01', type: 'AGENT',    message: 'Agent executing',  highlight: true  },
];

// Mock store selector resolution (same pattern as the per-component tests).
function mockStore(state: {
  agents?: Map<string, AgentDelta>;
  tasks?: Map<string, TaskDelta>;
  log?: LogEntry[];
  metadata?: unknown;
  topic?: string;
  workflowStatus?: string;
  connectionStatus?: string;
}) {
  vi.mocked(useBoardStore).mockImplementation((selector: any) => {
    const str = selector.toString();
    if (str.includes('agents'))          return state.agents ?? new Map();
    if (str.includes('tasks'))           return state.tasks ?? new Map();
    if (str.includes('log'))             return state.log ?? [];
    if (str.includes('metadata'))        return state.metadata;
    if (str.includes('topic'))           return state.topic ?? '';
    if (str.includes('workflowStatus'))  return state.workflowStatus ?? 'INITIAL';
    if (str.includes('connectionStatus')) return state.connectionStatus ?? 'live';
    return undefined;
  });
}

const baseAgent: AgentDelta = {
  agentId: 'agent-1',
  name: 'Research Bot',
  role: 'Senior Researcher',
  status: 'IDLE',
  currentTaskId: null,
};

describe('accessibility (axe) — no violations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('KanbanBoard has no a11y violations', async () => {
    mockStore({ tasks: mockTasks, agents: mockAgents });
    const { container } = render(<KanbanBoard />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('AgentCard has no a11y violations', async () => {
    const { container } = render(
      <AgentCard agent={baseAgent} currentTask={mockTasks.get('t1')} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('AgentGrid has no a11y violations', async () => {
    mockStore({ agents: mockAgents, tasks: mockTasks });
    const { container } = render(<AgentGrid />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('EventLog has no a11y violations', async () => {
    mockStore({ log: mockLog });
    const { container } = render(<EventLog />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('EconomicsPanel has no a11y violations', async () => {
    mockStore({
      metadata: {
        totalTokens: 5240,
        estimatedCost: 0.125,
        startTime: Date.parse('2025-01-01T10:00:00Z'),
        endTime: Date.parse('2025-01-01T10:00:10Z'),
        activeNodes: [],
      },
      topic: 'AI in 2025',
      workflowStatus: 'FINISHED',
    });
    const { container } = render(<EconomicsPanel />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Header has no a11y violations', async () => {
    mockStore({
      workflowStatus: 'RUNNING',
      topic: 'AI in 2025',
      connectionStatus: 'live',
    });
    const { container } = render(<Header />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
