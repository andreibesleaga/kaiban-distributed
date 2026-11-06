// SPDX-License-Identifier: Apache-2.0
import { Redis } from "ioredis";
import { createRedisClient } from "../../shared/redis-connection";
import type { MessagePayload } from "../../infrastructure/messaging/interfaces";
import {
  unwrapVerified,
  wrapSigned,
} from "../../infrastructure/security/channel-signing";
import { STATE_CHANNEL } from "../../infrastructure/messaging/channels";
import { createStructuredLogger } from "../../shared/structured-logger";

const log = createStructuredLogger({ component: "DistributedStateMiddleware" });

const PII_DENYLIST: ReadonlySet<string> = new Set([
  "email",
  "name",
  "phone",
  "ip",
  "password",
  "token",
  "secret",
  "ssn",
  "dob",
]);

/**
 * Strip PII-named top-level keys from a state delta before it leaves the process.
 * Shared by {@link DistributedStateMiddleware} (Zustand path) and the worker
 * `AgentStatePublisher` path so PII minimisation applies to both.
 */
export function sanitizeDelta(partial: unknown): Record<string, unknown> {
  if (partial === null || typeof partial !== "object") return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    partial as Record<string, unknown>,
  )) {
    if (!PII_DENYLIST.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

/** The slice of a KaibanJS agent the board shows. */
interface KaibanAgentLike {
  id?: unknown;
  name?: unknown;
  role?: unknown;
  status?: unknown;
}

/** The slice of a KaibanJS task the board shows. */
interface KaibanTaskLike {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  result?: unknown;
  agent?: { id?: unknown } | null;
}

/** The slice of the KaibanJS store state the middleware reads. */
interface KaibanStoreState {
  teamWorkflowStatus?: unknown;
  agents?: KaibanAgentLike[];
  tasks?: KaibanTaskLike[];
}

/** A Zustand vanilla store as `Team.getStore()` returns it. */
interface ObservableStore {
  subscribe: (
    listener: (state: KaibanStoreState, prev: KaibanStoreState) => void,
  ) => () => void;
}

/** Longest task result sent to the board, in characters (bounds message size). */
const MAX_RESULT_CHARS = 20_000;

const BOARD_TASK_STATUS: Readonly<Record<string, string>> = {
  TODO: "TODO",
  DOING: "DOING",
  DONE: "DONE",
  BLOCKED: "BLOCKED",
  AWAITING_VALIDATION: "AWAITING_VALIDATION",
  VALIDATED: "DONE",
  REVISE: "DOING",
};

/** KaibanJS agent statuses (THINKING, USING_TOOL, ISSUES_*, …) → the board's four. */
function boardAgentStatus(status: unknown): string {
  const s = String(status);
  if (s.startsWith("ISSUES") || s.includes("ERROR")) return "ERROR";
  if (s.startsWith("THINKING") && s !== "THINKING_END") return "THINKING";
  if (s.startsWith("EXECUTING") || s === "USING_TOOL") return "EXECUTING";
  return "IDLE";
}

function boardResult(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.slice(0, MAX_RESULT_CHARS);
}

function boardAgents(agents: KaibanAgentLike[]): Record<string, unknown>[] {
  return agents
    .filter((a) => typeof a.id === "string")
    .map((a) => ({
      agentId: a.id,
      name: String(a.name ?? a.id),
      role: String(a.role ?? ""),
      status: boardAgentStatus(a.status),
      currentTaskId: null,
    }));
}

function boardTasks(tasks: KaibanTaskLike[]): Record<string, unknown>[] {
  return tasks
    .filter((t) => typeof t.id === "string")
    .map((t) => {
      const result = boardResult(t.result);
      return {
        taskId: t.id,
        title: String(t.title ?? t.id),
        status: BOARD_TASK_STATUS[String(t.status)] ?? "TODO",
        assignedToAgentId: String(t.agent?.id ?? ""),
        ...(result !== undefined ? { result } : {}),
      };
    });
}

/**
 * Map a KaibanJS store change to a board delta (`teamWorkflowStatus`, `agents`,
 * `tasks`) — the shape the gateway merges by agentId / taskId. Only the parts
 * that changed are included; an empty object means nothing to publish.
 */
export function toBoardDelta(
  state: KaibanStoreState,
  prev: KaibanStoreState,
): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  if (state.teamWorkflowStatus !== prev.teamWorkflowStatus && state.teamWorkflowStatus !== undefined) {
    delta["teamWorkflowStatus"] = state.teamWorkflowStatus;
  }
  if (state.agents !== prev.agents && Array.isArray(state.agents)) {
    delta["agents"] = boardAgents(state.agents);
  }
  if (state.tasks !== prev.tasks && Array.isArray(state.tasks)) {
    delta["tasks"] = boardTasks(state.tasks);
  }
  return delta;
}

/**
 * Streams a KaibanJS team's state to the board. It subscribes to the team's
 * store (`store.subscribe`, which sees every change however the store's own
 * actions made it), maps each change to a board delta and publishes it on the
 * state channel, signed like every other publisher when `CHANNEL_SIGNING_SECRET`
 * is set. Attach it through {@link KaibanTeamBridge}, or call `attach` yourself
 * with `team.getStore()`.
 */
export class DistributedStateMiddleware {
  private redis: Redis;
  private channelName: string;
  private readonly unsubscribers: Array<() => void> = [];
  private subscriber: Redis | null = null;

  constructor(redisUrl: string, channelName = STATE_CHANNEL) {
    this.redis = createRedisClient(redisUrl, { lazyConnect: false });
    this.channelName = channelName;
  }

  /** Subscribe to the store; every change is published as a board delta. */
  public attach(store: ObservableStore): ObservableStore {
    this.unsubscribers.push(
      store.subscribe((state, prev) => {
        const delta = toBoardDelta(state, prev);
        if (Object.keys(delta).length === 0) return;
        this.redis
          .publish(this.channelName, wrapSigned(sanitizeDelta(delta)))
          .catch((err: unknown) => {
            log.error({ err }, "Failed to publish state delta");
          });
      }),
    );
    return store;
  }

  /** Receive the board deltas published on the channel (signature checked). */
  public async listen(
    onStateChange: (delta: Record<string, unknown>) => void,
  ): Promise<void> {
    const sub = new Redis(this.redis.options);
    this.subscriber = sub;
    await sub.subscribe(this.channelName);
    sub.on("message", (channel, message) => {
      if (channel !== this.channelName) return;
      const delta = unwrapVerified(message);
      if (delta === null) {
        log.error("Rejected unsigned/invalid or unparsable state message");
        return;
      }
      onStateChange(delta);
    });
  }

  public async disconnect(): Promise<void> {
    for (const stop of this.unsubscribers.splice(0)) stop();
    await this.subscriber?.quit();
    this.subscriber = null;
    await this.redis.quit();
  }
}
