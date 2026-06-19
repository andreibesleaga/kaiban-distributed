/**
 * KaibanAgentExecutor — the @a2a-js/sdk `AgentExecutor` that bridges an incoming
 * A2A task onto the kaiban-distributed actor messaging layer.
 *
 * Flow (per `execute`):
 *   1. Validate the task input (preserves the Phase-1.3 `A2A_INPUT_CAPS` contract;
 *      invalid input yields a terminal `rejected` Task, never a publish).
 *   2. Emit a `submitted` Task, then a `working` status-update.
 *   3. Publish a `MessagePayload` to `kaiban-agents-{id}` (the actor's mailbox) and
 *      await resolution via `CompletionRouter` (which subscribes to the completed /
 *      failed channels). The A2A `taskId` is the dedup key end-to-end (invariant I3).
 *   4. On success: emit a result Message, an artifact, and a final `completed`
 *      status-update; persist each lifecycle Task in the store for `tasks/get`.
 *   5. On failure: emit a final `failed` status-update (no internal detail leaked).
 *
 * `cancelTask` aborts the in-flight wait and emits a final `canceled` status-update.
 *
 * Idempotent / at-least-once: a duplicate `execute` for a taskId already in flight
 * is a no-op (it does not re-publish), and a terminal task is never regressed.
 *
 * Invariant: A2A is in front; the executor reaches agents via the messaging layer
 * (never an ad-hoc HTTP client). MCP tool access lives inside the agent worker.
 */
