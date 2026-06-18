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
import {
  recordAnomalyEvent,
  recordMessageProcessed,
  recordMessageLatency,
} from "../../infrastructure/telemetry/telemetry";
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

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 100;
const MAX_PUBLISH_DATA_LEN = 65_536; // 64 KB — cap outbound message data

function sanitizeId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 8);
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Truncate data values so published messages stay under MAX_PUBLISH_DATA_LEN */
function capDataSize(data: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(data);
  if (json.length <= MAX_PUBLISH_DATA_LEN) return data;
  return {
    ...data,
    result: String(data["result"] ?? "").slice(0, MAX_PUBLISH_DATA_LEN),
    _truncated: true,
  };
}

/** Default per-task execution timeout: 5 minutes */
const DEFAULT_TASK_TIMEOUT_MS = 300_000;

export interface AgentActorDeps {
  firewall?: ISemanticFirewall;
  circuitBreaker?: ICircuitBreaker;
  /** Max ms a single task handler may run before being timed out (default: 300_000) */
  taskTimeoutMs?: number;
}

export class AgentActor {
  private id: string;
  private driver: IMessagingDriver;
  private queueName: string;
  private taskHandler?: TaskHandler;
  private firewall?: ISemanticFirewall;
  private circuitBreaker?: ICircuitBreaker;
  private taskTimeoutMs: number;
  /** In-flight task abort controllers, so stop() can cancel running work. */
  private readonly inFlight = new Set<AbortController>();

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
    this.taskTimeoutMs = deps?.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
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

    if (await this.isBlockedByGuards(payload)) return;

    await this.executeWithRetries(payload);
  }

  private async isBlockedByGuards(payload: MessagePayload): Promise<boolean> {
    if (this.circuitBreaker?.isOpen()) {
      log.warn(
        { agentId: sanitizeId(this.id), taskId: payload.taskId },
        "Circuit breaker OPEN — rejecting task",
      );
      recordAnomalyEvent("circuit_breaker.rejected", {
        agentId: sanitizeId(this.id),
        taskId: payload.taskId,
      });
      await this.publishToDlq(payload, "circuit_breaker_open");
      return true;
    }

    if (this.firewall) {
      const verdict = await this.firewall.evaluate(payload);
      if (!verdict.allowed) {
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
    }

    return false;
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
        lastError = err instanceof Error ? err.message : String(err);
        log.error(
          { agentId: sanitizeId(this.id), attempt, err: lastError },
          "Task attempt failed",
        );
        if (attempt < RETRY_ATTEMPTS) {
          await delay(RETRY_BASE_DELAY_MS * attempt);
        }
      }
    }

    this.circuitBreaker?.recordFailure();
    recordMessageLatency(Date.now() - start, "failed");
    await this.publishToDlq(payload, lastError);
  }

  private async publishToDlq(
    payload: MessagePayload,
    error: string,
    reason?: string,
  ): Promise<void> {
    recordMessageProcessed("failed");
    await this.driver.publish(DLQ_CHANNEL, {
      taskId: payload.taskId,
      agentId: this.id,
      timestamp: Date.now(),
      data: capDataSize({
        status: "failed",
        error,
        ...(reason ? { reason } : {}),
      }),
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
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        // Abort first so the handler's underlying work (LLM .invoke) cancels,
        // THEN reject the race so the actor's retry/DLQ path runs.
        controller.abort(new Error(`Task timed out after ${timeoutMs}ms`));
        reject(new Error(`Task timed out after ${timeoutMs}ms`));
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
    // Cancel any in-flight task work on graceful shutdown so a draining node
    // does not keep burning tokens on tasks it will never report on.
    for (const controller of this.inFlight) {
      controller.abort(new Error("Actor stopping"));
    }
    this.inFlight.clear();
    await this.driver.unsubscribe(this.queueName);
  }
}
