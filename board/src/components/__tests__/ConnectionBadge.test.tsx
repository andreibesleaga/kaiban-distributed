import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ConnectionBadge from '../layout/ConnectionBadge';
import { useBoardStore } from '../../store/boardStore';

vi.mock('../../store/boardStore', () => ({
  useBoardStore: vi.fn(),
}));

describe('ConnectionBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders CONNECTING label', () => {
    vi.mocked(useBoardStore).mockReturnValue('connecting');
    render(<ConnectionBadge />);
    expect(screen.getByText('CONNECTING')).toBeInTheDocument();
  });

  it('renders LIVE label', () => {
    vi.mocked(useBoardStore).mockReturnValue('live');
    render(<ConnectionBadge />);
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('renders OFFLINE label when disconnected', () => {
    vi.mocked(useBoardStore).mockReturnValue('disconnected');
    render(<ConnectionBadge />);
    expect(screen.getByText('OFFLINE')).toBeInTheDocument();
  });

  it('renders ERROR label', () => {
    vi.mocked(useBoardStore).mockReturnValue('error');
    render(<ConnectionBadge />);
    expect(screen.getByText('ERROR')).toBeInTheDocument();
  });
});
