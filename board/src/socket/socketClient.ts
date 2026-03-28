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

  socket = io(gatewayUrl, {
    transports: ['websocket', 'polling'],
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
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
 */
export function sendHitlDecision(taskId: string, decision: HitlDecision): void {
  if (!socket?.connected) {
    console.warn('[Board] Cannot send HITL decision: socket not connected');
    return;
  }
  socket.emit('hitl:decision', { taskId, decision });
  useBoardStore.getState().addLog('HITL', `Decision sent: ${decision} for task ${taskId.slice(-8)}`, true);
}
