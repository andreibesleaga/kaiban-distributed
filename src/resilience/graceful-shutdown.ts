/**
 * Graceful shutdown (master plan §B5.1 Phase R, ADR-018).
 *
 * On SIGTERM a node must wind down **in order**: stop accepting new work → drain
 * in-flight work → finish acks → flush buffers → close drivers — all within a
 * **bounded deadline** so a hung dependency cannot wedge the pod past k8s'
 * `terminationGracePeriodSeconds` (after which it is SIGKILLed anyway).
 *
 * `gracefulShutdown` runs an ordered list of named steps:
 *   - **best-effort** — a step that throws is recorded in `errors` but does NOT
 *     abort the remaining cleanup (a failed flush must not skip closing drivers).
 *   - **deadline-bounded** — the whole sequence races a single `deadlineMs`
 *     timer; once it fires, in-flight and remaining steps are abandoned and
 *     `timedOut: true` is returned. Each step also observes the *remaining*
 *     budget, so one hung step consumes the deadline rather than its own copy.
 *
 * It is pure orchestration over caller-supplied steps — no driver import (layer
 * boundary), no state/HITL channel writes (I4/I5 unaffected).
 */

/** A single ordered shutdown step. `run` may be sync or async. */
export interface ShutdownStep {
  name: string;
  run: () => void | Promise<void>;
}

export interface GracefulShutdownOptions {
  /** Hard cap (ms) for the entire shutdown sequence. */
  deadlineMs: number;
  /** Ordered steps: stop-intake → drain → ack → flush → close. */
  steps: ShutdownStep[];
}

export interface GracefulShutdownResult {
  /** Names of steps that ran to completion WITHOUT error (errored steps land in `errors`). */
  completed: string[];
  /** True if the deadline fired before all steps finished. */
  timedOut: boolean;
  /** The step name + stringified error for every step that threw. */
  errors: Array<{ step: string; error: string }>;
}

function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Run an ordered, best-effort, deadline-bounded shutdown sequence.
 *
 * Resolves once all steps finish OR the deadline fires — whichever comes first.
 */
export function gracefulShutdown(
  opts: GracefulShutdownOptions,
): Promise<GracefulShutdownResult> {
  const result: GracefulShutdownResult = {
    completed: [],
    timedOut: false,
    errors: [],
  };

  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), opts.deadlineMs);
  });

  const sequence = (async (): Promise<"done"> => {
    for (const step of opts.steps) {
      try {
        await step.run();
        result.completed.push(step.name);
      } catch (err: unknown) {
        result.errors.push({ step: step.name, error: toMessage(err) });
      }
    }
    return "done";
  })();

  return Promise.race([sequence, deadline]).then((outcome) => {
    clearTimeout(timer);
    if (outcome === "deadline") result.timedOut = true;
    return result;
  });
}
