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
 *   - Workflow spend (running totals + stop record) is saved with every
 *     checkpoint, in one reserved entry (`__workflow_spend__`) of the same
 *     record, and restored once when a fresh instance first loads it — so a
 *     restart neither resets the cost cap nor charges replayed steps again.
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
import {
  BudgetExceededError,
  cleanSpendAmount,
  cleanSpendTotals,
  overBudgetReason,
  workflowBudgetFromEnv,
  type SpendTotals,
  type WorkflowBudget,
} from "./budget";
import { createStructuredLogger } from "./structured-logger";

const log = createStructuredLogger({ component: "WorkflowOrchestrator" });

/**
 * Reserved checkpoint entry that carries the workflow spend. It lives in the
 * same record as the steps (one atomic save, same TTL, wiped by `clear()`),
 * is stripped from the step map on load, and cannot be used as a step name
 * (`runStep` / `memoize` throw for `__workflow_spend__`).
 */
const SPEND_ENTRY = "__workflow_spend__";

/** The persisted form of the workflow spend (the reserved entry's `result`). */
interface PersistedSpend extends SpendTotals {
  stop: { reason: WorkflowStopReason; detail: string } | null;
}

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
 * per instance (on the first step, `isResuming()` or `recordSpend()`) and
 * writes after each completed step and after each `recordSpend()` (in the
 * background). The record it saves also holds one reserved entry
 * (`__workflow_spend__`) with the workflow spend; a store persists it like any
 * other entry. An older 2.0.x reading such a record sees that entry as one more
 * completed step, so clear the checkpoint before downgrading.
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

/** Why the orchestrator stopped dispatching (the only reason today). */
export type WorkflowStopReason = "budget_exceeded";

/** The orchestrator's stop record, once a cap has been reached. */
export interface WorkflowStop {
  reason: WorkflowStopReason;
  /** Human-readable detail, e.g. `cost budget exceeded ($0.5120 >= $0.50)`. */
  detail: string;
  totals: SpendTotals;
}

export interface WorkflowOrchestratorOptions {
  /** Stable identifier for this workflow run (the checkpoint namespace key). */
  workflowId: string;
  /** The completion router that resolves task results by `taskId`. */
  router: RouterLike;
  /** Where checkpoints are persisted (Redis in production). */
  store: CheckpointStore;
  /**
   * Workflow spend ceilings. Default: `workflowBudgetFromEnv()` —
   * `MAX_WORKFLOW_COST_USD` (0.50 USD when unset) and `MAX_WORKFLOW_TOKENS`
   * (unlimited when unset); the literal env value `unlimited` removes a ceiling.
   * On resume the restored spend is checked against THIS budget: a larger cap
   * lets a stopped workflow continue, the same cap keeps it stopped.
   */
  budget?: WorkflowBudget;
  /**
   * Extract the spend of a step result (the raw completion string of `runStep`,
   * or the value a `memoize` producer returned). Default: the structured
   * handler-result shape (`inputTokens` + `outputTokens`, `estimatedCost`), as
   * a JSON string or an object; anything else counts as zero spend. Whatever
   * it returns is cleaned before it is added: a non-finite or negative number
   * counts as 0, so a custom extractor cannot switch the caps off or lower the
   * spend.
   */
  spendOf?: (result: unknown) => SpendTotals | undefined;
  /**
   * Called once when a ceiling is reached and dispatching stops. Not called
   * again for a stop restored from the checkpoint (it was reported already).
   */
  onStopped?: (stop: WorkflowStop) => void;
}

/**
 * Default spend extractor — understands the KaibanJS handler-result shape. A
 * non-finite, negative or missing field counts as 0.
 */
