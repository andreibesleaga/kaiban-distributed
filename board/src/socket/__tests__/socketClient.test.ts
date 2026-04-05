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

vi.mock('../../store/boardStore', () => ({
  useBoardStore: {
    getState: vi.fn(() => ({
      addLog: mockAddLog,
      resetState: mockResetState,
      setConnectionStatus: mockSetConnectionStatus,
      applyDelta: mockApplyDelta,
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
const capturedHandlers: Record<string, (...args: unknown[]) => void> = {};

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    capturedEmit.mockReset();
    return {
      get connected(): boolean { return mockConnected; },
      emit: capturedEmit,
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        capturedHandlers[event] = handler;
      }),
    };
  }),
}));

// Import after mocks
import { sendHitlDecision, initSocket } from '../socketClient';

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
