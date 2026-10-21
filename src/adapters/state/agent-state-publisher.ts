/**
 * AgentStatePublisher — publishes agent and task state directly to Redis Pub/Sub.
 *
 * Bypasses BullMQ (which is for task queues) and writes to the same channel that
 * SocketGateway reads: 'kaiban-state-events'. The board receives these via Socket.io.
 *
 * Each worker node creates one publisher, registers its agent, and wraps its task
 * handler so the board sees IDLE → EXECUTING → DONE transitions in real-time.
 */
import { Redis } from "ioredis";
import type { MessagePayload } from "../../infrastructure/messaging/interfaces";
import type { TaskHandler } from "../../application/actor/AgentActor";
import { STATE_CHANNEL } from "../../infrastructure/messaging/channels";
import { wrapSigned } from "../../infrastructure/security/channel-signing";
import { sanitizeDelta } from "./distributedMiddleware";
import { createStructuredLogger } from "../../shared/structured-logger";
import { BudgetExceededError, formatCap } from "../../shared/budget";
import { FailedAttemptError } from "../../domain/errors/DomainError";

const log = createStructuredLogger({ component: "AgentStatePublisher" });

export interface AgentInfo {
  agentId: string;
  name: string;
  role: string;
}

interface AgentState extends AgentInfo {
  status: "IDLE" | "THINKING" | "EXECUTING" | "ERROR";
  currentTaskId: string | null;
}

interface TaskState {
  taskId: string;
  title: string;
  status: "TODO" | "DOING" | "DONE" | "BLOCKED" | "AWAITING_VALIDATION";
  assignedToAgentId: string;
  result?: string;
  tokens?: number;
  cost?: number;
}

// 20 KB — large enough for a full blog post (typically 3–6 KB), still bounds
// message size. The invariant is BYTES (state events are serialized to UTF-8
// over Redis Pub/Sub), so truncation uses Buffer.byteLength(...,"utf8") and
// never splits a multi-byte character — mirrors a2a-input-validation.ts.
const MAX_RESULT_LEN = 20_000;

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes WITHOUT splitting a
 * multi-byte character. Over-trim by UTF-16 code units (each ≥1 byte) then
 * shrink one unit at a time until within budget. Terminates: the empty string
 * is 0 bytes ≤ maxBytes.
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

/** How many recent taskIds keep a per-task token tally (bounded memory). */
const MAX_TRACKED_TASKS = 1_000;

export interface AgentStatePublisherOpts {
  /**
   * Max cumulative tokens for this agent process (all tasks). Checked BEFORE a
   * task runs (a task that finds the cap already met is refused without an LLM
   * call) and after each result or usage-carrying failed attempt. `Infinity`,
   * `undefined` or `0` = unlimited
   * (the env path, `resolveSpendCaps`, never yields `0`).
   */
  maxTokenBudget?: number;
  /**
   * Max tokens one task may consume across all its deliveries/attempts. Checked
   * before the task runs and after each result — including a failed attempt
   * whose `FailedAttemptError` carries its usage. `Infinity`/`undefined`/`0` =
   * unlimited.
   */
  maxTaskTokenBudget?: number;
}

/** A positive, finite cap binds; `Infinity` / `0` / `undefined` do not. */
function cappedAt(cap: number | undefined): number | null {
  return cap !== undefined && Number.isFinite(cap) && cap > 0 ? cap : null;
}

export class AgentStatePublisher {
  private redis: Redis;
  private agentInfo: AgentInfo;
  private totalTokensUsed = 0;
  private readonly maxTokenBudget: number | null;
  private readonly maxTaskTokenBudget: number | null;
  /** Tokens consumed so far per taskId (bounded to MAX_TRACKED_TASKS entries). */
  private readonly taskTokensUsed = new Map<string, number>();

  constructor(
    redisUrl: string,
    agentInfo: AgentInfo,
    opts?: AgentStatePublisherOpts,
  ) {
    this.redis = new Redis(redisUrl, { lazyConnect: false });
    this.agentInfo = agentInfo;
    this.maxTokenBudget = cappedAt(opts?.maxTokenBudget);
    this.maxTaskTokenBudget = cappedAt(opts?.maxTaskTokenBudget);
  }

  /** Cumulative tokens this agent process has consumed. */
  getTotalTokensUsed(): number {
    return this.totalTokensUsed;
  }

