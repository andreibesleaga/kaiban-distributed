// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical channel names shared across messaging layer, state adapters, and gateway.
 * Import from here rather than hardcoding strings to ensure consistency.
 */
export const STATE_CHANNEL = "kaiban-state-events";
export const COMPLETED_CHANNEL = "kaiban-events-completed";
export const DLQ_CHANNEL = "kaiban-events-failed";

/** Prefix of an agent's task mailbox: `kaiban-agents-<agentId>`. */
export const AGENT_MAILBOX_PREFIX = "kaiban-agents-";

/** HITL decision channel: board → SocketGateway → Redis → orchestrator */
export const HITL_CHANNEL = "kaiban-hitl-decisions";

export const STATE_EVENT_UPDATE = "state:update";
export const STATE_EVENT_REQUEST = "state:request"; // client → server: request full snapshot replay
export const HITL_SOCKET_EVENT = "hitl:decision";
/** Board → gateway: emergency STOP ALL (ADR-025; only with CONTROL_PLANE_ENABLED). */
export const CONTROL_STOP_ALL_EVENT = "control:stop-all";

/**
 * Control channel (ADR-025): the emergency STOP ALL, gateway/CLI → every node.
 * Redis Pub/Sub regardless of MESSAGING_DRIVER, like the state and HITL channels.
 */
export const CONTROL_CHANNEL = "kaiban-control";
