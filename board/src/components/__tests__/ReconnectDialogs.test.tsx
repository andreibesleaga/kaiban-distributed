// SPDX-License-Identifier: GPL-3.0-only
/**
 * A reconnect empties the store until the gateway snapshot returns. The STOP ALL dialog and the
 * task detail modal must not come back by themselves when it does (UI-05). Real store.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import StopAllButton from '../control/StopAllButton';
import KanbanBoard from '../kanban/KanbanBoard';
import { useBoardStore } from '../../store/boardStore';

vi.mock('../../socket/socketClient', () => ({ sendStopAll: vi.fn() }));

HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
});
HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
});

const PLANE = { enabled: true as const, acks: 0 };
const TASK = { taskId: 't1', title: 'Research task', status: 'DOING' as const, assignedToAgentId: 'a1' };

beforeEach(() => {
  useBoardStore.setState({ controlPlane: null, tasks: new Map(), agents: new Map() });
});

describe('a reconnect while a dialog is open', () => {
  it('does not bring the STOP ALL dialog back when the snapshot restores the control plane', () => {
    useBoardStore.setState({ controlPlane: PLANE });
    render(<StopAllButton />);
    fireEvent.click(screen.getByRole('button', { name: 'STOP ALL' }));
    expect(screen.getByRole('dialog', { hidden: true })).toBeInTheDocument();

    act(() => useBoardStore.getState().resetState()); // socket 'connect'
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
    act(() => useBoardStore.setState({ controlPlane: PLANE })); // snapshot arrives

    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
    expect(screen.getByRole('button', { name: 'STOP ALL' })).toBeInTheDocument();
  });

  it('does not bring the task detail modal back when the snapshot restores the task', () => {
    useBoardStore.setState({ tasks: new Map([['t1', TASK]]) });
    render(<KanbanBoard />);
    fireEvent.click(screen.getByRole('button', { name: /Research task/ }));
    expect(screen.getByRole('dialog', { hidden: true })).toBeInTheDocument();

    act(() => useBoardStore.getState().resetState());
    act(() => useBoardStore.setState({ tasks: new Map([['t1', TASK]]) }));

    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  });

  it('keeps the task detail modal open while the task is still there', () => {
    useBoardStore.setState({ tasks: new Map([['t1', TASK]]) });
    render(<KanbanBoard />);
    fireEvent.click(screen.getByRole('button', { name: /Research task/ }));
    act(() => useBoardStore.getState().applyDelta({ tasks: [{ ...TASK, status: 'DONE' }] }));
    expect(screen.getByRole('dialog', { hidden: true })).toBeInTheDocument();
  });
});