  /**
   * Pre-flight: refuse a task whose agent-level or task-level accumulated usage
   * already meets its cap — before the handler (and the paid LLM call) runs.
   */
  private assertCapsNotMet(taskId: string): void {
    if (
      this.maxTokenBudget !== null &&
      this.totalTokensUsed >= this.maxTokenBudget
    ) {
      throw new BudgetExceededError(
        `Token budget exceeded before task ${taskId}: ` +
          `${this.totalTokensUsed} >= ${formatCap(this.maxTokenBudget)}`,
        "token_budget_exceeded",
      );
    }
    const taskUsed = this.taskTokensUsed.get(taskId) ?? 0;
    if (this.maxTaskTokenBudget !== null && taskUsed >= this.maxTaskTokenBudget) {
      throw new BudgetExceededError(
        `Task token budget exceeded before task ${taskId}: ` +
          `${taskUsed} >= ${formatCap(this.maxTaskTokenBudget)}`,
        "task_token_budget_exceeded",
      );
    }
  }

  /**
   * Account a finished task's tokens against the agent and task tallies and
   * return the breach (if any) to raise — task cap first, then agent cap.
   */
  private accountTokens(
    taskId: string,
    totalTokens: number,
  ): BudgetExceededError | null {
    this.totalTokensUsed += totalTokens;
    const taskUsed = (this.taskTokensUsed.get(taskId) ?? 0) + totalTokens;
    this.taskTokensUsed.delete(taskId);
    this.taskTokensUsed.set(taskId, taskUsed);
    if (this.taskTokensUsed.size > MAX_TRACKED_TASKS) {
      const oldest = this.taskTokensUsed.keys().next().value as string;
      this.taskTokensUsed.delete(oldest);
    }
    if (this.maxTaskTokenBudget !== null && taskUsed >= this.maxTaskTokenBudget) {
      return new BudgetExceededError(
        `Task token budget exceeded: ${taskUsed} >= ${formatCap(this.maxTaskTokenBudget)}`,
        "task_token_budget_exceeded",
      );
    }
    if (
      this.maxTokenBudget !== null &&
      this.totalTokensUsed >= this.maxTokenBudget
    ) {
      return new BudgetExceededError(
        `Token budget exceeded: ${this.totalTokensUsed} >= ${formatCap(this.maxTokenBudget)}`,
        "token_budget_exceeded",
      );
    }
    return null;
  }

  /** Publish a partial state delta — board merges by agentId/taskId */
  private publish(delta: {
    agents?: AgentState[];
    tasks?: TaskState[];
    teamWorkflowStatus?: string;
  }): void {
    // Defense-in-depth: strip any PII-named top-level keys on the worker path too
    // (the middleware path already sanitizes via DistributedStateMiddleware).
    this.redis
      .publish(STATE_CHANNEL, wrapSigned(sanitizeDelta(delta)))
      .catch((err: unknown) =>
        log.error({ err }, "Failed to publish state"),
      );
  }

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private currentStatus: string = "IDLE";
  private currentTaskId: string | null = null;

