import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import WorkflowBanner from '../workflow/WorkflowBanner';
import { useBoardStore } from '../../store/boardStore';
import * as socketClient from '../../socket/socketClient';

// Mock zustand store directly
vi.mock('../../store/boardStore', () => ({
  useBoardStore: vi.fn(),
}));

// Mock socket client
vi.mock('../../socket/socketClient', () => ({
  sendHitlDecision: vi.fn(),
}));

describe('WorkflowBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when state is RUNNING and no HITL tasks', () => {
    vi.mocked(useBoardStore).mockImplementation((selector: any) => {
      if (selector.toString().includes('workflowStatus')) return 'RUNNING';
      if (selector.toString().includes('tasks')) return new Map();
      return undefined;
    });

    const { container } = render(<WorkflowBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders HITL banner with buttons when AWAITING_VALIDATION tasks exist', () => {
    const mockTasks = new Map([
      ['t1', { taskId: 't1', title: 'Test Task', status: 'AWAITING_VALIDATION' }]
    ]);

    vi.mocked(useBoardStore).mockImplementation((selector: any) => {
      if (selector.toString().includes('workflowStatus')) return 'RUNNING';
      if (selector.toString().includes('tasks')) return mockTasks;
      return undefined;
    });

    render(<WorkflowBanner />);

    expect(screen.getByText('Human-in-the-Loop Review Required')).toBeInTheDocument();
    expect(screen.getByText(/Task: Test Task/)).toBeInTheDocument();

    const approveBtn = screen.getByText('Approve');
    const reviseBtn = screen.getByText('Revise');
    const rejectBtn = screen.getByText('Reject');

    expect(approveBtn).toBeInTheDocument();
    expect(reviseBtn).toBeInTheDocument();
    expect(rejectBtn).toBeInTheDocument();

    fireEvent.click(approveBtn);
    expect(socketClient.sendHitlDecision).toHaveBeenCalledWith('t1', 'PUBLISH');

    fireEvent.click(reviseBtn);
    expect(socketClient.sendHitlDecision).toHaveBeenCalledWith('t1', 'REVISE');

    fireEvent.click(rejectBtn);
    expect(socketClient.sendHitlDecision).toHaveBeenCalledWith('t1', 'REJECT');
  });

  it('renders FINISHED banner with NaN-free duration when timestamps are numeric', () => {
    vi.mocked(useBoardStore).mockImplementation((selector: any) => {
      if (selector.toString().includes('workflowStatus')) return 'FINISHED';
      if (selector.toString().includes('tasks')) return new Map();
      if (selector.toString().includes('metadata')) {
        return {
          totalTokens: 1500,
          estimatedCost: 0.05,
          startTime: 1000000,
          endTime: 1005000, // 5 seconds
        };
      }
      return undefined;
    });

    render(<WorkflowBanner />);

    expect(screen.getByText('Workflow finished')).toBeInTheDocument();
    expect(screen.getByText('1,500 tokens')).toBeInTheDocument();
    expect(screen.getByText('$0.0500')).toBeInTheDocument();
    expect(screen.getByText('5.0s')).toBeInTheDocument(); // Evaluates to 5.0 seconds correctly
  });
});