export function spendOfHandlerResult(result: unknown): SpendTotals | undefined {
  let value: unknown = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (!("inputTokens" in r) && !("outputTokens" in r) && !("estimatedCost" in r)) {
    return undefined;
  }
  return {
    totalTokens:
      cleanSpendAmount(r["inputTokens"]) + cleanSpendAmount(r["outputTokens"]),
    estimatedCost: cleanSpendAmount(r["estimatedCost"]),
  };
}

export class WorkflowOrchestrator {
  private readonly workflowId: string;
  private readonly router: RouterLike;
  private readonly store: CheckpointStore;
  private readonly budget: WorkflowBudget;
  private readonly spendOf: (result: unknown) => SpendTotals | undefined;
  private readonly onStopped?: (stop: WorkflowStop) => void;
  /**
   * Running spend of the workflow: what earlier runs saved (restored once on
   * load) plus the steps and `recordSpend` calls of this instance.
   */
  private readonly totals: SpendTotals = { totalTokens: 0, estimatedCost: 0 };
  private stop: WorkflowStop | null = null;
  /** In-memory mirror of the persisted steps (spend entry stripped). */
  private checkpoint: WorkflowCheckpoint = {};
  /** The one load of the checkpoint (reset when it fails, so it is retried). */
  private loading: Promise<void> | null = null;
  /** Saves run one at a time, in call order (each writes the full record). */
  private saveChain: Promise<void> = Promise.resolve();
  /** Set by `clear()`: nothing is saved again until a new step completes. */
  private cleared = false;
  /** Bumped by `clear()`: a load that started before it discards what it read. */
  private generation = 0;

  constructor(opts: WorkflowOrchestratorOptions) {
    this.workflowId = opts.workflowId;
    this.router = opts.router;
    this.store = opts.store;
    this.budget = opts.budget ?? workflowBudgetFromEnv();
    this.spendOf = opts.spendOf ?? spendOfHandlerResult;
    this.onStopped = opts.onStopped;
  }

  /**
   * Running spend totals of the workflow (restored spend included once the
   * checkpoint has been loaded by a step, `isResuming()` or `recordSpend`;
   * reset to zero by `clear()`).
   */
  getSpend(): SpendTotals {
    return { ...this.totals };
  }

  /** The stop record once a ceiling has been reached, else `null` (reset by `clear()`). */
  getStop(): WorkflowStop | null {
    return this.stop;
  }

  /**
   * Add spend to the running totals (callers that aggregate outside the
   * orchestrator feed it here) and stop dispatching once a ceiling is reached.
   * A non-finite or negative field counts as 0 (it can neither switch the caps
   * off nor lower the spend). The new totals are saved with the checkpoint in the background (a failed
   * save is logged; the next step's save carries them again). After `clear()`
   * they stay in memory until a new step is saved with them.
   */
  recordSpend(delta: SpendTotals): void {
    this.addSpend(delta);
    this.persist().catch((err: unknown) =>
      log.warn(
        { err, workflowId: this.workflowId },
        "Failed to save the workflow spend — the next checkpoint save retries it",
      ),
    );
  }

  /** Add to the totals (cleaned) and stop once a ceiling is reached (no save). */
  private addSpend(delta: SpendTotals): void {
    const clean = cleanSpendTotals(delta);
    this.totals.totalTokens += clean.totalTokens;
    this.totals.estimatedCost += clean.estimatedCost;
    this.checkStop();
  }

  private checkStop(): void {
    if (this.stop) return;
    const detail = overBudgetReason(this.totals, this.budget);
    if (detail) {
      this.stop = { reason: "budget_exceeded", detail, totals: this.getSpend() };
      // A throwing callback must not abort the step that was just paid for
      // (it is saved after this) or a load (which would then run twice).
      try {
        this.onStopped?.(this.stop);
      } catch (err: unknown) {
        log.warn(
          { err, workflowId: this.workflowId },
          "onStopped callback threw — ignored, the workflow stays stopped",
        );
      }
    }
  }

