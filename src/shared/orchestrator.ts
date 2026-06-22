/**
 * WorkflowOrchestrator — reusable, crash-safe, single-active orchestrator.
 *
 * Promoted to core from the example orchestrators (master plan §B5.1 Phase R,
 * ADR-018). It drives a multi-step workflow over the `CompletionRouter`, with
 * **Redis checkpoint→resume** and **`taskId` idempotency**:
 *
 *   - Each step dispatches a task (returning its `taskId`), then awaits the
 *     result via `router.wait(taskId, …)`.
 *   - On success the step's `{ taskId, result }` is persisted to a namespaced
 *     checkpoint key. On restart, a checkpointed step is **replayed from the
 *     checkpoint** — never re-dispatched — so a crash mid-workflow resumes from
 *     the last completed step instead of re-running (and re-paying for) it.
 *   - Dedup is by `taskId` (I3): if two steps dispatch the same `taskId`, the
 *     second reuses the first result instead of waiting twice (at-least-once
 *     delivery → idempotent consumer).
 *
 * ## Caveat — single-active, NOT highly-available
 * This is a **single-active** orchestrator: there is **no leader election** in
 * v2.0. Exactly one orchestrator instance must run at a time. Failover is by
 * **checkpoint** (a fresh instance resumes from Redis), NOT by hot standby —
 * HA / leader-election is roadmap. The "no centralized bottleneck" guarantee
 * applies to the **worker tier** (competing consumers), not to the
 * orchestrator.
 *
 * Invariants preserved: I4 (the orchestrator owns workflow lifecycle; this class
 * never writes `teamWorkflowStatus` — that stays with the state publisher); I5
 * (checkpoints live on a dedicated Redis key, never routed through the durable
 * broker; the result/HITL channels are unchanged); I3 (`taskId` dedup).
 */

import { Redis } from "ioredis";

