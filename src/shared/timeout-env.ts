// SPDX-License-Identifier: Apache-2.0
import { createStructuredLogger } from "./structured-logger";

const log = createStructuredLogger({ component: "timeout-env" });

/** The longest delay Node's timers accept; anything above fires after 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Reads a timeout in milliseconds from the environment. Valid is a whole
 * number from 1 to `MAX_TIMER_MS` (so `5m`, `1e6`, `0`, `-1` and `3000000000`
 * are all rejected). An unset variable gives `undefined` silently; any other
 * invalid value gives `undefined` and a warning, so the caller's default applies.
 * The gateway and the worker both use this, so both roles read the same value.
 */
export function timeoutMsFromEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const text = raw.trim();
  const n = /^\d+$/.test(text) ? Number(text) : NaN;
  if (Number.isSafeInteger(n) && n >= 1 && n <= MAX_TIMER_MS) return n;
  log.warn(
    { name, value: raw },
    `${name} must be a whole number of milliseconds from 1 to ${MAX_TIMER_MS}; using the default`,
  );
  return undefined;
}

/**
 * A whole number of at least 1 from the environment, or `fallback` (unset gives
 * the fallback silently; any other invalid value also logs a warning).
 */
export function positiveIntFromEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (Number.isSafeInteger(n) && n >= 1) return n;
  log.warn(
    { name, value: raw, fallback },
    `${name} must be a whole number of at least 1; using the default`,
  );
  return fallback;
}