import { randomUUID } from "crypto";
import type {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
} from "@a2a-js/sdk/server";
import type {
  Task,
  TaskState,
  Message,
  TextPart,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from "@a2a-js/sdk";
import type { IMessagingDriver } from "../messaging/interfaces";
import type { CompletionRouter } from "../../shared/completion-router";
import type { TaskStore } from "@a2a-js/sdk/server";
import {
  validateTaskInput,
  type ValidatedTaskInput,
} from "./a2a-input-validation";

/** Mailbox channel prefix — one queue per agent (the actor's mailbox). */
const AGENT_CHANNEL_PREFIX = "kaiban-agents-";

export interface KaibanExecutorDeps {
  /** Messaging driver used to publish to the agent mailbox. */
  driver: Pick<IMessagingDriver, "publish">;
  /** Router that resolves a task result by taskId. */
  router: Pick<CompletionRouter, "wait">;
  /** Redis-backed A2A task store for `tasks/get` / `tasks/cancel`. */
  taskStore: TaskStore;
  /** Per-task wait timeout (ms). */
  timeoutMs: number;
}

interface InFlight {
  abort: AbortController;
  contextId: string;
}

export class KaibanAgentExecutor implements AgentExecutor {
  private readonly inFlight = new Map<string, InFlight>();

  constructor(private readonly deps: KaibanExecutorDeps) {}

  async execute(
    ctx: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const { taskId, contextId } = ctx;

    // Idempotency: a duplicate delivery for an in-flight task is a no-op.
    if (this.inFlight.has(taskId)) {
      eventBus.finished();
      return;
    }

    const validation = this.validate(ctx);
    if ("error" in validation) {
      await this.emitTerminal(
        eventBus,
        taskId,
        contextId,
        "rejected",
        validation.error.message,
      );
      return;
    }
    const params = validation.params;

    // Register in-flight SYNCHRONOUSLY (before any await) so a concurrent
    // duplicate delivery is reliably deduped and cancellation can find the entry.
    const abort = new AbortController();
    this.inFlight.set(taskId, { abort, contextId });
    try {
      // submitted → working
      await this.emitTask(eventBus, taskId, contextId, "submitted");
      this.emitStatus(eventBus, taskId, contextId, "working", false);

      await this.deps.driver.publish(`${AGENT_CHANNEL_PREFIX}${params.agentId}`, {
        taskId,
        agentId: params.agentId,
        data: this.toData(params),
        timestamp: Date.now(),
      });

      const result: string = await this.deps.router.wait(
        taskId,
        this.deps.timeoutMs,
        params.agentId,
        abort.signal,
      );
      await this.emitSuccess(eventBus, taskId, contextId, result);
    } catch {
      // Cancellation emits its own terminal event; do not double-emit.
      if (!abort.signal.aborted) {
        await this.emitTerminal(
          eventBus,
          taskId,
          contextId,
          "failed",
          "Task execution failed",
        );
      }
    } finally {
      this.inFlight.delete(taskId);
    }
  }

  async cancelTask(
    taskId: string,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const entry = this.inFlight.get(taskId);
    entry?.abort.abort();
    await this.emitTerminal(
      eventBus,
      taskId,
      entry?.contextId ?? taskId,
      "canceled",
      "Task canceled",
    );
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private validate(
    ctx: RequestContext,
  ): ReturnType<typeof validateTaskInput> {
    const meta = (ctx.userMessage.metadata ?? {}) as Record<string, unknown>;
    const instruction =
      typeof meta["instruction"] === "string"
        ? (meta["instruction"] as string)
        : this.textOf(ctx.userMessage);
    return validateTaskInput({
      agentId: meta["agentId"],
      ...(instruction ? { instruction } : {}),
      ...(meta["expectedOutput"] !== undefined
        ? { expectedOutput: meta["expectedOutput"] }
        : {}),
      ...(meta["context"] !== undefined ? { context: meta["context"] } : {}),
      ...(meta["inputs"] !== undefined ? { inputs: meta["inputs"] } : {}),
    });
  }

  private textOf(message: Message): string {
    return message.parts
      .filter((p): p is TextPart => p.kind === "text")
      .map((p) => p.text)
      .join("\n");
  }

  private toData(params: ValidatedTaskInput): Record<string, unknown> {
    // Forward every validated field except the routing agentId (it is the channel).
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key !== "agentId") data[key] = value;
    }
    return data;
  }

  private buildTask(
    taskId: string,
    contextId: string,
    state: TaskState,
    message?: Message,
  ): Task {
    return {
      kind: "task",
      id: taskId,
      contextId,
      status: {
        state,
        ...(message ? { message } : {}),
        timestamp: new Date().toISOString(),
      },
    };
  }

  private agentMessage(
    taskId: string,
    contextId: string,
    text: string,
  ): Message {
    return {
      kind: "message",
      role: "agent",
      messageId: randomUUID(),
      taskId,
      contextId,
      parts: [{ kind: "text", text }],
    };
  }

  private async emitTask(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    state: TaskState,
    message?: Message,
  ): Promise<void> {
    const task = this.buildTask(taskId, contextId, state, message);
    eventBus.publish(task);
    await this.deps.taskStore.save(task);
  }

  private emitStatus(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    state: TaskState,
    final: boolean,
    message?: Message,
  ): void {
    const event: TaskStatusUpdateEvent = {
      kind: "status-update",
      taskId,
      contextId,
      status: {
        state,
        ...(message ? { message } : {}),
        timestamp: new Date().toISOString(),
      },
      final,
    };
    eventBus.publish(event);
  }

  private async emitSuccess(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    result: string,
  ): Promise<void> {
    const artifact: TaskArtifactUpdateEvent = {
      kind: "artifact-update",
      taskId,
      contextId,
      artifact: {
        artifactId: randomUUID(),
        name: "result",
        parts: [{ kind: "text", text: result }],
      },
    };
    eventBus.publish(artifact);

    const message = this.agentMessage(taskId, contextId, result);
    await this.emitTask(eventBus, taskId, contextId, "completed", message);
    this.emitStatus(eventBus, taskId, contextId, "completed", true, message);
    eventBus.finished();
  }

  private async emitTerminal(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    state: TaskState,
    text: string,
  ): Promise<void> {
    const message = this.agentMessage(taskId, contextId, text);
    await this.emitTask(eventBus, taskId, contextId, state, message);
    this.emitStatus(eventBus, taskId, contextId, state, true, message);
    eventBus.finished();
  }
}
