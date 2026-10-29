// SPDX-License-Identifier: Apache-2.0
import { createHash } from "crypto";
import {
  IMessagingDriver,
  MessagePayload,
} from "../../infrastructure/messaging/interfaces";
import {
  COMPLETED_CHANNEL,
  DLQ_CHANNEL,
} from "../../infrastructure/messaging/channels";
import type { ISemanticFirewall } from "../../domain/security/semantic-firewall";
import type { ICircuitBreaker } from "../../domain/security/circuit-breaker";
import type { IAdmissionGate } from "../../domain/security/admission-gate";
import { NonRetryableError } from "../../domain/errors/DomainError";
import {
  recordAnomalyEvent,
  recordMessageProcessed,
  recordMessageLatency,
} from "../../infrastructure/telemetry/telemetry";
import { RETRY_ATTEMPTS, RETRY_BASE_DELAY_MS } from "./retry-policy";
import { createStructuredLogger } from "../../shared/structured-logger";

const log = createStructuredLogger({ component: "AgentActor" });

/**
 * Task handler contract.
 *
 * The `signal` is aborted by the actor on timeout, shutdown, or explicit
 * cancellation (master plan §B8 Phase 1.2 / ADR-014). Handlers MUST thread it
 * into any long-running work (e.g. the LLM `.invoke(input, { signal })` call)
 * so a timed-out task stops burning tokens instead of running to completion.
 */
export type TaskHandler = (
  payload: MessagePayload,
  signal?: AbortSignal,
) => Promise<unknown>;

// 64 KB — cap outbound message data. The invariant is BYTES (the message is
// JSON-serialized and transmitted as UTF-8), so all checks/truncation use
// Buffer.byteLength(...,"utf8"), mirroring a2a-input-validation.ts.
const MAX_PUBLISH_DATA_LEN = 65_536;

function sanitizeId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 8);
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes WITHOUT splitting a
 * multi-byte character. We over-trim by UTF-16 code units (each is ≤ the byte
 * cost) then shrink one code unit at a time until the byte budget is met — so
 * the result never ends mid-codepoint (which would corrupt the JSON payload).
 */
function truncateToBytes(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return str;
  // Back up past UTF-8 continuation bytes (10xxxxxx = 0x80–0xBF) so a multi-byte
  // codepoint is never split. O(n) (one encode + a ≤3-byte backup), not O(n²).
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.toString("utf8", 0, end);
}

/**
 * Cap outbound message data to MAX_PUBLISH_DATA_LEN BYTES. When the serialized
 * payload is over budget, the `result` string is byte-truncated (multi-byte
 * safe) and `_truncated` is flagged.
 */
function capDataSize(data: Record<string, unknown>): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(data), "utf8") <= MAX_PUBLISH_DATA_LEN) {
    return data;
  }
  return {
    ...data,
    result: truncateToBytes(String(data["result"] ?? ""), MAX_PUBLISH_DATA_LEN),
    _truncated: true,
  };
}

/** Default per-task execution timeout: 5 minutes */
const DEFAULT_TASK_TIMEOUT_MS = 300_000;

/**
 * A task cut short by the runtime: it timed out (`task_timeout`) or the actor is
 * stopping (`actor_stopped`). Never retried — a retry would pay the provider again
 * for work nobody will read. Both codes stay replayable from the DLQ.
 */
class ControlAbortError extends NonRetryableError {
  readonly code = "CONTROL_ABORT";

  constructor(
    public readonly reasonCode: "task_timeout" | "actor_stopped",
    message: string,
  ) {
    super(message);
  }
}

const stoppedError = (): ControlAbortError =>
  new ControlAbortError("actor_stopped", "Actor stopping");

export interface AgentActorDeps {
  firewall?: ISemanticFirewall;
  circuitBreaker?: ICircuitBreaker;
  /**
   * Optional pre-execution admission gate (Phase G, ADR-021). Consulted after the
   * circuit breaker + firewall; a blocked verdict routes the task to the DLQ
   * without executing. Unset ⇒ no governance/economics gating (default behavior).
   */
  admissionGate?: IAdmissionGate;
  /** Max ms a single task handler may run before being timed out (default: 300_000) */
  taskTimeoutMs?: number;
  /**
   * Retry a task that timed out through the normal retry path (3 attempts in
   * all, linear back-off). Default `false`: a timeout is final, so a hung
   * provider call is paid for once. When on, a hung call can be paid for up to
   * three times; a stop is still never retried, and the last timeout still
   * dead-letters as `task_timeout`.
   */
  retryOnTimeout?: boolean;
}

