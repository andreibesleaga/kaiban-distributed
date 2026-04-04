import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import TaskCard from '../kanban/TaskCard';
import type { TaskDelta, AgentDelta } from '../../types/board';

const baseTask: TaskDelta = {
  taskId: 'task-001',
  title: 'Research AI trends',
  status: 'TODO',
  assignedToAgentId: 'agent-1',
};

const baseAgent: AgentDelta = {
  agentId: 'agent-1',
  name: 'Research Bot',
  role: 'Researcher',
  status: 'IDLE',
  currentTaskId: null,
};

describe('TaskCard', () => {
  it('renders task title', () => {
    render(<TaskCard task={baseTask} />);
    expect(screen.getByText('Research AI trends')).toBeInTheDocument();
  });

  it('falls back to taskId when title is empty', () => {
    const t: TaskDelta = { ...baseTask, title: '' };
    render(<TaskCard task={t} />);
    expect(screen.getByText('task-001')).toBeInTheDocument();
  });

  it('renders agent chip when agent is provided', () => {
    render(<TaskCard task={baseTask} agent={baseAgent} />);
    expect(screen.getByText(/Research Bot/)).toBeInTheDocument();
  });

  it('does not render agent chip when agent is absent', () => {
    render(<TaskCard task={baseTask} />);
    expect(screen.queryByText(/Research Bot/)).not.toBeInTheDocument();
  });

  it('renders result text when present', () => {
    const t: TaskDelta = { ...baseTask, result: 'Completed research.' };
    render(<TaskCard task={t} />);
    expect(screen.getByText('Completed research.')).toBeInTheDocument();
  });

  it('does not render result section when result is absent', () => {
    render(<TaskCard task={baseTask} />);
    expect(screen.queryByText('Completed research.')).not.toBeInTheDocument();
  });

  it('renders token/cost row when tokens are present', () => {
    const t: TaskDelta = { ...baseTask, tokens: 500, cost: 0.0025 };
    render(<TaskCard task={t} />);
    expect(screen.getByText(/500/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.0025/)).toBeInTheDocument();
  });

  it('does not render token row when tokens are absent', () => {
    render(<TaskCard task={baseTask} />);
    expect(screen.queryByText(/tok/)).not.toBeInTheDocument();
  });

  it('renders status badge for each status', () => {
    const statuses: TaskDelta['status'][] = ['TODO', 'DOING', 'DONE', 'BLOCKED', 'AWAITING_VALIDATION'];
    for (const status of statuses) {
      const { unmount } = render(<TaskCard task={{ ...baseTask, status }} />);
      expect(screen.getByText(status)).toBeInTheDocument();
      unmount();
    }
  });

  it('calls onClick when card is clicked', () => {
    const onClick = vi.fn();
    render(<TaskCard task={baseTask} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('calls onClick on Enter key press', () => {
    const onClick = vi.fn();
    render(<TaskCard task={baseTask} onClick={onClick} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('calls onClick on Space key press', () => {
    const onClick = vi.fn();
    render(<TaskCard task={baseTask} onClick={onClick} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not throw when onClick is not provided and card is clicked', () => {
    const { container } = render(<TaskCard task={baseTask} />);
    // No onClick → no role="button"; find via the aria-label attribute directly
    const card = container.firstChild as HTMLElement;
    expect(() => fireEvent.click(card)).not.toThrow();
  });

  it('has cursor-pointer class when onClick is provided', () => {
    const onClick = vi.fn();
    render(<TaskCard task={baseTask} onClick={onClick} />);
    expect(screen.getByRole('button').className).toContain('cursor-pointer');
  });

  it('does not have cursor-pointer class when onClick is absent', () => {
    const { container } = render(<TaskCard task={baseTask} />);
    expect((container.firstChild as HTMLElement).className).not.toContain('cursor-pointer');
  });

  it('has proper aria-label', () => {
    const onClick = vi.fn();
    render(<TaskCard task={baseTask} onClick={onClick} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'View details for task: Research AI trends');
  });

  it('is keyboard focusable (tabIndex=0) when onClick is provided', () => {
    const onClick = vi.fn();
    render(<TaskCard task={baseTask} onClick={onClick} />);
    expect(screen.getByRole('button')).toHaveAttribute('tabindex', '0');
  });

  it('does not have tabIndex or role="button" when onClick is absent', () => {
    const { container } = render(<TaskCard task={baseTask} />);
    const card = container.firstChild as HTMLElement;
    expect(card.getAttribute('role')).toBeNull();
    expect(card.getAttribute('tabindex')).toBeNull();
  });
});
