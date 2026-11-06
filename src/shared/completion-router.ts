// SPDX-License-Identifier: Apache-2.0
/**
 * CompletionRouter — single subscription hub that dispatches task results by taskId.
 *
 * Solves a fundamental constraint: messaging drivers (BullMQ/Kafka) do not support
 * multiple handlers on the same queue. One router subscribes once and dispatches
 * to per-task Promise resolvers/rejectors.
 *
 * For BullMQ: one driver handles both completed and failed queues.
 * For Kafka:  TWO separate drivers are required (different consumer groups) because
 *             KafkaJS does not support subscribing to new topics after consumer.run() starts.
 *             Pass a pre-created failedDriver with a different groupId suffix.
 *
 * Usage:
 *   const router = new CompletionRouter(completedDriver, failedDriver);
 *   const raw = await router.wait(taskId, 120_000, 'research');
 *   const results = await router.waitAll([id1, id2, id3], 120_000, 'search');
 */
import type { IMessagingDriver } from "../infrastructure/messaging/interfaces";
import { createLogger } from "./logger";
import {
  EMERGENCY_STOP_REASON,
  EmergencyStopError,
} from "../domain/errors/DomainError";

const COMPLETED_QUEUE = "kaiban-events-completed";
const FAILED_QUEUE = "kaiban-events-failed";

const log = createLogger("CompletionRouter");

/** An emergency stop rejects with its own error; any other abort as before. */
function abortError(signal: AbortSignal, label: string): Error {
  const reason: unknown = signal.reason;
  return reason instanceof EmergencyStopError
    ? reason
    : new Error(`Aborted wait for ${label}`);
}

export class CompletionRouter {
  private pendingResolve = new Map<string, (result: string) => void>();
  private pendingReject = new Map<string, (err: Error) => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly completedDriver: IMessagingDriver;
  private readonly dlqDriver: IMessagingDriver;
  private completedSubscribed = false;
  private failedSubscribed = false;

  constructor(
    completedDriver: IMessagingDriver,
    failedDriver?: IMessagingDriver,
  ) {
    this.completedDriver = completedDriver;
    this.dlqDriver = failedDriver ?? completedDriver;
  }

  /**
   * Subscribe to the completed/failed queues — **lazily, on the first `wait()`**.
   * Two routers on the same node (e.g. the gateway's A2A executor router and an
   * orchestrator's router) are competing consumers on the shared BullMQ
   * `kaiban-events-completed` queue; whichever wins a completion it never
   * dispatched silently drops it, hanging the real waiter. Subscribing only when a
   * router actually has work to wait for means a router that never dispatches
   * (e.g. a gateway serving only the board with no A2A traffic) never consumes the
   * queue. BullMQ is durable, so a completion published before this subscribe lands
   * still waits in the queue for the late consumer.
   */
  private ensureSubscribed(): void {
    if (!this.completedSubscribed) {
      this.completedSubscribed = true;
      this.subscribeCompleted();
    }
    if (!this.failedSubscribed) {
      this.failedSubscribed = true;
      this.subscribeFailed();
    }
  }