export class AgentActor {
  private id: string;
  private driver: IMessagingDriver;
  private queueName: string;
  private taskHandler?: TaskHandler;
  private firewall?: ISemanticFirewall;
  private circuitBreaker?: ICircuitBreaker;
  private admissionGate?: IAdmissionGate;
  private taskTimeoutMs: number;
  private retryOnTimeout: boolean;
  /** In-flight task abort controllers, so stop() can cancel running work. */
  private readonly inFlight = new Set<AbortController>();
  /** Set by stop(): no attempt starts or is retried after it. */
  private stopping = false;

  constructor(
    id: string,
    driver: IMessagingDriver,
    queueName: string,
    taskHandler?: TaskHandler,
    deps?: AgentActorDeps,
  ) {
    this.id = id;
    this.driver = driver;
    this.queueName = queueName;
    this.taskHandler = taskHandler;
    this.firewall = deps?.firewall;
    this.circuitBreaker = deps?.circuitBreaker;
    this.admissionGate = deps?.admissionGate;
    this.taskTimeoutMs = deps?.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    this.retryOnTimeout = deps?.retryOnTimeout === true;
  }

  public async start(): Promise<void> {
    if (!this.taskHandler) {
      // Finding #1 fix: a handler-less actor used to subscribe and silently
      // discard every task it won (delay(50); return null), competing with real
      // worker nodes. Fail loudly instead of subscribing — the gateway role must
      // never consume task channels; only the worker role wires a real handler.
      throw new Error(
        `AgentActor ${sanitizeId(this.id)} cannot start without a task handler ` +
          `(handler-less actors silently discard tasks — see ADR-013)`,
      );
    }
    log.info(
      { agentId: sanitizeId(this.id), queue: this.queueName },
      "Actor starting",
    );
    await this.driver.subscribe(this.queueName, this.processTask.bind(this));
  }

  private async processTask(payload: MessagePayload): Promise<void> {
    if (payload.agentId !== this.id && payload.agentId !== "*") {
      log.debug(
        { agentId: sanitizeId(this.id), target: payload.agentId },
        "Ignored task for a different agent",
      );
      return;
    }

    if (this.stopping) {
      // Delivered while the actor drains: not run, kept replayable in the DLQ.
      await this.publishToDlq(payload, "actor_stopped", "Actor stopping");
      return;
    }

    if (await this.isBlockedByGuards(payload)) return;

    await this.executeWithRetries(payload);
  }

  /**
   * Ordered pre-execution guards (each routes a blocked task to the DLQ and
   * returns true): circuit breaker → semantic firewall → admission gate
   * (governance/economics, Phase G). Short-circuits on the first block. Absent
   * guards add no `await` (so a guard-less actor keeps its original timing).
   */
  private async isBlockedByGuards(payload: MessagePayload): Promise<boolean> {
    if (this.circuitBreaker?.isOpen()) {
      await this.blockByBreaker(payload);
      return true;
    }
    if (this.firewall && (await this.evaluateFirewall(this.firewall, payload))) {
      return true;
    }
    if (
      this.admissionGate &&
      (await this.evaluateAdmissionGate(this.admissionGate, payload))
    ) {
      return true;
    }
    return false;
  }

  private async blockByBreaker(payload: MessagePayload): Promise<void> {
    log.warn(
      { agentId: sanitizeId(this.id), taskId: payload.taskId },
      "Circuit breaker OPEN — rejecting task",
    );
    recordAnomalyEvent("circuit_breaker.rejected", {
      agentId: sanitizeId(this.id),
      taskId: payload.taskId,
    });
    await this.publishToDlq(payload, "circuit_breaker_open");
  }

