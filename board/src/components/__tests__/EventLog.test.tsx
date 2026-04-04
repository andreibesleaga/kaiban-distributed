import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventLog from '../log/EventLog';
import { useBoardStore } from '../../store/boardStore';
import type { LogEntry } from '../../types/board';

vi.mock('../../store/boardStore', () => ({
  useBoardStore: vi.fn(),
}));

function mockLog(log: LogEntry[]) {
  vi.mocked(useBoardStore).mockImplementation((selector: any) => selector({ log }));
}

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 1,
    time: '12:00:00',
    type: 'WORKFLOW',
    message: 'Test message',
    highlight: false,
    ...overrides,
  };
}

describe('EventLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows "No events yet" when log is empty', () => {
    mockLog([]);
    render(<EventLog />);
    expect(screen.getByText('No events yet…')).toBeInTheDocument();
  });

  it('shows event count when log has entries', () => {
    mockLog([entry({ id: 1 }), entry({ id: 2 })]);
    render(<EventLog />);
    expect(screen.getByText('2 events')).toBeInTheDocument();
  });

  it('shows 0 events when log is empty', () => {
    mockLog([]);
    render(<EventLog />);
    expect(screen.getByText('0 events')).toBeInTheDocument();
  });

  it('renders a row for each log entry', () => {
    mockLog([
      entry({ id: 1, message: 'First message' }),
      entry({ id: 2, message: 'Second message' }),
    ]);
    render(<EventLog />);
    expect(screen.getByText('First message')).toBeInTheDocument();
    expect(screen.getByText('Second message')).toBeInTheDocument();
  });

  it('renders the time for each entry', () => {
    mockLog([entry({ id: 1, time: '09:30:45' })]);
    render(<EventLog />);
    expect(screen.getByText('09:30:45')).toBeInTheDocument();
  });

  it('renders the type for each entry', () => {
    mockLog([entry({ id: 1, type: 'AGENT', message: 'agent did thing' })]);
    render(<EventLog />);
    expect(screen.getByText('AGENT')).toBeInTheDocument();
  });

  it('renders all known event types', () => {
    const types = ['WORKFLOW', 'AGENT', 'TASK', 'LLM', 'HITL', 'CONNECT', 'DISCONNECT', 'STATUS'];
    mockLog(types.map((type, i) => entry({ id: i + 1, type, message: `${type} event` })));
    render(<EventLog />);
    for (const type of types) {
      expect(screen.getByText(type)).toBeInTheDocument();
    }
  });

  it('applies highlight class when entry.highlight is true', () => {
    mockLog([entry({ id: 1, message: 'Highlighted entry', highlight: true })]);
    render(<EventLog />);
    const messageEl = screen.getByText('Highlighted entry');
    // The highlight class is on the parent row div
    expect(messageEl.closest('div[class*="bg-slate-800"]')).toBeTruthy();
  });

  it('does not apply highlight class when entry.highlight is false', () => {
    mockLog([entry({ id: 1, message: 'Normal entry', highlight: false })]);
    render(<EventLog />);
    const messageEl = screen.getByText('Normal entry');
    const row = messageEl.parentElement!;
    expect(row.className).not.toContain('bg-slate-800');
  });

  it('uses unknown type color fallback for unrecognised type', () => {
    mockLog([entry({ id: 1, type: 'UNKNOWN_TYPE', message: 'custom event' })]);
    render(<EventLog />);
    expect(screen.getByText('UNKNOWN_TYPE')).toBeInTheDocument();
    expect(screen.getByText('custom event')).toBeInTheDocument();
  });

  it('renders "Event Log" heading', () => {
    mockLog([]);
    render(<EventLog />);
    expect(screen.getByText('Event Log')).toBeInTheDocument();
  });
});
