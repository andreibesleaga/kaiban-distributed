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

const COMPLETED_QUEUE = "kaiban-events-completed";
const FAILED_QUEUE = "kaiban-events-failed";

const log = createLogger("CompletionRouter");

export class CompletionRouter {
  private pendingResolve = new Map<string, (result: string) => void>();
  private pendingReject = new Map<string, (err: Error) => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    completedDriver: IMessagingDriver,
    failedDriver?: IMessagingDriver,
  ) {
    const dlqDriver = failedDriver ?? completedDriver;

    // Successful completions
    void completedDriver.subscribe(COMPLETED_QUEUE, async (payload) => {
      const resolve = this.pendingResolve.get(payload.taskId);
      if (resolve) {
        this.clearPending(payload.taskId);
        const result = payload.data["result"];
        resolve(
          typeof result === "string" ? result : JSON.stringify(result ?? ""),
        );
      }
    });

    // Failed tasks (after max retries → DLQ) — surfaces real LLM error to orchestrator
    void dlqDriver.subscribe(FAILED_QUEUE, async (payload) => {
      const reject = this.pendingReject.get(payload.taskId);
      if (reject) {
        this.clearPending(payload.taskId);
        const errMsg = String(
          payload.data["error"] ?? "Task failed after max retries",
        );
        reject(new Error(`Agent failed: ${errMsg}`));
      }
    });
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
   */
  wait(taskId: string, timeoutMs: number, label: string): Promise<string> {
    return new Promise((resolve, reject) => {
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
