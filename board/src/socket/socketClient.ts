import { io, type Socket } from 'socket.io-client';
import { useBoardStore } from '../store/boardStore';
import type { HitlDecision, StateDelta } from '../types/board';

/** Resolve the gateway URL: query param → env var → localhost fallback */
function resolveGatewayUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('gateway');
  if (fromQuery) return fromQuery;
  const fromEnv = import.meta.env['VITE_GATEWAY_URL'] as string | undefined;
  return fromEnv ?? 'http://localhost:3000';
}

let socket: Socket | null = null;

export function getGatewayUrl(): string {
  return resolveGatewayUrl();
}

/**
 * Initialise the Socket.io connection.  Call once on app mount.
 * Wires 'state:update' events directly into the Zustand board store.
 *
 * On every (re)connect the client emits 'state:request' so the gateway
 * replays its accumulated snapshot — the board never shows stale state
 * after a disconnect.
 */
export function initSocket(): void {
  if (socket) return; // already initialised

  const gatewayUrl = resolveGatewayUrl();
  const store = useBoardStore.getState();

  // Pass board viewer token if configured (required when BOARD_JWT_SECRET is set on the gateway).
  // Set VITE_BOARD_TOKEN in board/.env to authenticate. When unset, connects without auth.
  const boardToken = (import.meta.env['VITE_BOARD_TOKEN'] as string | undefined) ?? '';

  socket = io(gatewayUrl, {
    transports: ['websocket', 'polling'],
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    ...(boardToken ? { auth: { token: boardToken } } : {}),
  });

  socket.on('connect', () => {
    store.setConnectionStatus('live');
    // Request current state snapshot so reconnecting boards aren't stale
    socket!.emit('state:request'); // matches STATE_EVENT_REQUEST = 'state:request'
  });

  socket.on('disconnect', () => {
    store.setConnectionStatus('disconnected');
  });

  // connect_error fires when a connection attempt fails (server unreachable, etc.)
  // It is NOT an application-level error — show as disconnected, not ERROR.
  socket.on('connect_error', () => {
    store.setConnectionStatus('disconnected');
  });

  socket.on('state:update', (delta: StateDelta) => {
    useBoardStore.getState().applyDelta(delta);
  });
}

/**
 * Emit a HITL decision from the board to the gateway.
 * The gateway publishes it to Redis; the orchestrator receives it and continues.
 *
 * Uses Socket.io acknowledgements so the board gets definitive confirmation that
 * the gateway received the event AND successfully published it to Redis.
 * If the socket is disconnected, a visible error is logged to the event panel.
 */
export function sendHitlDecision(taskId: string, decision: HitlDecision): void {
  const store = useBoardStore.getState();

  if (!socket?.connected) {
    store.addLog('ERROR', `Cannot send decision — not connected to gateway (${decision})`, true);
    return;
  }

  store.addLog('HITL', `Sending decision: ${decision} for task ${taskId.slice(-8)}…`, false);

  // Emit with ACK: gateway responds { ok: true } once it confirms Redis publish.
  // 8-second timeout guards against a gateway that never calls the ack.
  const ACK_TIMEOUT_MS = 8_000;
  let ackReceived = false;

  const timer = setTimeout(() => {
    if (!ackReceived) {
      useBoardStore.getState().addLog('ERROR', `Decision not confirmed by gateway within ${ACK_TIMEOUT_MS / 1000}s — try again`, true);
    }
  }, ACK_TIMEOUT_MS);

  socket.emit('hitl:decision', { taskId, decision }, (response: { ok: boolean; error?: string }) => {
    ackReceived = true;
    clearTimeout(timer);
    if (response?.ok) {
      useBoardStore.getState().addLog('HITL', `Decision confirmed: ${decision} for task ${taskId.slice(-8)}`, true);
    } else {
      const reason = response?.error ?? 'gateway error';
      useBoardStore.getState().addLog('ERROR', `Decision rejected by gateway: ${reason}`, true);
    }
  });
}
