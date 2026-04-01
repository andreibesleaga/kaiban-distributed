import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import EconomicsPanel from '../economics/EconomicsPanel';
import { useBoardStore } from '../../store/boardStore';

vi.mock('../../store/boardStore', () => ({
  useBoardStore: vi.fn(),
}));

describe('EconomicsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders default values when metadata is undefined', () => {
    vi.mocked(useBoardStore).mockReturnValue(undefined);
    
    render(<EconomicsPanel />);
    expect(screen.getByText('Total tokens')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders correctly formatted values when metadata is provided', () => {
    const startObj = new Date('2025-01-01T10:00:00Z');
    const startMs = startObj.getTime();
    const endMs = startMs + 10500; // 10.5 seconds later

    vi.mocked(useBoardStore).mockImplementation((selector: any) => {
      const field = selector.toString();
      if (field.includes('metadata')) {
        return {
          totalTokens: 5240,
          estimatedCost: 0.125,
          startTime: startMs,
          endTime: endMs,
          activeNodes: [],
        };
      }
      if (field.includes('workflowStatus')) return 'FINISHED';
      if (field.includes('topic')) return 'Test Topic';
      return undefined;
    });

    render(<EconomicsPanel />);

    // Tokens
    expect(screen.getByText(/5,?240/)).toBeInTheDocument();
    
    // Cost formatted to 4 decimals
    expect(screen.getByText('$0.1250')).toBeInTheDocument();

    // Duration manually evaluated (10500ms -> 10s)
    expect(screen.getByText('10s')).toBeInTheDocument();
    
    // Started localestring presence
    expect(screen.getByText(startObj.toLocaleTimeString())).toBeInTheDocument();
  });
});
