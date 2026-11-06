// SPDX-License-Identifier: Apache-2.0
/**
 * Socket idle limits of the gateway's HTTP routes (SEC-02).
 *
 * Node destroys a socket that has been silent for the limit, whatever the
 * route is waiting for. Short routes keep a short limit (slow-read defence);
 * routes that wait on a task need one longer than the task.
 */

/** Short routes (`POST /control/stop-all`). */
export const SHORT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Routes that stay silent while a task runs or a human consents: blocking A2A
 * `message/send`, `message/stream`, the MCP stream. At least 15 minutes.
 */
export const DEFAULT_LONG_REQUEST_TIMEOUT_MS = 900_000;

/** Added to the longest task wait so the answer is never cut at the wait's own end. */
export const LONG_REQUEST_HEADROOM_MS = 60_000;

/** Largest delay a Node timer accepts (2^31 − 1 ms, about 24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;

/** The long limit for a gateway whose tasks may take up to `taskWaitMs`, within Node's timer range. */
export function longRequestTimeoutFor(taskWaitMs: number): number {
  return Math.min(
    MAX_TIMER_MS,
    Math.max(DEFAULT_LONG_REQUEST_TIMEOUT_MS, taskWaitMs + LONG_REQUEST_HEADROOM_MS),
  );
}