  private async evaluateFirewall(
    firewall: ISemanticFirewall,
    payload: MessagePayload,
  ): Promise<boolean> {
    const verdict = await firewall.evaluate(payload);
    if (verdict.allowed) return false;
    log.warn(
      { agentId: sanitizeId(this.id), reason: verdict.reason ?? "unknown" },
      "Blocked by semantic firewall",
    );
    recordAnomalyEvent("firewall.blocked", {
      agentId: sanitizeId(this.id),
      reason: verdict.reason ?? "unknown",
    });
    await this.publishToDlq(
      payload,
      "blocked_by_semantic_firewall",
      verdict.reason,
    );
    return true;
  }

  private async evaluateAdmissionGate(
    gate: IAdmissionGate,
    payload: MessagePayload,
  ): Promise<boolean> {
    const verdict = await gate.evaluate(payload);
    if (verdict.allowed) return false;
    log.warn(
      { agentId: sanitizeId(this.id), reason: verdict.reason ?? "unknown" },
      "Blocked by admission gate",
    );
    recordAnomalyEvent("admission_gate.blocked", {
      agentId: sanitizeId(this.id),
      reason: verdict.reason ?? "unknown",
    });
    await this.publishToDlq(
      payload,
      "blocked_by_admission_gate",
      verdict.reason,
    );
    return true;
  }

