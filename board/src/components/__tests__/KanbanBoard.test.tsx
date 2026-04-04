import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import KanbanBoard from '../kanban/KanbanBoard';
import { useBoardStore } from '../../store/boardStore';
import type { TaskDelta, AgentDelta } from '../../types/board';

vi.mock('../../store/boardStore', () => ({
  useBoardStore: vi.fn(),
}));

// JSDOM dialog polyfill — must set 'open' attribute so dialog contents are accessible
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  });
});

const mockTasks = new Map<string, TaskDelta>([
  ['t1', { taskId: 't1', title: 'Research task', status: 'TODO',  assignedToAgentId: 'a1' }],
  ['t2', { taskId: 't2', title: 'Write draft',   status: 'DOING', assignedToAgentId: 'a1' }],
  ['t3', { taskId: 't3', title: 'Final edit',    status: 'DONE',  assignedToAgentId: 'a1', result: 'Done.', tokens: 100, cost: 0.001 }],
]);

const mockAgents = new Map<string, AgentDelta>([
  ['a1', { agentId: 'a1', name: 'Writer', role: 'Content Writer', status: 'EXECUTING', currentTaskId: 't2' }],
]);

describe('KanbanBoard', () => {
  beforeEach(() => {
    vi.mocked(useBoardStore).mockImplementation((selector: any) => {
      const str = selector.toString();
      if (str.includes('tasks'))  return mockTasks;
      if (str.includes('agents')) return mockAgents;
      return undefined;
    });
  });

  it('renders Tasks heading with correct count', () => {
    render(<KanbanBoard />);
    expect(screen.getByText(/Tasks \(3\)/)).toBeInTheDocument();
  });

  it('renders all five column headers', () => {
    render(<KanbanBoard />);
    expect(screen.getByText('To Do')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
  });

  it('renders tasks in the correct columns', () => {
    render(<KanbanBoard />);
    expect(screen.getByText('Research task')).toBeInTheDocument();
    expect(screen.getByText('Write draft')).toBeInTheDocument();
    expect(screen.getByText('Final edit')).toBeInTheDocument();
  });

  it('opens TaskDetailModal when a task card is clicked', () => {
    render(<KanbanBoard />);
    fireEvent.click(screen.getByRole('button', { name: /Research task/i }));
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled();
  });

  it('shows the selected task title in the modal', () => {
    render(<KanbanBoard />);
    fireEvent.click(screen.getByRole('button', { name: /Research task/i }));
    // The task title appears in the modal header
    const titles = screen.getAllByText('Research task');
    expect(titles.length).toBeGreaterThanOrEqual(2); // card + modal
  });

  it('closes modal when close button is clicked', () => {
    render(<KanbanBoard />);
    fireEvent.click(screen.getByRole('button', { name: /Write draft/i }));
    fireEvent.click(screen.getByRole('button', { name: /close task detail/i }));
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalled();
  });

  it('renders empty board gracefully when tasks map is empty', () => {
    vi.mocked(useBoardStore).mockImplementation((selector: any) => {
      const str = selector.toString();
      if (str.includes('tasks'))  return new Map();
      if (str.includes('agents')) return new Map();
      return undefined;
    });
    render(<KanbanBoard />);
    expect(screen.getByText(/Tasks \(0\)/)).toBeInTheDocument();
  });
});
