// SPDX-License-Identifier: GPL-3.0-only
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ConnectionBadge from '../layout/ConnectionBadge';
import { useBoardStore } from '../../store/boardStore';

vi.mock('../../store/boardStore', () => ({
  useBoardStore: vi.fn(),
}));

/** The badge reads the status and the detail through two selectors. */
function mockState(connectionStatus: string, connectionDetail = '') {
  vi.mocked(useBoardStore).mockImplementation(((selector: (s: unknown) => unknown) =>
    selector({ connectionStatus, connectionDetail })) as never);
}

describe('ConnectionBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders CONNECTING label', () => {
    mockState('connecting');
    render(<ConnectionBadge />);
    expect(screen.getByText('CONNECTING')).toBeInTheDocument();
  });

  it('renders LIVE label', () => {
    mockState('live');
    render(<ConnectionBadge />);
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('renders OFFLINE label when disconnected', () => {
    mockState('disconnected');
    render(<ConnectionBadge />);
    expect(screen.getByText('OFFLINE')).toBeInTheDocument();
  });

  it('renders ERROR label', () => {
    mockState('error');
    render(<ConnectionBadge />);
    expect(screen.getByText('ERROR')).toBeInTheDocument();
  });

  it('shows why the connection is down (refusal message, session end)', () => {
    mockState('error', 'Invalid or expired board token');
    render(<ConnectionBadge />);
    expect(screen.getByText('Invalid or expired board token')).toHaveAttribute('title', 'Invalid or expired board token');
  });

  it('shows no detail text when there is none', () => {
    mockState('live');
    const { container } = render(<ConnectionBadge />);
    expect(container.querySelector('span[title]')).toBeNull();
  });
});
