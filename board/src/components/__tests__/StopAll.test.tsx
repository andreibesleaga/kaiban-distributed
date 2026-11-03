// SPDX-License-Identifier: GPL-3.0-only
/**
 * Emergency STOP ALL on the board (ADR-025): the button appears only with the
 * control plane on, confirms first, sends the reason; the banner shows the
 * latest stop; STOPPED tasks sit in the Blocked column with a Stopped badge.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import StopAllButton from '../control/StopAllButton';
import EmergencyStopBanner from '../control/EmergencyStopBanner';
import KanbanBoard from '../kanban/KanbanBoard';
import TaskCard from '../kanban/TaskCard';
import { useBoardStore } from '../../store/boardStore';
import { sendStopAll } from '../../socket/socketClient';

vi.mock('../../socket/socketClient', () => ({
  sendStopAll: vi.fn(),
  getGatewayUrl: vi.fn(() => 'http://localhost:3000'),
}));

HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
});
HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
});

beforeEach(() => {
  vi.clearAllMocks();
  useBoardStore.setState({ controlPlane: null, tasks: new Map(), agents: new Map() });
});

describe('StopAllButton', () => {
  it('is hidden until the gateway reports the control plane on', () => {
    const { container } = render(<StopAllButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens a confirmation; Stop all sends the trimmed reason and closes', () => {
    useBoardStore.setState({ controlPlane: { enabled: true, acks: 0 } });
    render(<StopAllButton />);
    fireEvent.click(screen.getByRole('button', { name: 'STOP ALL' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(within(dialog).getByText('Stop everything now?')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), { target: { value: '  runaway  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop all', hidden: true }));
    expect(sendStopAll).toHaveBeenCalledWith('runaway');
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  });

  it('sends no reason when the field is blank', () => {
    useBoardStore.setState({ controlPlane: { enabled: true, acks: 0 } });
    render(<StopAllButton />);
    fireEvent.click(screen.getByRole('button', { name: 'STOP ALL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop all', hidden: true }));
    expect(sendStopAll).toHaveBeenCalledWith(undefined);
  });

  it('Cancel closes without sending', () => {
    useBoardStore.setState({ controlPlane: { enabled: true, acks: 0 } });
    render(<StopAllButton />);
    fireEvent.click(screen.getByRole('button', { name: 'STOP ALL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', hidden: true }));
    expect(sendStopAll).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  });
});

describe('EmergencyStopBanner', () => {
  it('renders nothing without a stop', () => {
    useBoardStore.setState({ controlPlane: { enabled: true, acks: 0 } });
    const { container } = render(<EmergencyStopBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows when, who, why and the acknowledgement count', () => {
    const issuedAt = new Date(2026, 10, 3, 14, 5, 9).getTime();
    useBoardStore.setState({
      controlPlane: { enabled: true, lastStop: { commandId: 'c', issuedAt, issuedBy: 'ops', reason: 'runaway' }, acks: 3 },
    });
    render(<EmergencyStopBanner />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Emergency stop at 14:05:09 by ops');
    expect(banner).toHaveTextContent('— runaway');
    expect(banner).toHaveTextContent('3 node acknowledgements');
  });

  it('singular acknowledgement, no reason', () => {
    useBoardStore.setState({
      controlPlane: { enabled: true, lastStop: { commandId: 'c', issuedAt: 0, issuedBy: 'cli' }, acks: 1 },
    });
    render(<EmergencyStopBanner />);
    expect(screen.getByRole('status')).toHaveTextContent('1 node acknowledgement');
    expect(screen.getByRole('status')).not.toHaveTextContent('—');
  });
});

describe('STOPPED tasks', () => {
  it('sit in the Blocked column with a Stopped badge', () => {
    useBoardStore.setState({
      tasks: new Map([
        ['t1', { taskId: 't1', title: 'Killed task', status: 'STOPPED', assignedToAgentId: 'a' }],
        ['t2', { taskId: 't2', title: 'Failed task', status: 'BLOCKED', assignedToAgentId: 'a' }],
      ]),
    });
    render(<KanbanBoard />);
    const blocked = screen.getByText('Blocked').closest('div')!.parentElement!;
    expect(within(blocked).getByText('Killed task')).toBeInTheDocument();
    expect(within(blocked).getByText('Failed task')).toBeInTheDocument();
    expect(screen.getByText('⏹ Stopped')).toBeInTheDocument();
  });

  it('TaskCard shows the Stopped badge', () => {
    render(<TaskCard task={{ taskId: 't', title: 'x', status: 'STOPPED', assignedToAgentId: 'a' }} />);
    expect(screen.getByText('⏹ Stopped')).toHaveClass('bg-orange-900');
  });
});
