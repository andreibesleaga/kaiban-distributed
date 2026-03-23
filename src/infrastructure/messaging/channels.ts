/**
 * Canonical channel names shared across messaging layer, state adapters, and gateway.
 * Import from here rather than hardcoding strings to ensure consistency.
 */
export const STATE_CHANNEL     = 'kaiban-state-events';
export const COMPLETED_CHANNEL = 'kaiban-events-completed';
export const DLQ_CHANNEL       = 'kaiban-events-failed';

export const STATE_EVENT_UPDATE = 'state:update';
