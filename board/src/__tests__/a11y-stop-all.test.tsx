// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
//
// Accessibility of the emergency STOP ALL pieces (ADR-025): the button, the
// open confirmation dialog, the stop banner and a Stopped task card.

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';
import StopAllButton from '../components/control/StopAllButton';
import EmergencyStopBanner from '../components/control/EmergencyStopBanner';
import TaskCard from '../components/kanban/TaskCard';
import { useBoardStore } from '../store/boardStore';

expect.extend(axeMatchers);

vi.mock('../socket/socketClient', () => ({
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
  useBoardStore.setState({
    controlPlane: {
      enabled: true,
      lastStop: { commandId: 'c', issuedAt: 0, issuedBy: 'ops', reason: 'runaway' },
      acks: 2,
    },
  });
});

describe('a11y — emergency STOP ALL', () => {
  it('the button has no violations', async () => {
    const { container } = render(<StopAllButton />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the open confirmation dialog has no violations', async () => {
    const { container } = render(<StopAllButton />);
    fireEvent.click(screen.getByRole('button', { name: 'STOP ALL' }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the stop banner has no violations', async () => {
    const { container } = render(<EmergencyStopBanner />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a Stopped task card has no violations', async () => {
    const { container } = render(
      <TaskCard task={{ taskId: 't', title: 'Killed', status: 'STOPPED', assignedToAgentId: 'a' }} onClick={() => undefined} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
