import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import KanbanColumn from '../kanban/KanbanColumn';
import type { TaskDelta, AgentDelta } from '../../types/board';

const agents = new Map<string, AgentDelta>([
  ['a1', { agentId: 'a1', name: 'Writer', role: 'Writer Agent', status: 'IDLE', currentTaskId: null }],
]);

const tasks: TaskDelta[] = [
  { taskId: 't1', title: 'Task Alpha', status: 'TODO', assignedToAgentId: 'a1' },
  { taskId: 't2', title: 'Task Beta',  status: 'TODO', assignedToAgentId: 'a1' },
];

describe('KanbanColumn', () => {
  it('renders the column title', () => {
    render(<KanbanColumn title="To Do" tasks={[]} agents={agents} accent="border-slate-700" />);
    expect(screen.getByText('To Do')).toBeInTheDocument();
  });

  it('shows count badge with correct number', () => {
    render(<KanbanColumn title="To Do" tasks={tasks} agents={agents} accent="" />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders empty text when no tasks', () => {
    render(<KanbanColumn title="To Do" tasks={[]} agents={agents} accent="" emptyText="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('does not render empty text when tasks exist', () => {
    render(<KanbanColumn title="To Do" tasks={tasks} agents={agents} accent="" emptyText="Nothing here" />);
    expect(screen.queryByText('Nothing here')).not.toBeInTheDocument();
  });

  it('renders a TaskCard for each task', () => {
    render(<KanbanColumn title="To Do" tasks={tasks} agents={agents} accent="" />);
    expect(screen.getByText('Task Alpha')).toBeInTheDocument();
    expect(screen.getByText('Task Beta')).toBeInTheDocument();
  });

  it('calls onTaskClick with correct taskId when a card is clicked', () => {
    const onTaskClick = vi.fn();
    render(<KanbanColumn title="To Do" tasks={tasks} agents={agents} accent="" onTaskClick={onTaskClick} />);
    fireEvent.click(screen.getByRole('button', { name: /Task Alpha/i }));
    expect(onTaskClick).toHaveBeenCalledWith('t1');
  });

  it('calls onTaskClick with second task id when second card is clicked', () => {
    const onTaskClick = vi.fn();
    render(<KanbanColumn title="To Do" tasks={tasks} agents={agents} accent="" onTaskClick={onTaskClick} />);
    fireEvent.click(screen.getByRole('button', { name: /Task Beta/i }));
    expect(onTaskClick).toHaveBeenCalledWith('t2');
  });

  it('works without onTaskClick (no crash on card click)', () => {
    const { getByText } = render(<KanbanColumn title="To Do" tasks={tasks} agents={agents} accent="" />);
    // Without onTaskClick cards have no onClick → no role="button"; find by visible text
    expect(() => fireEvent.click(getByText('Task Alpha'))).not.toThrow();
  });

  it('passes the correct agent to each TaskCard', () => {
    render(<KanbanColumn title="To Do" tasks={tasks} agents={agents} accent="" />);
    // Agent chip for the first card
    expect(screen.getAllByText(/Writer/).length).toBeGreaterThanOrEqual(1);
  });
});
