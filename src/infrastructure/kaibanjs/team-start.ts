// SPDX-License-Identifier: Apache-2.0
import type { Team } from "kaibanjs";

/**
 * Run `team.start()` and, when the actor's signal aborts, stop the team and
 * settle with the abort reason (the actor's non-retryable ControlAbortError or
 * EmergencyStopError).
 *
 * KaibanJS 0.24.2: `team.start()` never settles after `team.stop()`, so the
 * start promise is raced against the abort. `stop()` is async and rejects when
 * the workflow is not RUNNING/PAUSED, so its failure is swallowed. The team
 * stops at the agent loop's next iteration boundary. No signal → plain start.
 */
export async function startTeam(
  team: Team,
  inputs: Record<string, unknown>,
  signal?: AbortSignal,
): ReturnType<Team["start"]> {
  if (!signal) return team.start(inputs);
  signal.throwIfAborted();

  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = (): void => {
      void Promise.resolve(team.stop()).catch(() => {});
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const started = team.start(inputs);
  // The losing side may still reject later; it must not become unhandled.
  started.catch(() => {});
  try {
    return await Promise.race([started, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
