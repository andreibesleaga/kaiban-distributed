/**
 * Dispatch a task to an agent's mailbox (the actor-model dispatch primitive).
 *
 * Publishes a `MessagePayload` to the agent's queue (`kaiban-agents-{id}`); the
 * `AgentActor` running there consumes it, runs its `TaskHandler`, and publishes the
 * result to the completed channel (keyed by the returned `taskId`, which the caller
 * awaits via `CompletionRouter.wait`).
 *
 * This is the internal orchestration path (an orchestrator dispatching to its
 * workers) — distinct from the A2A federation surface (`message/send`, for external
 * callers) and the MCP tool surface. It replaces the removed custom `tasks.create`
 * RPC the v1 examples used (ADR-015 dropped that method in the A2A v0.3 migration).
 */
import { randomUUID } from "crypto";
import type { IMessagingDriver } from "../infrastructure/messaging/interfaces";

/** Mailbox channel prefix — one queue per agent. */
export const AGENT_CHANNEL_PREFIX = "kaiban-agents-";

export interface DispatchParams {
  /** What the agent should do. */
  instruction: string;
  /** Optional acceptance criteria for the result. */
  expectedOutput?: string;
  /** Optional upstream context (e.g. a prior phase's output). */
  context?: string;
  /** Optional structured inputs forwarded to the handler. */
  inputs?: Record<string, unknown>;
}

/**
 * Publish a task to `agentId`'s mailbox and return its `taskId` (the dedup key the
 * caller waits on). Only the validated fields that are present are forwarded.
 */
export async function dispatchToAgent(
  driver: Pick<IMessagingDriver, "publish">,
  agentId: string,
  params: DispatchParams,
): Promise<string> {
  const taskId = randomUUID();
  await driver.publish(`${AGENT_CHANNEL_PREFIX}${agentId}`, {
    taskId,
    agentId,
    data: {
      instruction: params.instruction,
      ...(params.expectedOutput !== undefined
        ? { expectedOutput: params.expectedOutput }
        : {}),
      ...(params.context !== undefined ? { context: params.context } : {}),
      ...(params.inputs !== undefined ? { inputs: params.inputs } : {}),
    },
    timestamp: Date.now(),
  });
  return taskId;
}
