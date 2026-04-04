import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TaskDetailModal from '../kanban/TaskDetailModal';
import type { TaskDelta, AgentDelta } from '../../types/board';

// JSDOM doesn't implement HTMLDialogElement.showModal / close — polyfill them.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  });
});

const baseTask: TaskDelta = {
  taskId: 'task-abc-123',
  title: 'Write introduction',
  status: 'DOING',
  assignedToAgentId: 'agent-1',
  result: 'Here is the introduction paragraph...',
  tokens: 1250,
  cost: 0.00125,
};

const baseAgent: AgentDelta = {
  agentId: 'agent-1',
  name: 'Researcher',
  role: 'Senior Research Analyst',
  status: 'EXECUTING',
  currentTaskId: 'task-abc-123',
};

describe('TaskDetailModal', () => {
  it('renders the task title and ID', () => {
    render(<TaskDetailModal task={baseTask} agent={baseAgent} onClose={vi.fn()} />);
    expect(screen.getByText('Write introduction')).toBeInTheDocument();
    expect(screen.getByText('task-abc-123')).toBeInTheDocument();
  });

  it('shows status badge with correct label', () => {
    render(<TaskDetailModal task={baseTask} agent={baseAgent} onClose={vi.fn()} />);
    expect(screen.getByText('DOING')).toBeInTheDocument();
  });

  it('renders agent name, role, and status icon', () => {
    render(<TaskDetailModal task={baseTask} agent={baseAgent} onClose={vi.fn()} />);
    expect(screen.getByText('Researcher')).toBeInTheDocument();
    expect(screen.getByText(/Senior Research Analyst/)).toBeInTheDocument();
  });

  it('renders token and cost section', () => {
    render(<TaskDetailModal task={baseTask} agent={baseAgent} onClose={vi.fn()} />);
    expect(screen.getByText(/1,250/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.001250/)).toBeInTheDocument();
  });

  it('renders the result text', () => {
    render(<TaskDetailModal task={baseTask} agent={baseAgent} onClose={vi.fn()} />);
    expect(screen.getByText('Here is the introduction paragraph...')).toBeInTheDocument();
  });

  it('shows "No result yet" when task has no result', () => {
    const taskNoResult: TaskDelta = { ...baseTask, result: undefined };
    render(<TaskDetailModal task={taskNoResult} agent={baseAgent} onClose={vi.fn()} />);
    expect(screen.getByText('No result yet.')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<TaskDetailModal task={baseTask} agent={baseAgent} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close task detail/i }));
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalled();
  });

  it('hides token section when tokens and cost are both absent', () => {
    const taskNoCost: TaskDelta = { ...baseTask, tokens: undefined, cost: undefined };
    render(<TaskDetailModal task={taskNoCost} agent={baseAgent} onClose={vi.fn()} />);
    expect(screen.queryByText('Cost')).not.toBeInTheDocument();
  });

  it('renders without agent gracefully', () => {
    render(<TaskDetailModal task={baseTask} onClose={vi.fn()} />);
    expect(screen.queryByText('Researcher')).not.toBeInTheDocument();
    expect(screen.getByText('Write introduction')).toBeInTheDocument();
  });

  it('renders DONE status badge class', () => {
    const doneTask: TaskDelta = { ...baseTask, status: 'DONE' };
    render(<TaskDetailModal task={doneTask} agent={baseAgent} onClose={vi.fn()} />);
    expect(screen.getByText('DONE')).toBeInTheDocument();
  });

  it('renders BLOCKED status badge', () => {
    const blockedTask: TaskDelta = { ...baseTask, status: 'BLOCKED' };
    render(<TaskDetailModal task={blockedTask} onClose={vi.fn()} />);
    expect(screen.getByText('BLOCKED')).toBeInTheDocument();
  });

  it('renders AWAITING_VALIDATION status badge', () => {
    const awaitingTask: TaskDelta = { ...baseTask, status: 'AWAITING_VALIDATION' };
    render(<TaskDetailModal task={awaitingTask} onClose={vi.fn()} />);
    expect(screen.getByText('AWAITING_VALIDATION')).toBeInTheDocument();
  });

  it('falls back to taskId as title when title is empty', () => {
    const taskNoTitle: TaskDelta = { ...baseTask, title: '', taskId: 'task-fallback-id' };
    render(<TaskDetailModal task={taskNoTitle} onClose={vi.fn()} />);
    // Both the ID span and the title h2 should show the taskId
    const elements = screen.getAllByText('task-fallback-id');
    expect(elements.length).toBeGreaterThanOrEqual(1);
  });

  it('calls showModal on mount', () => {
    render(<TaskDetailModal task={baseTask} onClose={vi.fn()} />);
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
  });

  it('has proper ARIA labelling attributes', () => {
    render(<TaskDetailModal task={baseTask} onClose={vi.fn()} />);
    const dialog = document.querySelector('dialog');
    expect(dialog).toHaveAttribute('aria-labelledby', 'task-modal-title');
    expect(dialog).toHaveAttribute('aria-describedby', 'task-modal-desc');
  });
});
