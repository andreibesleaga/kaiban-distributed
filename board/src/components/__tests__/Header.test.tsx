import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Header from '../layout/Header';
import { useBoardStore } from '../../store/boardStore';
import * as socketClient from '../../socket/socketClient';

vi.mock('../../store/boardStore', () => ({
  useBoardStore: vi.fn(),
}));

vi.mock('../../socket/socketClient', () => ({
  getGatewayUrl: vi.fn(() => 'http://localhost:3000'),
}));

describe('Header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Kaiban brand name', () => {
    vi.mocked(useBoardStore).mockImplementation((selector: any) => {
      const str = selector.toString();
      if (str.includes('workflowStatus')) return 'INITIAL';
      if (str.includes('topic'))          return '';
      if (str.includes('connectionStatus')) return 'connecting';
      return undefined;
    });
    render(<Header />);
    expect(screen.getByText('Kaiban')).toBeInTheDocument();
    expect(screen.getByText('Distributed')).toBeInTheDocument();
  });

  it('renders the workflow status pill', () => {
    vi.mocked(useBoardStore).mockImplementation((selector: any) => {
      const str = selector.toString();
      if (str.includes('workflowStatus')) return 'RUNNING';
      if (str.includes('topic'))          return 'AI in 2025';
      if (str.includes('connectionStatus')) return 'live';
      return undefined;
    });
    render(<Header />);
    expect(screen.getByText('RUNNING')).toBeInTheDocument();
  });

  it('renders the topic when present', () => {
    vi.mocked(useBoardStore).mockImplementation((selector: any) => {
      const str = selector.toString();
      if (str.includes('workflowStatus')) return 'RUNNING';
      if (str.includes('topic'))          return 'AI in 2025';
      if (str.includes('connectionStatus')) return 'live';
      return undefined;
    });
    render(<Header />);
    expect(screen.getByText('AI in 2025')).toBeInTheDocument();
  });

  it('does not render topic element when topic is empty string', () => {
    vi.mocked(useBoardStore).mockImplementation((selector: any) => {
      const str = selector.toString();
      if (str.includes('workflowStatus')) return 'INITIAL';
      if (str.includes('topic'))          return '';
      if (str.includes('connectionStatus')) return 'connecting';
      return undefined;
    });
    render(<Header />);
    expect(screen.queryByText('AI in 2025')).not.toBeInTheDocument();
  });

  it('renders the gateway URL', () => {
    vi.mocked(useBoardStore).mockImplementation((selector: any) => {
      const str = selector.toString();
      if (str.includes('workflowStatus')) return 'INITIAL';
      if (str.includes('topic'))          return '';
      if (str.includes('connectionStatus')) return 'connecting';
      return undefined;
    });
    render(<Header />);
    expect(socketClient.getGatewayUrl).toHaveBeenCalled();
  });

  it('renders each workflow status', () => {
    const statuses = ['INITIAL', 'RUNNING', 'FINISHED', 'STOPPED', 'ERRORED', 'BLOCKED'] as const;
    for (const workflowStatus of statuses) {
      vi.mocked(useBoardStore).mockImplementation((selector: any) => {
        const str = selector.toString();
        if (str.includes('workflowStatus')) return workflowStatus;
        if (str.includes('topic'))          return '';
        if (str.includes('connectionStatus')) return 'connecting';
        return undefined;
      });
      const { unmount } = render(<Header />);
      expect(screen.getByText(workflowStatus)).toBeInTheDocument();
      unmount();
    }
  });
});