  private async executeWithRetries(payload: MessagePayload): Promise<void> {
    const start = Date.now();
    let lastError = "Max retries exceeded";
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        const taskResult = await this.executeTask(payload);
        this.circuitBreaker?.recordSuccess();
        await this.driver.publish(COMPLETED_CHANNEL, {
          taskId: payload.taskId,
          agentId: this.id,
          timestamp: Date.now(),
          data: capDataSize({
            status: "success",
            result:
              taskResult ??
              `Actor ${sanitizeId(this.id)} executed successfully`,
          }),
        });
        recordMessageProcessed("completed");
        recordMessageLatency(Date.now() - start, "completed");
        return;
      } catch (err) {
        const final = this.finalError(err, attempt);
        if (final) {
          await this.failNonRetryable(payload, final, start);
          return;
        }
        lastError = err instanceof Error ? err.message : String(err);
        log.error(
          { agentId: sanitizeId(this.id), attempt, err: lastError },
          "Task attempt failed",
        );
        if (attempt < RETRY_ATTEMPTS) {
          await delay(RETRY_BASE_DELAY_MS * attempt);
          if (this.stopping) {
            // stop() arrived during the back-off: the next attempt never starts.
            await this.failNonRetryable(payload, stoppedError(), start);
            return;
          }
        }
      }
    }

    this.circuitBreaker?.recordFailure();
    recordMessageLatency(Date.now() - start, "failed");
    await this.publishToDlq(payload, lastError);
  }

  /**
   * A `NonRetryableError` (e.g. `BudgetExceededError`) ends the task on the
   * attempt that raised it: no further attempt, no breaker failure (it is not a
   * downstream fault), one DLQ record whose `error` is the stable `reasonCode`
   * (so `replayDlq` treats it as poison) and whose `reason` is the message.
   */
  private async failNonRetryable(
    payload: MessagePayload,
    err: NonRetryableError,
    start: number,
  ): Promise<void> {
    log.warn(
      {
        agentId: sanitizeId(this.id),
        taskId: payload.taskId,
        reasonCode: err.reasonCode,
        err: err.message,
      },
      "Task failed with a non-retryable error — not retrying",
    );
    recordAnomalyEvent("task.non_retryable", {
      agentId: sanitizeId(this.id),
      taskId: payload.taskId,
      reason: err.reasonCode,
    });
    // A timeout is a downstream fault (the provider did not answer in time).
    if (err.reasonCode === "task_timeout") this.circuitBreaker?.recordFailure();
    recordMessageLatency(Date.now() - start, "failed");
    await this.publishToDlq(payload, err.reasonCode, err.message);
  }

  /**
   * The error that ends the task on this attempt, or null when another attempt
   * may run. With `retryOnTimeout`, a timeout before the last attempt is not final.
   */
  private finalError(err: unknown, attempt: number): NonRetryableError | null {
    const final = this.nonRetryable(err);
    const retriesTimeout =
      this.retryOnTimeout &&
      !this.stopping &&
      attempt < RETRY_ATTEMPTS &&
      final instanceof ControlAbortError &&
      final.reasonCode === "task_timeout";
    return retriesTimeout ? null : final;
  }

  /** The error as a non-retryable one, or null when another attempt may run. */
  private nonRetryable(err: unknown): NonRetryableError | null {
    if (err instanceof NonRetryableError) return err;
    // Whatever the handler threw after stop() aborted it, the actor is draining.
    return this.stopping ? stoppedError() : null;
  }

  private async publishToDlq(
    payload: MessagePayload,
    error: string,
    reason?: string,
  ): Promise<void> {
    recordMessageProcessed("failed");
    // Byte-cap each free-text field so a giant error/reason cannot blow the 64 KB
    // outbound invariant (multi-byte safe). capDataSize is the outer guard.
    const failure: Record<string, unknown> = {
      status: "failed",
      error: truncateToBytes(error, MAX_PUBLISH_DATA_LEN),
      ...(reason
        ? { reason: truncateToBytes(reason, MAX_PUBLISH_DATA_LEN) }
        : {}),
    };
    // The record carries the task's original inputs so replayDlq can re-run the
    // same task (the failure fields win on a key clash and are stripped on replay).
    // If the inputs would push the record past the cap they are left out and the
    // record is marked, so replay skips it rather than running an empty task.
    const withInputs: Record<string, unknown> = { ...payload.data, ...failure };
    const data =
      Buffer.byteLength(JSON.stringify(withInputs), "utf8") <= MAX_PUBLISH_DATA_LEN
        ? withInputs
        : { ...failure, _inputs_omitted: true };
    await this.driver.publish(DLQ_CHANNEL, {
      taskId: payload.taskId,
      agentId: this.id,
      timestamp: Date.now(),
      data: capDataSize(data),
    });
  }

  private async executeTask(payload: MessagePayload): Promise<unknown> {
    // start() guarantees a handler is present, so this is always defined here.
    const handler = this.taskHandler!;
    const timeoutMs = this.taskTimeoutMs;

    // One AbortController per task: aborted on timeout (Finding #2 — stop the
    // in-flight LLM call so it stops burning tokens) and on actor shutdown.
    const controller = new AbortController();
    this.inFlight.add(controller);

    // Definite-assignment: the Promise executor runs synchronously, so the
    // handle is always set before the finally below.
    let timeoutHandle!: ReturnType<typeof setTimeout>;
    const handlerPromise = handler(payload, controller.signal);
    // C10: if the timeout wins the race, the handler promise can still reject
    // afterwards (the aborted LLM call throws late) — that rejection now has no
    // awaiter and would surface as an unhandledRejection. Attach a no-op catch
    // so the losing side is always handled. Promise.resolve() normalizes a
    // possibly non-thenable handler return; the race below still awaits the
    // original handlerPromise, so a winning rejection is NOT swallowed.
    Promise.resolve(handlerPromise).catch(() => {});
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        // Abort first so the handler's underlying work (LLM .invoke) cancels,
        // THEN reject the race so the actor's retry/DLQ path runs.
        const timedOut = new ControlAbortError(
          "task_timeout",
          `Task timed out after ${timeoutMs}ms`,
        );
        controller.abort(timedOut);
        reject(timedOut);
      }, timeoutMs);
    });
    try {
      return await Promise.race([handlerPromise, timeoutPromise]);
    } finally {
      // Clear the timer whichever side won, so a completed task never leaves an
      // armed timeout (default 300 000 ms) accumulating / holding the event loop.
      clearTimeout(timeoutHandle);
      this.inFlight.delete(controller);
    }
  }

  public async stop(): Promise<void> {
    log.info({ agentId: sanitizeId(this.id) }, "Actor stopping");
    this.stopping = true;
    // Cancel any in-flight task work on graceful shutdown so a draining node
    // does not keep burning tokens on tasks it will never report on.
    for (const controller of this.inFlight) {
      controller.abort(stoppedError());
    }
    this.inFlight.clear();
    await this.driver.unsubscribe(this.queueName);
  }
}
