/**
 * AgentStatusTracker — maintains the last-known status of each agent by
 * subscribing to the `kaiban-state-events` Redis Pub/Sub channel.
 *
 * This de-stubs the A2A `agent.status` surface: instead of a hardcoded "IDLE",
 * the gateway reports the real status an agent last published (IDLE / THINKING /
 * EXECUTING / ERROR). Agents already publish their state to this channel via
 * `AgentStatePublisher`; the tracker is a read-only consumer of that same stream.
 *
 * Invariant I5: this MUST read from Redis Pub/Sub (never the durable broker) so
 * it keeps working identically under any `MESSAGING_DRIVER`. It uses a dedicated
 * subscriber connection and never publishes.
 */
import { Redis } from "ioredis";
import { STATE_CHANNEL } from "../messaging/channels";
import { unwrapVerified } from "../security/channel-signing";
import type { AgentStatus } from "../../domain/entities/DistributedAgentState";

const VALID_STATUSES: ReadonlySet<string> = new Set<AgentStatus>([
  "IDLE",
  "THINKING",
  "EXECUTING",
  "ERROR",
]);

const DEFAULT_STATUS: AgentStatus = "IDLE";

/** The minimal ioredis subscriber surface this tracker depends on. */
interface RedisSubscriber {
  subscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  quit(): Promise<unknown>;
}

export class AgentStatusTracker {
  private readonly redis: RedisSubscriber;
  private readonly ownsClient: boolean;
  private readonly statuses = new Map<string, AgentStatus>();

  constructor(redis: RedisSubscriber | string) {
    if (typeof redis === "string") {
      this.redis = new Redis(redis) as unknown as RedisSubscriber;
      this.ownsClient = true;
    } else {
      this.redis = redis;
      this.ownsClient = false;
    }
  }

  /** Begin consuming agent state deltas. */
  async start(): Promise<void> {
    this.redis.on("message", (channel, message) =>
      this.onMessage(channel, message),
    );
    await this.redis.subscribe(STATE_CHANNEL);
  }

  private onMessage(channel: string, message: string): void {
    if (channel !== STATE_CHANNEL) return;
    const delta = unwrapVerified(message);
    if (!delta) return;
    const agents = delta["agents"];
    if (!Array.isArray(agents)) return;
    for (const entry of agents) {
      this.recordAgent(entry);
    }
  }

  private recordAgent(entry: unknown): void {
    if (entry === null || typeof entry !== "object") return;
    const rec = entry as Record<string, unknown>;
    const agentId = rec["agentId"];
    const status = rec["status"];
    if (typeof agentId !== "string" || typeof status !== "string") return;
    this.statuses.set(
      agentId,
      VALID_STATUSES.has(status) ? (status as AgentStatus) : DEFAULT_STATUS,
    );
  }

  /** Last-known status for an agent, or IDLE if never observed. */
  getStatus(agentId: string): AgentStatus {
    return this.statuses.get(agentId) ?? DEFAULT_STATUS;
  }

  /** Whether any state for this agent has been observed. */
  hasSeen(agentId: string): boolean {
    return this.statuses.has(agentId);
  }

  /** Stop consuming — only quits the Redis client if this tracker created it. */
  async stop(): Promise<void> {
    if (this.ownsClient) await this.redis.quit();
  }
}
