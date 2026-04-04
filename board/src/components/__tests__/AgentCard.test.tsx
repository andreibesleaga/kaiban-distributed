import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AgentCard from '../agents/AgentCard';
import type { AgentDelta, TaskDelta } from '../../types/board';

const baseAgent: AgentDelta = {
  agentId: 'agent-1',
  name: 'Research Bot',
  role: 'Senior Researcher',
  status: 'IDLE',
  currentTaskId: null,
};

const currentTask: TaskDelta = {
  taskId: 'task-1',
  title: 'Analyse AI trends',
  status: 'DOING',
  assignedToAgentId: 'agent-1',
};

describe('AgentCard', () => {
  it('renders agent name', () => {
    render(<AgentCard agent={baseAgent} />);
    expect(screen.getByText('Research Bot')).toBeInTheDocument();
  });

  it('renders agent role', () => {
    render(<AgentCard agent={baseAgent} />);
    expect(screen.getByText('Senior Researcher')).toBeInTheDocument();
  });

  it('renders IDLE status label', () => {
    render(<AgentCard agent={baseAgent} />);
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('renders THINKING status label', () => {
    const agent: AgentDelta = { ...baseAgent, status: 'THINKING' };
    render(<AgentCard agent={agent} />);
    expect(screen.getByText('Thinking')).toBeInTheDocument();
  });

  it('renders EXECUTING status label', () => {
    const agent: AgentDelta = { ...baseAgent, status: 'EXECUTING' };
    render(<AgentCard agent={agent} />);
    expect(screen.getByText('Executing')).toBeInTheDocument();
  });

  it('renders ERROR status label', () => {
    const agent: AgentDelta = { ...baseAgent, status: 'ERROR' };
    render(<AgentCard agent={agent} />);
    expect(screen.getByText('Error')).toBeInTheDocument();
  });

  it('shows "No active task" when no currentTask provided', () => {
    render(<AgentCard agent={baseAgent} />);
    expect(screen.getByText('No active task')).toBeInTheDocument();
  });

  it('renders current task title when provided', () => {
    render(<AgentCard agent={baseAgent} currentTask={currentTask} />);
    expect(screen.getByText('Analyse AI trends')).toBeInTheDocument();
  });

  it('falls back to agentId when name is empty', () => {
    const agent: AgentDelta = { ...baseAgent, name: '' };
    render(<AgentCard agent={agent} />);
    expect(screen.getByText('agent-1')).toBeInTheDocument();
  });

  it('falls back to taskId for current task when title is empty', () => {
    const task: TaskDelta = { ...currentTask, title: '', taskId: 'task-id-fallback' };
    render(<AgentCard agent={baseAgent} currentTask={task} />);
    expect(screen.getByText('task-id-fallback')).toBeInTheDocument();
  });
});
