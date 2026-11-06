// SPDX-License-Identifier: GPL-3.0-only
/**
 * A STOP ALL that did not go through must be visible and announced next to the button,
 * not only written to the event log (UI-03). Real store, no socket.
 */
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import ControlErrorAlert from '../control/ControlErrorAlert';
import Header from '../layout/Header';
import { useBoardStore } from '../../store/boardStore';

vi.mock('../../socket/socketClient', () => ({
  sendStopAll: vi.fn(),
  getGatewayUrl: vi.fn(() => 'http://localhost:3000'),
}));

beforeEach(() => {
  useBoardStore.setState({ controlError: null, controlPlane: null });
});

describe('ControlErrorAlert', () => {
  it('is an empty live region while there is no error', () => {
    render(<ControlErrorAlert />);
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('shows the message in the alert when the store sets one, and clears it', () => {
    render(<ControlErrorAlert />);
    act(() => useBoardStore.getState().setControlError('STOP ALL refused: Missing board token'));
    expect(screen.getByRole('alert')).toHaveTextContent('STOP ALL refused: Missing board token');
    act(() => useBoardStore.getState().setControlError(null));
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('is part of the header, beside the STOP ALL button', () => {
    useBoardStore.setState({ controlPlane: { enabled: true, acks: 0 }, controlError: 'STOP ALL not confirmed' });
    render(<Header />);
    expect(screen.getByRole('alert')).toHaveTextContent('STOP ALL not confirmed');
    expect(screen.getByRole('button', { name: 'STOP ALL' })).toBeInTheDocument();
  });
});