  /**
   * Runs a subscribe call. If it fails (a synchronous throw or a rejection), the
   * error is logged, the queue is marked unsubscribed so the next `wait()` tries
   * again, and every pending waiter is rejected with the cause instead of timing
   * out. Never an unhandled rejection.
   */
  private subscribeWithRecovery(
    queue: string,
    subscribe: () => Promise<void>,
    reset: () => void,
  ): void {
    const failed = (err: unknown): void => {
      reset();
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Subscribe to ${queue} failed: ${message}`);
      this.rejectAllPending(
        new Error(`Could not subscribe to ${queue}: ${message}`),
      );
    };
    try {
      subscribe().catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [taskId, reject] of [...this.pendingReject]) {
      this.clearPending(taskId);
      reject(err);
    }
  }

  private subscribeCompleted(): void {
    // Successful completions
    this.subscribeWithRecovery(
      COMPLETED_QUEUE,
      () =>
        this.completedDriver.subscribe(COMPLETED_QUEUE, async (payload) => {
          const resolve = this.pendingResolve.get(payload.taskId);
          if (resolve) {
            this.clearPending(payload.taskId);
            const result = payload.data["result"];
            resolve(
              typeof result === "string"
                ? result
                : JSON.stringify(result ?? ""),
            );
          }
        }),
      () => (this.completedSubscribed = false),
    );
  }

  private subscribeFailed(): void {
    // Failed tasks (after max retries → DLQ) — surfaces real LLM error to orchestrator
    this.subscribeWithRecovery(
      FAILED_QUEUE,
      () =>
        this.dlqDriver.subscribe(FAILED_QUEUE, async (payload) => {
          const reject = this.pendingReject.get(payload.taskId);
          if (reject) {
            this.clearPending(payload.taskId);
            const errMsg = String(
              payload.data["error"] ?? "Task failed after max retries",
            );
            // The reason (e.g. the budget breach detail) follows the stable code.
            const reason = payload.data["reason"];
            const detail =
              typeof reason === "string" && reason ? ` — ${reason}` : "";
            const message = `Agent failed: ${errMsg}${detail}`;
            // A task killed by an emergency STOP ALL ends the waiting workflow too.
            reject(
              errMsg === EMERGENCY_STOP_REASON
                ? new EmergencyStopError(message)
                : new Error(message),
            );
          }
        }),
      () => (this.failedSubscribed = false),
    );
  }

  private clearPending(taskId: string): void {
    this.pendingResolve.delete(taskId);
    this.pendingReject.delete(taskId);
    const t = this.timers.get(taskId);
    /* v8 ignore next 3 — t is always set: wait() registers resolve/reject/timer atomically */
    if (t) {
      clearTimeout(t);
      this.timers.delete(taskId);
    }
  }

  /**
   * Waits for a single task to complete or fail.
   *
   * @param taskId    Task ID to wait for.
   * @param timeoutMs Max wait time in milliseconds.
   * @param label     Human-readable label used in timeout error messages.
   * @param signal    Optional AbortSignal — aborting rejects the wait and cleans up
   *                  (used by the A2A executor's `tasks/cancel` path).
   */
  wait(
    taskId: string,
    timeoutMs: number,
    label: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // Guard against a duplicate in-flight taskId: overwriting the maps would
      // orphan the first waiter's resolver + timer, hanging it forever.
      if (this.pendingResolve.has(taskId)) {
        reject(new Error(`Duplicate wait() for in-flight taskId: ${taskId}`));
        return;
      }
      if (signal) {
        if (signal.aborted) {
          reject(abortError(signal, label));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            if (this.pendingResolve.has(taskId)) {
              this.clearPending(taskId);
              reject(abortError(signal, label));
            }
          },
          { once: true },
        );
      }
      this.pendingResolve.set(taskId, resolve);
      this.pendingReject.set(taskId, reject);
      this.timers.set(
        taskId,
        setTimeout(() => {
          /* v8 ignore next — cleared by clearPending before timer fires when task resolves first */
          if (this.pendingResolve.has(taskId)) {
            this.clearPending(taskId);
            reject(
              new Error(
                `Timeout waiting for ${label} (${timeoutMs / 1000}s)\n` +
                  "Tip: increase RESEARCH_WAIT_MS / WRITE_WAIT_MS / EDIT_WAIT_MS",
              ),
            );
          }
        }, timeoutMs),
      );
      // After registering, so a subscribe that fails at once rejects this waiter.
      this.ensureSubscribed();
    });
  }

  /**
   * Waits for ALL given taskIds to complete or fail (fan-in aggregation).
   * Never rejects — failed tasks appear in the result array with an `error` field
   * so the caller can decide how to handle partial failures.
   *
   * @param taskIds   Array of task IDs to fan-in.
   * @param timeoutMs Per-task timeout in milliseconds.
   * @param label     Human-readable label prefix used in timeout error messages.
   */
  async waitAll(
    taskIds: string[],
    timeoutMs: number,
    label: string,
  ): Promise<Array<{ taskId: string; result?: string; error?: string }>> {
    const results: Array<{ taskId: string; result?: string; error?: string }> =
      [];
    await Promise.all(
      taskIds.map((taskId) =>
        this.wait(taskId, timeoutMs, `${label}[${taskId.slice(-8)}]`)
          .then((result) => {
            results.push({ taskId, result });
          })
          .catch((err: Error) => {
            log.warn(`Task ${taskId.slice(-8)} failed: ${err.message}`);
            results.push({ taskId, error: err.message });
          }),
      ),
    );
    return results;
  }
}