  /** Refuse to dispatch (or produce) once the workflow is stopped. */
  private assertDispatchAllowed(): void {
    if (this.stop) {
      throw new BudgetExceededError(
        `workflow ${this.workflowId} stopped: ${this.stop.detail}`,
        this.stop.reason,
      );
    }
  }

  private account(result: unknown): void {
    const spend = this.spendOf(result);
    if (spend) this.addSpend(spend);
  }

  /** The spend entry would be overwritten by a step of the same name. */
  private assertStepName(name: string): void {
    if (name === SPEND_ENTRY) {
      throw new Error(`step name "${SPEND_ENTRY}" is reserved for the workflow spend`);
    }
  }

  /**
   * Load for a step. A step that was waiting for the first load when `clear()`
   * ran belongs to the finished run: it throws instead of dispatching after the
   * reset (a step called after `clear()` starts a fresh record as before).
   */
  private async loadForStep(name: string): Promise<WorkflowCheckpoint> {
    const generation = this.generation;
    const cp = await this.ensureLoaded();
    if (generation !== this.generation) {
      throw new Error(
        `step "${name}" not started: the workflow checkpoint was cleared while it waited to load`,
      );
    }
    return cp;
  }

  private async ensureLoaded(): Promise<WorkflowCheckpoint> {
    if (!this.loading) {
      const loading: Promise<void> = this.load().catch((err: unknown) => {
        // `clear()` replaced this load (and reset the instance) while it was in
        // flight: its failure is discarded like its result would be, so it
        // neither re-arms a reload nor undoes the reset.
        if (this.loading !== loading) return;
        this.loading = null; // a failed load is retried by the next call
        throw err;
      });
      this.loading = loading;
    }
    await this.loading;
    return this.checkpoint;
  }

  /** Load the steps and restore the saved spend — runs once per instance. */
  private async load(): Promise<void> {
    const generation = this.generation;
    const record = await this.store.load(this.workflowId);
    if (generation !== this.generation) return; // `clear()` ran meanwhile
    const { [SPEND_ENTRY]: spendEntry, ...steps } = record ?? {};
    this.checkpoint = steps;
    const saved = parsePersistedSpend(spendEntry);
    this.totals.totalTokens += saved.totalTokens;
    this.totals.estimatedCost += saved.estimatedCost;
    // A saved stop is kept while the restored totals still breach the current
    // budget (reported already, so no second onStopped); a larger cap lifts it.
    const detail = overBudgetReason(this.totals, this.budget);
    if (!this.stop && saved.stop && detail) {
      this.stop = { reason: saved.stop.reason, detail, totals: this.getSpend() };
    }
    this.checkStop();
  }

  /** The record to save: the steps plus the reserved spend entry. */
  private snapshot(): WorkflowCheckpoint {
    const spend: PersistedSpend = {
      ...this.getSpend(),
      stop: this.stop ? { reason: this.stop.reason, detail: this.stop.detail } : null,
    };
    return {
      ...this.checkpoint,
      [SPEND_ENTRY]: { taskId: SPEND_ENTRY, result: JSON.stringify(spend) },
    };
  }

  /**
   * Save steps + spend after any save already in flight (call order kept).
   * After `clear()` a save is skipped while no new step has completed, so a
   * late `recordSpend()` or a step that was in flight cannot bring the record
   * back.
   */
  private persist(): Promise<void> {
    const save = async (): Promise<void> => {
      await this.ensureLoaded();
      if (this.cleared && Object.keys(this.checkpoint).length === 0) return;
      await this.store.save(this.workflowId, this.snapshot());
    };
    const next = this.saveChain.then(save); // saveChain itself never rejects
    this.saveChain = next.catch(() => undefined);
    return next;
  }

