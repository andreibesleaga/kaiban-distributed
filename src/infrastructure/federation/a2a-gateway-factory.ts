/**
 * buildA2AStack — assembles the official `@a2a-js/sdk` server stack for the
 * gateway: the Redis task store, the agent-status tracker, the bridging
 * executor, and the SDK `DefaultRequestHandler` (which answers `message/send`,
 * `message/stream`, `tasks/get`, `tasks/cancel`).
 *
 * Keeping the wiring in one factory lets the gateway entrypoint, the conformance
 * tests, and the examples share an identical, correctly-ordered assembly.
 */
import {
  DefaultRequestHandler,
  type A2ARequestHandler,
} from "@a2a-js/sdk/server";
import type { IMessagingDriver } from "../messaging/interfaces";
import type { CompletionRouter } from "../../shared/completion-router";
import { RedisTaskStore } from "./a2a-task-store";
import { AgentStatusTracker } from "./agent-status-tracker";
import { KaibanAgentExecutor } from "./a2a-executor";
import { buildAgentCard } from "./a2a-agent-card";

export interface A2AStackOptions {
  /** Driver used to publish A2A tasks onto agent mailboxes. */
  driver: Pick<IMessagingDriver, "publish">;
  /** Router that resolves task results by taskId. */
  router: CompletionRouter;
  /** Redis URL for the task store + status tracker (Pub/Sub). */
  redisUrl: string;
  /** Agent/service name for the card. */
  name: string;
  /** Provider-defined version for the card. */
  version: string;
  /** Absolute base URL the gateway is reachable at. */
  baseUrl: string;
  /** Agent IDs this gateway can route to (one card skill per id). */
  agentIds: string[];
  /** Per-task wait timeout (ms). */
  timeoutMs: number;
  /** Advertise the JWT bearer security scheme on the card. */
  jwtEnabled?: boolean;
  /** Advertise the push-notification capability flag. */
  pushNotifications?: boolean;
  /** Optional provider block for the card. */
  provider?: { organization: string; url: string };
}

export interface A2AStack {
  requestHandler: A2ARequestHandler;
  statusTracker: AgentStatusTracker;
  taskStore: RedisTaskStore;
  /** Begin consuming agent state (real `agent.status`). */
  start(): Promise<void>;
  /** Tear down owned Redis clients. */
  close(): Promise<void>;
}

export function buildA2AStack(opts: A2AStackOptions): A2AStack {
  const card = buildAgentCard({
    name: opts.name,
    version: opts.version,
    baseUrl: opts.baseUrl,
    agentIds: opts.agentIds,
    ...(opts.jwtEnabled !== undefined ? { jwtEnabled: opts.jwtEnabled } : {}),
    ...(opts.pushNotifications !== undefined
      ? { pushNotifications: opts.pushNotifications }
      : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
  });

  const taskStore = new RedisTaskStore(opts.redisUrl);
  const statusTracker = new AgentStatusTracker(opts.redisUrl);
  const executor = new KaibanAgentExecutor({
    driver: opts.driver,
    router: opts.router,
    taskStore,
    timeoutMs: opts.timeoutMs,
  });
  const requestHandler = new DefaultRequestHandler(card, taskStore, executor);

  return {
    requestHandler,
    statusTracker,
    taskStore,
    async start(): Promise<void> {
      await statusTracker.start();
    },
    async close(): Promise<void> {
      await Promise.all([statusTracker.stop(), taskStore.close()]);
    },
  };
}
