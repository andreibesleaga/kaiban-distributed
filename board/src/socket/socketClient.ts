// SPDX-License-Identifier: GPL-3.0-only
import { io, type Socket } from 'socket.io-client';
import { useBoardStore } from '../store/boardStore';
import type { HitlDecision, StateDelta } from '../types/board';

const DEFAULT_GATEWAY_URL = 'http://localhost:3000';

/** The gateway chosen at build time (VITE_GATEWAY_URL), or the local default. */
function configuredGatewayUrl(): string {
  return (import.meta.env['VITE_GATEWAY_URL'] as string | undefined) ?? DEFAULT_GATEWAY_URL;
}

/** The board token baked in at build time (VITE_BOARD_TOKEN); '' when none. */
function configuredBoardToken(): string {
  return (import.meta.env['VITE_BOARD_TOKEN'] as string | undefined) ?? '';
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false; // not a URL: never trust it with a token
  }
}

/**
 * Resolve the gateway URL: query param → env var → localhost fallback.
 *
 * The board token goes to whatever gateway this returns, so a link must not be able to pick
 * a foreign one: when a token is configured, `?gateway=` is honoured only for the configured
 * gateway's own origin (anything else falls back to the configured gateway).
 */
function resolveGatewayUrl(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('gateway');
  const configured = configuredGatewayUrl();
  if (!fromQuery) return configured;
  if (!configuredBoardToken()) return fromQuery;
  return sameOrigin(fromQuery, configured) ? fromQuery : configured;
}

let socket: Socket | null = null;

export function getGatewayUrl(): string {
  return resolveGatewayUrl();
}

/**
 * Initialise the Socket.io connection.  Call once on app mount.
 * Wires 'state:update' events directly into the Zustand board store.
 *
 * On every (re)connect the board clears its state and the gateway sends its
 * accumulated snapshot unasked (SocketGateway, on connection) — the board never
 * shows stale state after a disconnect.
 */
export function initSocket(): void {
  if (socket) return; // already initialised

  const gatewayUrl = resolveGatewayUrl();
  const store = useBoardStore.getState();

  // Pass board viewer token if configured (required when BOARD_JWT_SECRET is set on the gateway).
  // Set VITE_BOARD_TOKEN in board/.env to authenticate. When unset, connects without auth.
  const boardToken = configuredBoardToken();

  socket = io(gatewayUrl, {
    transports: ['websocket', 'polling'],
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    ...(boardToken ? { auth: { token: boardToken } } : {}),
  });

  socket.on('connect', () => {
    store.setConnectionStatus('live');
    // Clear stale state from any previous run before the gateway snapshot arrives
    store.resetState();
    // No 'state:request' here: the gateway already sends the snapshot on connection,
    // and asking again would apply (and log) it twice.
  });

  // 'io server disconnect' means the gateway ended the session (for example the board token
  // expired); socket.io does not reconnect after it, so say why instead of a bare OFFLINE.
  socket.on('disconnect', (reason: string) => {
    store.setConnectionStatus(
      'disconnected',
      reason === 'io server disconnect' ? 'session ended by the gateway (token expired?)' : reason,
    );
  });

  // connect_error: the gateway is unreachable (socket.active stays true, socket.io keeps
  // retrying), or its middleware refused the board token ("Missing board token", "Invalid or
  // expired board token"), after which socket.io gives up (socket.active is false) and the
  // board shows ERROR. The message carries no secret; show it either way.
  socket.on('connect_error', (err: Error) => {
    store.setConnectionStatus(socket?.active === false ? 'error' : 'disconnected', err.message);
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

/** A STOP ALL failure must be seen, not buried in the log: log it and raise the header alert. */
function reportControlError(message: string): void {
  const store = useBoardStore.getState();
  store.addLog('ERROR', message, true);
  store.setControlError(message);
}

/**
 * Emergency STOP ALL (ADR-025): ask the gateway to kill every running model
 * call, task and workflow. The gateway needs a board token (VITE_BOARD_TOKEN)
 * and CONTROL_PLANE_ENABLED; a failure is shown in an alert beside the button and in the event log.
 */
export function sendStopAll(reason?: string): void {
  const store = useBoardStore.getState();
  store.setControlError(null);

  if (!socket?.connected) {
    reportControlError('Cannot send STOP ALL — not connected to gateway (run npm run stop-all instead)');
    return;
  }

  store.addLog('CONTROL', 'Sending STOP ALL…', true);
  const ACK_TIMEOUT_MS = 8_000;
  let ackReceived = false;
  const timer = setTimeout(() => {
    if (!ackReceived) {
      reportControlError(
        `STOP ALL not confirmed by the gateway within ${ACK_TIMEOUT_MS / 1000}s — check the gateway, or run npm run stop-all`,
      );
    }
  }, ACK_TIMEOUT_MS);

  socket.emit(
    'control:stop-all',
    reason ? { reason } : {},
    (response?: { ok: boolean; error?: string; commandId?: string }) => {
      ackReceived = true;
      clearTimeout(timer);
      if (response?.ok) {
        useBoardStore.getState().setControlError(null); // a late confirmation replaces the timeout alert
        useBoardStore.getState().addLog('CONTROL', `STOP ALL issued (command ${String(response.commandId).slice(0, 8)})`, true);
      } else {
        reportControlError(`STOP ALL refused: ${response?.error ?? 'gateway error'}`);
      }
    },
  );
}
