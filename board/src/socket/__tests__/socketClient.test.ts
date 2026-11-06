// SPDX-License-Identifier: GPL-3.0-only
/**
 * socketClient — sendHitlDecision unit tests.
 *
 * Tests the board-side HITL decision emission: correct event shape, ACK timeout,
 * disconnected socket guard, and error logging on gateway rejection.
 *
 * Strategy: mock socket.io-client and boardStore, then import sendHitlDecision
 * after mocks are in place. initSocket() is called to create the socket instance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock boardStore (must be set up before importing socketClient) ────────────

const mockAddLog = vi.fn();
const mockResetState = vi.fn();
const mockSetConnectionStatus = vi.fn();
const mockApplyDelta = vi.fn();
const mockSetControlError = vi.fn();

vi.mock('../../store/boardStore', () => ({
  useBoardStore: {
    getState: vi.fn(() => ({
      addLog: mockAddLog,
      resetState: mockResetState,
      setConnectionStatus: mockSetConnectionStatus,
      applyDelta: mockApplyDelta,
      setControlError: mockSetControlError,
    })),
  },
}));

// ── Mock socket.io-client ────────────────────────────────────────────────────

type GatewayAck = { ok: boolean; error?: string };
type SocketEmit = (
  event: string,
  payload?: unknown,
  ack?: (response: GatewayAck) => void,
) => void;

let capturedEmit = vi.fn<SocketEmit>();
let mockConnected = true;
let mockActive = true;
const capturedHandlers: Record<string, (...args: unknown[]) => void> = {};

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    capturedEmit.mockReset();
    return {
      get connected(): boolean { return mockConnected; },
      get active(): boolean { return mockActive; },
      emit: capturedEmit,
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        capturedHandlers[event] = handler;
      }),
    };
  }),
}));

// Import after mocks
import { sendHitlDecision, sendStopAll, initSocket, getGatewayUrl } from '../socketClient';

describe('sendHitlDecision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnected = true;
    // Ensure socket instance is created (initSocket is idempotent)
    initSocket();
    // Reset emit mock after initSocket (which may call emit on connect)
    capturedEmit.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits hitl:decision event with correct {taskId, decision} shape', () => {
    sendHitlDecision('task-abc-12345678', 'PUBLISH');
    expect(capturedEmit).toHaveBeenCalledWith(
      'hitl:decision',
      { taskId: 'task-abc-12345678', decision: 'PUBLISH' },
      expect.any(Function),
    );
  });

  it('logs HITL message before emitting', () => {
    sendHitlDecision('task-abc-12345678', 'REVISE');
    expect(mockAddLog).toHaveBeenCalledWith(
      'HITL',
      expect.stringContaining('REVISE'),
      false,
    );
  });

  it('logs error and does not emit when socket is disconnected', () => {
    mockConnected = false;
    sendHitlDecision('task-disconnected', 'PUBLISH');
    expect(capturedEmit).not.toHaveBeenCalled();
    expect(mockAddLog).toHaveBeenCalledWith(
      'ERROR',
      expect.stringContaining('not connected'),
      true,
    );
  });

  it('logs HITL confirmed when gateway ACK is {ok: true}', () => {
    sendHitlDecision('task-ack-ok-12345678', 'PUBLISH');
    const ackFn = capturedEmit.mock.calls[0]?.[2] as (r: { ok: boolean }) => void;
    ackFn?.({ ok: true });
    expect(mockAddLog).toHaveBeenCalledWith(
      'HITL',
      expect.stringContaining('confirmed'),
      true,
    );
  });

  it('logs ERROR when gateway ACK is {ok: false, error}', () => {
    sendHitlDecision('task-ack-err-12345678', 'REJECT');
    const ackFn = capturedEmit.mock.calls[0]?.[2] as (r: { ok: boolean; error?: string }) => void;
    ackFn?.({ ok: false, error: 'invalid decision value' });
    expect(mockAddLog).toHaveBeenCalledWith(
      'ERROR',
      expect.stringContaining('invalid decision value'),
      true,
    );
  });

  it('logs ERROR with "gateway error" fallback when ACK has no error field', () => {
    sendHitlDecision('task-no-err-field', 'PUBLISH');
    const ackFn = capturedEmit.mock.calls[0]?.[2] as (r: { ok: boolean }) => void;
    ackFn?.({ ok: false });
    expect(mockAddLog).toHaveBeenCalledWith(
      'ERROR',
      expect.stringContaining('gateway error'),
      true,
    );
  });

  it('logs timeout ERROR when ACK is not received within 8 seconds', async () => {
    vi.useFakeTimers();
    sendHitlDecision('task-timeout-12345678', 'REVISE');
    // ACK never arrives — advance past 8 second timeout
    await vi.advanceTimersByTimeAsync(8_100);
    expect(mockAddLog).toHaveBeenCalledWith(
      'ERROR',
      expect.stringContaining('not confirmed'),
      true,
    );
  });

  it('does not log timeout ERROR when ACK is received before timeout', async () => {
    vi.useFakeTimers();
    sendHitlDecision('task-no-timeout-12345678', 'PUBLISH');
    // ACK arrives immediately
    const ackFn = capturedEmit.mock.calls[0]?.[2] as (r: { ok: boolean }) => void;
    ackFn?.({ ok: true });
    // Advance past timeout — should not trigger additional error
    await vi.advanceTimersByTimeAsync(8_100);
    const errorLogs = (mockAddLog.mock.calls as unknown[][]).filter(c => c[0] === 'ERROR');
    expect(errorLogs).toHaveLength(0);
  });
});

describe('sendStopAll (emergency STOP ALL, ADR-025)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnected = true;
    initSocket();
    capturedEmit.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits control:stop-all with the reason and logs the confirmation', () => {
    sendStopAll('runaway');
    expect(capturedEmit).toHaveBeenCalledWith('control:stop-all', { reason: 'runaway' }, expect.any(Function));
    const ack = capturedEmit.mock.calls[0]![2] as (r: Record<string, unknown>) => void;
    ack({ ok: true, commandId: 'abcdef12-3456', issuedAt: 1, saved: true });
    expect(mockAddLog).toHaveBeenCalledWith('CONTROL', 'STOP ALL issued (command abcdef12)', true);
  });

  it('sends no reason when none is given', () => {
    sendStopAll();
    expect(capturedEmit).toHaveBeenCalledWith('control:stop-all', {}, expect.any(Function));
  });

  it('logs a refusal with the gateway error, or a generic one', () => {
    sendStopAll();
    const ack = capturedEmit.mock.calls[0]![2] as (r: Record<string, unknown>) => void;
    ack({ ok: false, error: 'Missing board token' });
    expect(mockAddLog).toHaveBeenCalledWith('ERROR', 'STOP ALL refused: Missing board token', true);
    sendStopAll();
    (capturedEmit.mock.calls[1]![2] as (r: unknown) => void)(undefined);
    expect(mockAddLog).toHaveBeenCalledWith('ERROR', 'STOP ALL refused: gateway error', true);
  });

  it('logs when the gateway does not confirm within 8 s', () => {
    vi.useFakeTimers();
    sendStopAll();
    vi.advanceTimersByTime(8_001);
    expect(mockAddLog).toHaveBeenCalledWith(
      'ERROR',
      'STOP ALL not confirmed by the gateway within 8s — check the gateway, or run npm run stop-all',
      true,
    );
  });

  it('a confirmed stop clears the timeout (no late error)', () => {
    vi.useFakeTimers();
    sendStopAll();
    (capturedEmit.mock.calls[0]![2] as (r: Record<string, unknown>) => void)({ ok: true, commandId: 'c', issuedAt: 1, saved: true });
    vi.advanceTimersByTime(8_001);
    expect(mockAddLog).not.toHaveBeenCalledWith('ERROR', expect.stringContaining('not confirmed'), true);
  });

  it('when disconnected, logs an error and emits nothing', () => {
    mockConnected = false;
    sendStopAll();
    expect(capturedEmit).not.toHaveBeenCalled();
    expect(mockAddLog).toHaveBeenCalledWith('ERROR', 'Cannot send STOP ALL — not connected to gateway (run npm run stop-all instead)', true);
  });
});

describe('STOP ALL failures reach the header alert (control error)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnected = true;
    initSocket();
    capturedEmit.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a refusal raises the alert', () => {
    sendStopAll();
    (capturedEmit.mock.calls[0]![2] as (r: unknown) => void)({ ok: false, error: 'Missing board token' });
    expect(mockSetControlError).toHaveBeenLastCalledWith('STOP ALL refused: Missing board token');
  });

  it('a timeout raises the alert, and a late confirmation clears it', () => {
    vi.useFakeTimers();
    sendStopAll();
    vi.advanceTimersByTime(8_001);
    expect(mockSetControlError).toHaveBeenLastCalledWith(expect.stringContaining('not confirmed by the gateway within 8s'));
    (capturedEmit.mock.calls[0]![2] as (r: unknown) => void)({ ok: true, commandId: 'abcdef12', issuedAt: 1 });
    expect(mockSetControlError).toHaveBeenLastCalledWith(null);
  });

  it('not connected raises the alert', () => {
    mockConnected = false;
    sendStopAll();
    expect(mockSetControlError).toHaveBeenLastCalledWith(expect.stringContaining('not connected to gateway'));
  });

  it('a new attempt clears the previous alert first', () => {
    sendStopAll();
    expect(mockSetControlError).toHaveBeenCalledWith(null);
  });
});

describe('connection lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActive = true;
    initSocket();
    capturedEmit.mockReset();
  });

  it('connect resets state and does not ask for a second snapshot', () => {
    capturedHandlers['connect']!();
    expect(mockSetConnectionStatus).toHaveBeenCalledWith('live');
    expect(mockResetState).toHaveBeenCalled();
    expect(capturedEmit).not.toHaveBeenCalled();
  });

  it('passes a state:update delta to the store', () => {
    capturedHandlers['state:update']!({ teamWorkflowStatus: 'RUNNING' });
    expect(mockApplyDelta).toHaveBeenCalledWith({ teamWorkflowStatus: 'RUNNING' });
  });

  it('a token refusal (socket.io will not retry) shows ERROR with the gateway message', () => {
    mockActive = false;
    capturedHandlers['connect_error']!(new Error('Invalid or expired board token'));
    expect(mockSetConnectionStatus).toHaveBeenCalledWith('error', 'Invalid or expired board token');
  });

  it('an unreachable gateway (socket.io retries) shows OFFLINE with the message', () => {
    capturedHandlers['connect_error']!(new Error('xhr poll error'));
    expect(mockSetConnectionStatus).toHaveBeenCalledWith('disconnected', 'xhr poll error');
  });

  it('a gateway-ended session says why', () => {
    capturedHandlers['disconnect']!('io server disconnect');
    expect(mockSetConnectionStatus).toHaveBeenCalledWith('disconnected', 'session ended by the gateway (token expired?)');
  });

  it('any other disconnect shows the socket.io reason', () => {
    capturedHandlers['disconnect']!('transport close');
    expect(mockSetConnectionStatus).toHaveBeenCalledWith('disconnected', 'transport close');
  });
});

describe('getGatewayUrl — a link must not choose where the board token goes', () => {
  const at = (query: string) => window.history.replaceState(null, '', `/${query}`);

  afterEach(() => {
    vi.unstubAllEnvs();
    at('');
  });

  it('defaults to localhost without configuration', () => {
    vi.stubEnv('VITE_GATEWAY_URL', undefined);
    vi.stubEnv('VITE_BOARD_TOKEN', undefined);
    expect(getGatewayUrl()).toBe('http://localhost:3000');
  });

  it('uses the build-time gateway', () => {
    vi.stubEnv('VITE_GATEWAY_URL', 'https://gw.example');
    expect(getGatewayUrl()).toBe('https://gw.example');
  });

  it('without a token, ?gateway= wins (local development)', () => {
    vi.stubEnv('VITE_GATEWAY_URL', 'https://gw.example');
    vi.stubEnv('VITE_BOARD_TOKEN', '');
    at('?gateway=http://localhost:4000');
    expect(getGatewayUrl()).toBe('http://localhost:4000');
  });

  it('with a token, a foreign ?gateway= is ignored', () => {
    vi.stubEnv('VITE_GATEWAY_URL', 'https://gw.example');
    vi.stubEnv('VITE_BOARD_TOKEN', 'secret');
    at('?gateway=https://attacker.example');
    expect(getGatewayUrl()).toBe('https://gw.example');
  });

  it('with a token, a ?gateway= that is not a URL is ignored', () => {
    vi.stubEnv('VITE_GATEWAY_URL', 'https://gw.example');
    vi.stubEnv('VITE_BOARD_TOKEN', 'secret');
    at('?gateway=not-a-url');
    expect(getGatewayUrl()).toBe('https://gw.example');
  });

  it('with a token, ?gateway= on the configured origin is honoured', () => {
    vi.stubEnv('VITE_GATEWAY_URL', 'https://gw.example');
    vi.stubEnv('VITE_BOARD_TOKEN', 'secret');
    at('?gateway=https://gw.example/other');
    expect(getGatewayUrl()).toBe('https://gw.example/other');
  });
});
