/**
 * Canonical channel names shared across messaging layer, state adapters, and gateway.
 * Import from here rather than hardcoding strings to ensure consistency.
 */
export const STATE_CHANNEL     = 'kaiban-state-events';
export const COMPLETED_CHANNEL = 'kaiban-events-completed';
export const DLQ_CHANNEL       = 'kaiban-events-failed';

/** HITL decision channel: board → SocketGateway → Redis → orchestrator */
export const HITL_CHANNEL      = 'kaiban-hitl-decisions';

export const STATE_EVENT_UPDATE  = 'state:update';
export const STATE_EVENT_REQUEST = 'state:request';  // client → server: request full snapshot replay
export const HITL_SOCKET_EVENT   = 'hitl:decision';
