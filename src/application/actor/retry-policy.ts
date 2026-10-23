/** Attempts per task (the first try plus retries). */
export const RETRY_ATTEMPTS = 3;
/** Linear back-off: the wait after attempt n is `RETRY_BASE_DELAY_MS * n`. */
export const RETRY_BASE_DELAY_MS = 100;

/**
 * Added to a retrying caller's wait so the worker's own final `task_timeout`
 * result (dead-letter record, failed completion) arrives before the caller
 * gives up with a generic timeout.
 */
export const TASK_WAIT_MARGIN_MS = 5_000;

/**
 * The longest a caller must wait for a task whose single attempt may take
 * `attemptTimeoutMs`. One attempt unless `retryOnTimeout` is on (unchanged
 * from 2.0.1); then every attempt can time out, so it is all attempts plus the
 * back-off between them plus `TASK_WAIT_MARGIN_MS`.
 */
export function taskWaitMs(
  attemptTimeoutMs: number,
  retryOnTimeout: boolean,
): number {
  if (!retryOnTimeout) return attemptTimeoutMs;
  let total = attemptTimeoutMs * RETRY_ATTEMPTS + TASK_WAIT_MARGIN_MS;
  for (let attempt = 1; attempt < RETRY_ATTEMPTS; attempt++) {
    total += RETRY_BASE_DELAY_MS * attempt;
  }
  return total;
}