  /**
   * Call on node startup — board shows IDLE immediately.
   * Starts a periodic heartbeat so late-connecting boards/monitors see current state
   * within HEARTBEAT_INTERVAL_MS even if they missed the initial publish.
   */
  publishIdle(heartbeatIntervalMs = 15000): void {
    this.currentStatus = "IDLE";
    this.currentTaskId = null;
    // publishIdle: only agent state — orchestrator controls teamWorkflowStatus
    this.publish({
      agents: [{ ...this.agentInfo, status: "IDLE", currentTaskId: null }],
    });
    // Start heartbeat so late-connecting board viewers see this agent within 15s
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      // Heartbeat: only agent state — orchestrator controls teamWorkflowStatus
      this.publish({
        agents: [
          {
            ...this.agentInfo,
            status: this.currentStatus as "IDLE" | "EXECUTING" | "ERROR",
            currentTaskId: this.currentTaskId,
          },
        ],
      });
    }, heartbeatIntervalMs);
  }

  private formatDisplayResult(result: unknown): string {
    const kaibanResult =
      result !== null && typeof result === "object"
        ? (result as Record<string, unknown>)
        : null;
    const displayResult =
      kaibanResult && "answer" in kaibanResult
        ? String(kaibanResult["answer"] ?? "")
        : result;

    if (displayResult == null) return "";
    const str =
      typeof displayResult === "string"
        ? displayResult
        : JSON.stringify(displayResult);
    return truncateToBytes(str, MAX_RESULT_LEN);
  }

  private extractTokenMetadata(
    result: unknown,
  ): { totalTokens: number; estimatedCost: number } | undefined {
    if (result !== null && typeof result === "object") {
      const kaibanResult = result as Record<string, unknown>;
      if ("inputTokens" in kaibanResult && "outputTokens" in kaibanResult) {
        return {
          totalTokens:
            Number(kaibanResult["inputTokens"] ?? 0) +
            Number(kaibanResult["outputTokens"] ?? 0),
          estimatedCost: Number(kaibanResult["estimatedCost"] ?? 0),
        };
      }
    }
    return undefined;
  }

  /**
   * Wraps a task handler to publish EXECUTING → DONE/ERROR state transitions.
   * The original handler's return value (LLM result) is preserved.
   */
  wrapHandler(handler: TaskHandler): TaskHandler {
    const { agentId, name, role } = this.agentInfo;
    const pub = (d: Parameters<AgentStatePublisher["publish"]>[0]): void =>
      this.publish(d);

    return async (
      payload: MessagePayload,
      signal?: AbortSignal,
    ): Promise<unknown> => {
      const title = String(payload.data["instruction"] ?? payload.taskId).slice(
        0,
        60,
      );

      try {
        // Pre-flight (roadmap §7.2 item 2): a task that finds a cap already met
        // is refused here — no EXECUTING state, no handler call, no paid request;
        // the catch below publishes ERROR/BLOCKED. BudgetExceededError is
        // non-retryable, so the actor dead-letters it after this one attempt.
        this.assertCapsNotMet(payload.taskId);

        // → EXECUTING (task queued / starting)
        this.currentStatus = "EXECUTING";
        this.currentTaskId = payload.taskId;
        pub({
          agents: [
            {
              agentId,
              name,
              role,
              status: "EXECUTING",
              currentTaskId: payload.taskId,
            },
          ],
          tasks: [
            {
              taskId: payload.taskId,
              title,
              status: "DOING",
              assignedToAgentId: agentId,
            },
          ],
        });

        // → THINKING (LLM call in progress)
        pub({
          agents: [
            {
              agentId,
              name,
              role,
              status: "THINKING",
              currentTaskId: payload.taskId,
            },
          ],
        });

        const result = await handler(payload, signal);

        // → DONE
        this.currentStatus = "IDLE";
        this.currentTaskId = null;
        const resultStr = this.formatDisplayResult(result);
        const tokenMeta = this.extractTokenMetadata(result);

        // Token budget check (task cap, then agent cap); the breach is
        // non-retryable so the paid attempt is the only one.
        if (tokenMeta) {
          const breach = this.accountTokens(payload.taskId, tokenMeta.totalTokens);
          if (breach) {
            pub({
              agents: [
                {
                  agentId,
                  name,
                  role,
                  status: "ERROR",
                  currentTaskId: payload.taskId,
                },
              ],
              tasks: [
                {
                  taskId: payload.taskId,
                  title,
                  status: "BLOCKED",
                  assignedToAgentId: agentId,
                },
              ],
            });
            throw breach;
          }
        }

        pub({
          agents: [
            { agentId, name, role, status: "IDLE", currentTaskId: null },
          ],
          tasks: [
            {
              taskId: payload.taskId,
              title,
              status: "DONE",
              assignedToAgentId: agentId,
              result: resultStr,
              ...(tokenMeta
                ? {
                    tokens: tokenMeta.totalTokens,
                    cost: tokenMeta.estimatedCost,
                  }
                : {}),
            },
          ],
          ...(tokenMeta ? { metadata: tokenMeta } : {}),
        });

        return result;
      } catch (err) {
        // A failed attempt that already spent tokens counts against the caps
        // BEFORE the actor retries; reaching one ends the task non-retryably.
        const failure = this.accountFailedAttempt(payload.taskId, err);
        // → ERROR
        this.currentStatus = "ERROR";
        pub({
          agents: [
            {
              agentId,
              name,
              role,
              status: "ERROR",
              currentTaskId: payload.taskId,
            },
          ],
          tasks: [
            {
              taskId: payload.taskId,
              title,
              status: "BLOCKED",
              assignedToAgentId: agentId,
            },
          ],
        });
        throw failure;
      }
    };
  }

  /**
   * Count the usage a `FailedAttemptError` carries. Returns the cap breach to
   * raise instead of the failure (non-retryable), else the original error.
   */
  private accountFailedAttempt(taskId: string, err: unknown): unknown {
    if (!(err instanceof FailedAttemptError)) return err;
    const breach = this.accountTokens(
      taskId,
      err.usage.inputTokens + err.usage.outputTokens,
    );
    if (!breach) return err;
    log.warn(
      { taskId, reasonCode: breach.reasonCode, failure: err.message },
      "Failed attempt reached a token cap — not retrying",
    );
    return breach;
  }

  async disconnect(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await this.redis.quit();
  }
}