  /**
   * True if a prior checkpoint holds at least one completed step (i.e. this run
   * is resuming after a crash). A record that holds only the spend entry (a
   * `recordSpend()` before any step) does not count, though its spend and stop
   * are still restored.
   */
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
   *
   * The step name `__workflow_spend__` is reserved for the workflow spend
   * entry and throws (in `memoize` too).
   */
  async runStep(name: string, opts: RunStepOptions): Promise<string> {
    this.assertStepName(name);
    const cp = await this.loadForStep(name);

    const existing = cp[name];
    if (existing) return existing.result;

    // Workflow cap: once a ceiling is reached nothing more is dispatched
    // (checkpointed steps above cost nothing and are still replayed).
    this.assertDispatchAllowed();
    const taskId = await opts.dispatch();

    // Idempotency: if any prior step already resolved this taskId, reuse it
    // rather than waiting again (at-least-once → idempotent consumer, I3) —
    // and do not account it again.
    let result = this.findByTaskId(cp, taskId);
    if (result === undefined) {
      result = await this.router.wait(
        taskId,
        opts.timeoutMs,
        opts.label ?? name,
        opts.signal,
      );
      // Account BEFORE the save: if it rejects, the step is cached in memory
      // and a retry replays it for free — so its spend must already count.
      this.account(result);
    }

    cp[name] = { taskId, result };
    await this.persist();
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
    this.assertStepName(name);
    const cp = await this.loadForStep(name);

    const existing = cp[name];
    if (existing) return JSON.parse(existing.result) as T;

    this.assertDispatchAllowed();
    const value = await produce();

    cp[name] = { taskId: `memoize:${name}`, result: JSON.stringify(value) };
    this.account(value); // before the save — see runStep
    await this.persist();
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

  /**
   * Wipe the checkpoint (steps and saved spend) — call once the workflow
   * reaches a terminal state. Waits for the saves already queued so they
   * cannot re-create the record, then resets this instance to an empty run:
   * no steps, zero totals, no stop record. A checkpoint load still in flight
   * is discarded, whether it succeeds or fails (no reload, no second count).
   *
   * Timing: the reset happens when those queued saves have finished, not when
   * `clear()` is called, and before `store.clear` runs. Spend recorded between
   * calling `clear()` and that reset is wiped with the rest; spend recorded
   * after it (while `clear()` has not yet resolved) stays in memory. Read
   * `getSpend()` / `getStop()` BEFORE calling `clear()` if you need them.
   * Afterwards nothing is saved until a new step completes: a `recordSpend()`,
   * or a step that was already in flight, only updates memory; a new step
   * starts a fresh record.
   */
  async clear(): Promise<void> {
    // Runs in the save chain: saves queued before it finish first, saves
    // queued after it (a new step) land after the delete.
    const wipe = this.saveChain.then(async () => {
      this.generation += 1; // a load still in flight discards what it read
      this.cleared = true;
      this.checkpoint = {};
      this.totals.totalTokens = 0;
      this.totals.estimatedCost = 0;
      this.stop = null;
      this.loading = Promise.resolve();
      await this.store.clear(this.workflowId);
    });
    this.saveChain = wipe.catch(() => undefined);
    await wipe;
  }
}

/**
 * Read the reserved spend entry; anything missing, malformed or negative
 * counts as zero (a restored value can only tighten the cap, never loosen it).
 */
function parsePersistedSpend(entry: StepCheckpoint | undefined): PersistedSpend {
  let raw: Record<string, unknown> | null = null;
  try {
    raw = JSON.parse(entry?.result ?? "null") as Record<string, unknown> | null;
  } catch {
    // Corrupt entry → no restored spend (same policy as a corrupt checkpoint).
  }
  const stop = raw?.["stop"] as Record<string, unknown> | null | undefined;
  return {
    totalTokens: cleanSpendAmount(raw?.["totalTokens"]),
    estimatedCost: cleanSpendAmount(raw?.["estimatedCost"]),
    stop:
      stop?.["reason"] === "budget_exceeded"
        ? { reason: "budget_exceeded", detail: String(stop["detail"] ?? "") }
        : null,
  };
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
