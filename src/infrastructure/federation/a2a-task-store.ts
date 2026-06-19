/**
 * RedisTaskStore — a Redis-backed implementation of the @a2a-js/sdk `TaskStore`.
 *
 * Replaces the SDK's `InMemoryTaskStore` so that `tasks/get` and `tasks/cancel`
 * survive a gateway restart and are visible across a horizontally-scaled gateway
 * pool. Each A2A `Task` is persisted under a namespaced key with a bounded TTL so
 * terminal tasks are eventually reclaimed (the store is a cache of task lifecycle
 * state, not the system of record — that remains the messaging layer).
 *
 * The SDK `TaskStore` interface is intentionally tiny (`save` / `load`); this class
 * implements exactly that surface plus a `close()` for lifecycle management.
 */
import { Redis } from "ioredis";
import type { Task } from "@a2a-js/sdk";
import type { TaskStore } from "@a2a-js/sdk/server";

/** Key namespace for persisted A2A tasks. */
const KEY_PREFIX = "a2a-task:";

/** Default TTL: tasks linger 24h after their last write, then expire. */
const DEFAULT_TTL_SECONDS = 86_400;

export interface RedisTaskStoreOptions {
  /** Seconds before a persisted task expires (refreshed on every save). */
  ttlSeconds?: number;
}

/** The minimal ioredis surface this store depends on. */
interface RedisLike {
  set(
    key: string,
    value: string,
    mode: "EX",
    ttl: number,
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  quit(): Promise<unknown>;
}

export class RedisTaskStore implements TaskStore {
  private readonly redis: RedisLike;
  private readonly ownsClient: boolean;
  private readonly ttlSeconds: number;

  constructor(
    redis: RedisLike | string,
    options: RedisTaskStoreOptions = {},
  ) {
    if (typeof redis === "string") {
      this.redis = new Redis(redis) as unknown as RedisLike;
      this.ownsClient = true;
    } else {
      this.redis = redis;
      this.ownsClient = false;
    }
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  private key(taskId: string): string {
    return `${KEY_PREFIX}${taskId}`;
  }

  async save(task: Task): Promise<void> {
    await this.redis.set(
      this.key(task.id),
      JSON.stringify(task),
      "EX",
      this.ttlSeconds,
    );
  }

  async load(taskId: string): Promise<Task | undefined> {
    const raw = await this.redis.get(this.key(taskId));
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as Task;
    } catch {
      // A corrupt entry is treated as absent rather than crashing the read path.
      return undefined;
    }
  }

  /** Disconnect the Redis client — only if this store created it. */
  async close(): Promise<void> {
    if (this.ownsClient) await this.redis.quit();
  }
}
