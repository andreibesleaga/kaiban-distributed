// SPDX-License-Identifier: Apache-2.0
import { createStructuredLogger } from "./structured-logger";
import { positiveIntFromEnv } from "./timeout-env";

const log = createStructuredLogger({ component: "hitl-retention" });

/** How long the gateway keeps a human decision in its Redis list when the variable is unset. */
export const DEFAULT_HITL_DECISION_TTL_SECONDS = 300;

/** Upper bound for `HITL_DECISION_TTL_SECONDS`: seven days. */
export const MAX_HITL_DECISION_TTL_SECONDS = 604_800;

/**
 * Retention of a human decision in the per-task Redis list, in seconds, from
 * `HITL_DECISION_TTL_SECONDS`. The gateway uses it as the key expiry and the
 * orchestrator as the freshness window for a signed list entry, so both
 * roles must read the same value. Unset gives 300. An invalid value (not a whole
 * number of at least 1) or one above seven days gives 300 and a warning.
 */
export function hitlDecisionTtlSeconds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const name = "HITL_DECISION_TTL_SECONDS";
  const n = positiveIntFromEnv(name, DEFAULT_HITL_DECISION_TTL_SECONDS, env);
  if (n <= MAX_HITL_DECISION_TTL_SECONDS) return n;
  log.warn(
    { name, value: env[name] },
    `${name} must be a whole number from 1 to ${MAX_HITL_DECISION_TTL_SECONDS} seconds; using the default`,
  );
  return DEFAULT_HITL_DECISION_TTL_SECONDS;
}
