// SPDX-License-Identifier: Apache-2.0
/**
 * DLQ replay (master plan §B3 / Phase R, ADR-018).
 *
 * Re-dispatches **retries-exhausted** and per-agent budget-breach dead-letter records back onto their agent
 * mailbox so a transient failure (LLM 5xx, timeout, rate-limit) can be retried
 * after the cause clears — while **skipping non-retryable poison**.
 *
 * ## DLQ taxonomy (§B3)
 * The `AgentActor` publishes these kinds of failure to `kaiban-events-failed`:
 *   - **retries-exhausted** — the real handler error after 3× linear retry. The
 *     `error` is the underlying message (e.g. `"LLM 503 …"`). **Retryable.**
 *   - **firewall-block** — `error === "blocked_by_semantic_firewall"` (+`reason`).
 *     **Poison** — replaying would just be blocked again.
 *   - **breaker-open** — `error === "circuit_breaker_open"`. **Poison** —
 *     replaying punches through a tripped breaker.
 *   - **budget breach** — `error` is the `BudgetExceededError.reasonCode`. A
 *     workflow cap (`budget_exceeded`) or a per-task cap
 *     (`task_token_budget_exceeded`) is **poison**: the run or the task itself
 *     used up its budget, so a replay would pay for it again past that cap. A
 *     per-agent cap (`token_budget_exceeded`) is **retryable**: it belongs to
 *     the worker process (an in-memory tally that resets on restart), not to
 *     the task, so the task can run once that worker has restarted or another
 *     worker of the agent takes it (replayed earlier, the pre-flight check
 *     refuses it again without a paid call). If the breach happened after a
 *     successful paid call (the result was discarded at the cap), a replay pays
 *     for the task again — the operator decides whether to replay those.
 *
 * Replay is a **manual / operator** action (not automatic): you read records off
 * the DLQ (out of band), hand them to `replayDlq`, and it republishes only the
 * retryable ones. It NEVER touches the state/HITL Redis channels (I5) and never
 * writes `teamWorkflowStatus` (I4).
 */

import type {
  IMessagingDriver,
  MessagePayload,
} from "../infrastructure/messaging/interfaces";
import { createLogger } from "../shared/logger";

const log = createLogger("DlqReplay");

/**
 * The `error` values the `AgentActor` writes for non-retryable poison. Replaying
 * any of these is futile (the same guard rejects it again), so they are skipped.
 */
export const DLQ_POISON_REASONS: ReadonlySet<string> = new Set([
  "blocked_by_semantic_firewall",
  "circuit_breaker_open",
  // Budget breaches of the run or the task itself
  // (`BudgetExceededError.reasonCode`): a replay would pay for the task again
  // past the cap it already reached. The per-agent breach
  // (`token_budget_exceeded`) is NOT here — it is a property of the worker
  // process, whose in-memory tally resets on restart, so it can be replayed.
  "budget_exceeded",
  "task_token_budget_exceeded",
]);

/** Envelope fields added by the actor's DLQ publish; stripped before replay. */
const FAILURE_ENVELOPE_FIELDS = ["status", "error", "reason", "_truncated", "_inputs_omitted"];

/** Skip reason for a record that has no task inputs to replay (omitted as too large, or written before 2.0.1). */
export const DLQ_INPUTS_MISSING = "inputs_missing";

/** A single dead-letter record read off `kaiban-events-failed`. */
export interface DlqRecord {
  /** The DLQ message payload (`data` holds `status`/`error`/`reason` + originals). */
  payload: MessagePayload;
}

export interface DlqReplayDeps {
  /** Driver used to republish retryable records onto agent mailboxes. */
  driver: IMessagingDriver;
  /** The dead-letter records to consider for replay. */
  records: DlqRecord[];
  /**
   * Override the poison-reason set (e.g. to add `"policy_blocked"` once the
   * governance gate lands). Defaults to {@link DLQ_POISON_REASONS}.
   */
  poisonReasons?: ReadonlySet<string>;
  /** Resolve the mailbox queue name for an agent. Defaults to `kaiban-agents-<id>`. */
  queueFor?: (agentId: string) => string;
}

export interface DlqReplayResult {
  /** Count of records republished for retry. */
  replayed: number;
  /** Count of poison records skipped. */
  skipped: number;
  /** The taskId + reason of each skipped poison record. */
  skippedReasons: Array<{ taskId: string; reason: string }>;
}

function defaultQueueFor(agentId: string): string {
  return `kaiban-agents-${agentId}`;
}

/** Strip the failure-envelope fields, leaving the original task data to retry. */
function restoreOriginalData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!FAILURE_ENVELOPE_FIELDS.includes(key)) out[key] = value;
  }
  return out;
}

/**
 * Replay retryable DLQ records; skip non-retryable poison.
 *
 * @returns counts of replayed vs skipped, plus the skip reasons.
 */
export async function replayDlq(deps: DlqReplayDeps): Promise<DlqReplayResult> {
  const poison = deps.poisonReasons ?? DLQ_POISON_REASONS;
  const queueFor = deps.queueFor ?? defaultQueueFor;
  const result: DlqReplayResult = {
    replayed: 0,
    skipped: 0,
    skippedReasons: [],
  };

  for (const record of deps.records) {
    const { payload } = record;
    const errorReason = String(payload.data["error"] ?? "");

    if (poison.has(errorReason)) {
      result.skipped += 1;
      result.skippedReasons.push({ taskId: payload.taskId, reason: errorReason });
      log.warn(
        `Skipping poison DLQ record ${payload.taskId.slice(-8)} (${errorReason})`,
      );
      continue;
    }

    const original = restoreOriginalData(payload.data);
    if (payload.data["_inputs_omitted"] === true || Object.keys(original).length === 0) {
      // Republishing an empty task would run a generic one and pay for it.
      result.skipped += 1;
      result.skippedReasons.push({ taskId: payload.taskId, reason: DLQ_INPUTS_MISSING });
      log.warn(`Skipping DLQ record ${payload.taskId.slice(-8)}: no task inputs to replay`);
      continue;
    }

    await deps.driver.publish(queueFor(payload.agentId), {
      taskId: payload.taskId,
      agentId: payload.agentId,
      timestamp: Date.now(),
      data: original,
      ...(payload.traceHeaders ? { traceHeaders: payload.traceHeaders } : {}),
    });
    result.replayed += 1;
    log.info(`Replayed DLQ record ${payload.taskId.slice(-8)} → ${payload.agentId}`);
  }

  return result;
}
