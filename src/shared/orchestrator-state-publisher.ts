/**
 * Base orchestrator state publisher — shared across all examples.
 *
 * Publishes signed state deltas to the `kaiban-state-events` Redis channel.
 * The SocketGateway consumes those events and pushes them to connected board clients.
 *
 * This class provides the low-level primitives (publish, taskQueued, taskFailed,
 * taskDone, publishMetadata, disconnect) that are identical in every orchestrator.
 * Example-specific lifecycle methods (workflowStarted, workflowFinished, awaitingHITL, …)
 * are implemented by subclasses or by calling `publish()` directly.
 *
 * Design note:
 *   Workers' AgentStatePublisher no longer emits `teamWorkflowStatus` — only the
 *   OrchestratorStatePublisher controls the workflow lifecycle
 *   (RUNNING → FINISHED / STOPPED). This prevents heartbeats from overriding
 *   terminal states.
 *
 * Usage:
 *   class BlogStatePublisher extends OrchestratorStatePublisher {
 *     workflowStarted(topic: string) {
 *       this.publish({ teamWorkflowStatus: 'RUNNING', inputs: { topic }, … });
 *     }
 *   }
 *   const pub = new BlogStatePublisher(REDIS_URL);
 *   pub.taskQueued(taskId, 'Write article', 'writer');
 *   await pub.disconnect();
 */

import { Redis } from "ioredis";
import { wrapSigned } from "../infrastructure/security/channel-signing";

export class OrchestratorStatePublisher {
  protected readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { lazyConnect: false });
  }

  /**
   * Fire-and-forget publish of a partial state delta.
   * The SocketGateway merges the delta into the current board state.
   */
  publish(delta: Record<string, unknown>): void {
    this.redis
      .publish("kaiban-state-events", wrapSigned(delta))
      .catch((err: unknown) =>
        console.error("[OrchestratorStatePublisher] Publish failed:", err),
      );
  }

  /**
   * Mark a task as queued immediately after it is dispatched to a worker.
   * The board shows it in the TODO column.
   */
  taskQueued(taskId: string, title: string, agentId: string): void {
    this.publish({
      tasks: [
        {
          taskId,
          title: title.slice(0, 60),
          status: "TODO",
          assignedToAgentId: agentId,
        },
      ],
    });
  }

  /**
   * Mark a task as done (DONE column on the board).
   */
  taskDone(taskId: string, agentId: string): void {
    this.publish({
      tasks: [{ taskId, status: "DONE", assignedToAgentId: agentId }],
    });
  }

  /**
   * Mark a task as failed (BLOCKED column, ERROR agent status).
   * Truncates title and error to board-safe lengths.
   */
  taskFailed(
    taskId: string,
    agentId: string,
    title: string,
    error: string,
  ): void {
    this.publish({
      agents: [
        {
          agentId,
          name: agentId,
          role: agentId,
          status: "ERROR",
          currentTaskId: taskId,
        },
      ],
      tasks: [
        {
          taskId,
          title: title.slice(0, 60),
          status: "BLOCKED",
          assignedToAgentId: agentId,
          result: `ERROR: ${error.slice(0, 200)}`,
        },
      ],
    });
  }

  /**
   * Publish a running-total metadata delta so the board updates in real time.
   * Typically called after each agent response is received.
   */
  publishMetadata(meta: { totalTokens: number; estimatedCost: number }): void {
    this.publish({ metadata: meta });
  }

  /** Gracefully closes the Redis connection. */
  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}
