import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AgentGrid from '../agents/AgentGrid';
import { useBoardStore } from '../../store/boardStore';
import type { AgentDelta, TaskDelta } from '../../types/board';

vi.mock('../../store/boardStore', () => ({
  useBoardStore: vi.fn(),
}));

const mockAgents = new Map<string, AgentDelta>([
  ['a1', { agentId: 'a1', name: 'Writer',     role: 'Writer Agent',     status: 'IDLE',      currentTaskId: null     }],
  ['a2', { agentId: 'a2', name: 'Researcher', role: 'Research Analyst', status: 'EXECUTING', currentTaskId: 'task-1' }],
]);

const mockTasks = new Map<string, TaskDelta>([
  ['task-1', { taskId: 'task-1', title: 'Find sources', status: 'DOING', assignedToAgentId: 'a2' }],
]);

describe('AgentGrid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows waiting message when no agents', () => {
    vi.mocked(useBoardStore).mockImplementation((selector: any) => {
      const str = selector.toString();
      if (str.includes('agents')) return new Map();
      if (str.includes('tasks'))  return new Map();
      return undefined;
    });
    render(<AgentGrid />);
    expect(screen.getByText(/Waiting for agents to connect/i)).toBeInTheDocument();
  });

  it('renders all agents when agents exist', () => {
    vi.mocked(useBoardStore).mockImplementation((selector: any) => {
      const str = selector.toString();
      if (str.includes('agents')) return mockAgents;
      if (str.includes('tasks'))  return mockTasks;
      return undefined;
    });
    render(<AgentGrid />);
    expect(screen.getByText('Writer')).toBeInTheDocument();
    expect(screen.getByText('Researcher')).toBeInTheDocument();
  });

  it('renders agents count heading', () => {
    vi.mocked(useBoardStore).mockImplementation((selector: any) => {
      const str = selector.toString();
      if (str.includes('agents')) return mockAgents;
      if (str.includes('tasks'))  return mockTasks;
      return undefined;
    });
    render(<AgentGrid />);
    expect(screen.getByText(/Agents \(2\)/i)).toBeInTheDocument();
  });

  it('passes the correct currentTask to each AgentCard', () => {
    vi.mocked(useBoardStore).mockImplementation((selector: any) => {
      const str = selector.toString();
      if (str.includes('agents')) return mockAgents;
      if (str.includes('tasks'))  return mockTasks;
      return undefined;
    });
    render(<AgentGrid />);
    expect(screen.getByText('Find sources')).toBeInTheDocument();
  });

  it('shows fallback card for agent without active task', () => {
    vi.mocked(useBoardStore).mockImplementation((selector: any) => {
      const str = selector.toString();
      if (str.includes('agents')) return mockAgents;
      if (str.includes('tasks'))  return new Map();
      return undefined;
    });
    render(<AgentGrid />);
    // Both agents lack an active task when the tasks map is empty
    const items = screen.getAllByText('No active task');
    expect(items.length).toBeGreaterThan(0);
  });
});