/** Minimal slice of `CompletionRouter` the orchestrator depends on (testability). */
export interface RouterLike {
  wait(
    taskId: string,
    timeoutMs: number,
    label: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

/** A single completed step's checkpoint record. */
export interface StepCheckpoint {
  taskId: string;
  result: string;
}

/** Per-workflow checkpoint: step name → completed step record. */
export type WorkflowCheckpoint = Record<string, StepCheckpoint>;

/**
 * Pluggable checkpoint persistence. The orchestrator reads the checkpoint once
 * at construction-time of a step run and writes after each completed step.
 */
export interface CheckpointStore {
  /** Load the full checkpoint for a workflow, or null if none exists. */
  load(workflowId: string): Promise<WorkflowCheckpoint | null>;
  /** Persist the full checkpoint for a workflow. */
  save(workflowId: string, checkpoint: WorkflowCheckpoint): Promise<void>;
  /** Remove the checkpoint (call on terminal completion). */
  clear(workflowId: string): Promise<void>;
}

/** Options for a single orchestrated step. */
export interface RunStepOptions {
  /**
   * Dispatches the task and resolves with its `taskId`. Only called when the
   * step is NOT already checkpointed — so resume never re-dispatches.
   */
  dispatch: () => Promise<string>;
  /** Max time to await the result via the router. */
  timeoutMs: number;
  /** Label used in router timeout messages. Defaults to the step name. */
  label?: string;
  /** Optional AbortSignal threaded into `router.wait` (cancellation). */
  signal?: AbortSignal;
}

export interface WorkflowOrchestratorOptions {
  /** Stable identifier for this workflow run (the checkpoint namespace key). */
  workflowId: string;
  /** The completion router that resolves task results by `taskId`. */
  router: RouterLike;
  /** Where checkpoints are persisted (Redis in production). */
  store: CheckpointStore;
}

export class WorkflowOrchestrator {
  private readonly workflowId: string;
  private readonly router: RouterLike;
  private readonly store: CheckpointStore;
  /** In-memory mirror of persisted checkpoints, loaded lazily. */
  private checkpoint: WorkflowCheckpoint | null = null;
  private loaded = false;

  constructor(opts: WorkflowOrchestratorOptions) {
    this.workflowId = opts.workflowId;
    this.router = opts.router;
    this.store = opts.store;
  }

  private async ensureLoaded(): Promise<WorkflowCheckpoint> {
    if (!this.loaded) {
      this.checkpoint = await this.store.load(this.workflowId);
      this.loaded = true;
    }
    return this.checkpoint ?? {};
  }

  /** True if a prior checkpoint exists (i.e. this run is resuming after a crash). */
  async isResuming(): Promise<boolean> {
    const cp = await this.ensureLoaded();
    return Object.keys(cp).length > 0;
  }

  /**
   * Run (or resume) a named step.
   *
   * - If the step is already checkpointed → return the cached result without
   *   dispatching or waiting (crash-safe resume; no double-spend).
   * - If another step already resolved the same `taskId` → reuse that result
   *   (taskId idempotency / dedup, I3).
   * - Otherwise dispatch, await, checkpoint, and return.
   */
  async runStep(name: string, opts: RunStepOptions): Promise<string> {
    const cp = await this.ensureLoaded();

    const existing = cp[name];
    if (existing) return existing.result;

    const taskId = await opts.dispatch();

    // Idempotency: if any prior step already resolved this taskId, reuse it
    // rather than waiting again (at-least-once → idempotent consumer, I3).
    const deduped = this.findByTaskId(cp, taskId);
    const result =
      deduped ??
      (await this.router.wait(
        taskId,
        opts.timeoutMs,
        opts.label ?? name,
        opts.signal,
      ));

    cp[name] = { taskId, result };
    this.checkpoint = cp;
    await this.store.save(this.workflowId, cp);
    return result;
  }

  /**
   * Phase-level checkpoint→resume for a step whose work is NOT a single
   * dispatch+wait (e.g. an example pipeline phase that fans out, parses, and
   * returns a structured object). Runs `produce()` **once**, JSON-checkpoints
   * its result under the step name, and on resume returns the cached value
   * without re-running it (no double-spend). The taskId is the synthetic
   * `memoize:<name>` (these steps are not router-dispatched).
   *
   * This is how the example orchestrators consume the shared orchestrator while
   * keeping their phase functions intact: each phase call is wrapped in
   * `memoize(stepName, () => runXxxPhase(...))`.
   */
  async memoize<T>(name: string, produce: () => Promise<T>): Promise<T> {
    const cp = await this.ensureLoaded();

    const existing = cp[name];
    if (existing) return JSON.parse(existing.result) as T;

    const value = await produce();

    cp[name] = { taskId: `memoize:${name}`, result: JSON.stringify(value) };
    this.checkpoint = cp;
    await this.store.save(this.workflowId, cp);
    return value;
  }

  private findByTaskId(
    cp: WorkflowCheckpoint,
    taskId: string,
  ): string | undefined {
    for (const step of Object.values(cp)) {
      if (step.taskId === taskId) return step.result;
    }
    return undefined;
  }

  /** Wipe the checkpoint — call once the workflow reaches a terminal state. */
  async clear(): Promise<void> {
    this.checkpoint = null;
    this.loaded = true;
    await this.store.clear(this.workflowId);
  }
}

// ── Checkpoint stores ────────────────────────────────────────────────────────

const CHECKPOINT_PREFIX = "kaiban-orchestrator:checkpoint:";
const DEFAULT_TTL_SECONDS = 86_400; // 24h — abandoned checkpoints self-evict.

/** In-memory store — used by tests and ephemeral single-process runs. */
export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly map = new Map<string, WorkflowCheckpoint>();

  load(workflowId: string): Promise<WorkflowCheckpoint | null> {
    const cp = this.map.get(workflowId);
    // Return a deep copy so callers cannot mutate stored state by reference.
    return Promise.resolve(
      cp ? (JSON.parse(JSON.stringify(cp)) as WorkflowCheckpoint) : null,
    );
  }

  save(workflowId: string, checkpoint: WorkflowCheckpoint): Promise<void> {
    this.map.set(
      workflowId,
      JSON.parse(JSON.stringify(checkpoint)) as WorkflowCheckpoint,
    );
    return Promise.resolve();
  }

  clear(workflowId: string): Promise<void> {
    this.map.delete(workflowId);
    return Promise.resolve();
  }
}

export interface RedisCheckpointStoreOptions {
  /** Checkpoint key TTL in seconds (default 24h). */
  ttlSeconds?: number;
}

/**
 * Redis-backed checkpoint store. Keys are namespaced under
 * `kaiban-orchestrator:checkpoint:<workflowId>` and carry a TTL so abandoned
 * runs self-evict. This is a plain key — NOT the durable broker — so the I5
 * channel-split invariant is unaffected.
 */
export class RedisCheckpointStore implements CheckpointStore {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;

  constructor(redisUrl: string, opts?: RedisCheckpointStoreOptions) {
    this.redis = new Redis(redisUrl, { lazyConnect: false });
    this.ttlSeconds = opts?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  private key(workflowId: string): string {
    return `${CHECKPOINT_PREFIX}${workflowId}`;
  }

  async load(workflowId: string): Promise<WorkflowCheckpoint | null> {
    const raw = await this.redis.get(this.key(workflowId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as WorkflowCheckpoint;
    } catch {
      // Corrupt checkpoint → treat as absent (re-run rather than crash-loop).
      return null;
    }
  }

  async save(
    workflowId: string,
    checkpoint: WorkflowCheckpoint,
  ): Promise<void> {
    await this.redis.set(
      this.key(workflowId),
      JSON.stringify(checkpoint),
      "EX",
      this.ttlSeconds,
    );
  }

  async clear(workflowId: string): Promise<void> {
    await this.redis.del(this.key(workflowId));
  }

  /** Close the Redis connection. */
  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}
