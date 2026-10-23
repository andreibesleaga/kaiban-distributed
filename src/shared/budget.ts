/**
 * Spend caps — the single place the budget environment variables are parsed.
 *
 * Four caps, each read by {@link resolveSpendCaps} / {@link workflowBudgetFromEnv}:
 *
 *   MAX_WORKFLOW_COST_USD  cumulative estimated-USD ceiling for one workflow
 *                          (enforced by `WorkflowOrchestrator`)        default 0.50
 *   MAX_WORKFLOW_TOKENS    cumulative token ceiling for one workflow    default unlimited
 *   MAX_TOKEN_BUDGET       cumulative tokens per agent process
 *                          (enforced by `AgentStatePublisher`)          default 200 000
 *   MAX_TASK_TOKEN_BUDGET  tokens one task may consume (all attempts)   default 50 000
 *
 * Parsing rules (identical for every cap):
 *   - unset / empty            → the default above
 *   - a positive number        → that value
 *   - the literal `unlimited`  → no cap (`Infinity`); case-insensitive — the ONLY opt-out
 *   - `0`, negative, garbage   → the default, plus ONE warning per variable. `0` no
 *                                longer means unlimited: an accidental `0` used to
 *                                remove every ceiling, now it cannot.
 *
 * A breach raises {@link BudgetExceededError}, which is a `NonRetryableError`: the
 * actor dead-letters the task after a single attempt instead of retrying it.
 */
import { NonRetryableError } from "../domain/errors/DomainError";
import { createStructuredLogger } from "./structured-logger";

const log = createStructuredLogger({ component: "budget" });

/** Default workflow cost ceiling (USD) when `MAX_WORKFLOW_COST_USD` is unset. */
export const DEFAULT_MAX_WORKFLOW_COST_USD = 0.5;
/** Default per-agent token ceiling when `MAX_TOKEN_BUDGET` is unset. */
export const DEFAULT_MAX_TOKEN_BUDGET = 200_000;
/** Default per-task token ceiling when `MAX_TASK_TOKEN_BUDGET` is unset. */
export const DEFAULT_MAX_TASK_TOKEN_BUDGET = 50_000;
/** The value of a cap that has been removed with the `unlimited` sentinel. */
export const UNLIMITED = Number.POSITIVE_INFINITY;
/** The only env value that removes a cap (matched case-insensitively). */
export const UNLIMITED_SENTINEL = "unlimited";

/** Running spend totals an orchestrator accumulates across phases. */
export interface SpendTotals {
  totalTokens: number;
  estimatedCost: number;
}

/**
 * Clean one spend number (a token count or a USD cost) before it is added to a
 * running total or published: a non-finite, negative or missing value counts
 * as 0, so a bad value can neither switch a cap off (`NaN` never reaches a
 * ceiling) nor lower the spend already counted. Used by every spend path
 * (`AgentStatePublisher`, `WorkflowOrchestrator`, `spendOfHandlerResult`, the
 * restored checkpoint spend).
 */
export function cleanSpendAmount(x: unknown): number {
  let n: number;
  try {
    n = Number(x ?? 0);
  } catch {
    return 0; // a value whose conversion throws (a Symbol, a hostile object) counts as zero
  }
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** {@link cleanSpendAmount} applied to both fields of a spend delta. */
export function cleanSpendTotals(delta: Partial<SpendTotals>): SpendTotals {
  return {
    totalTokens: cleanSpendAmount(delta.totalTokens),
    estimatedCost: cleanSpendAmount(delta.estimatedCost),
  };
}

/** Configured workflow ceilings. `Infinity` = no ceiling. */
export interface WorkflowBudget {
  maxTokens: number;
  maxCostUsd: number;
}

/** All four caps, resolved from the environment. `Infinity` = no cap. */
export interface SpendCaps {
  maxWorkflowCostUsd: number;
  maxWorkflowTokens: number;
  maxTokenBudget: number;
  maxTaskTokenBudget: number;
}

/**
 * Thrown when a cap is reached. Non-retryable: `AgentActor` dead-letters the
 * task after one attempt, with `reasonCode` as the DLQ `error` token.
 */
export class BudgetExceededError extends NonRetryableError {
  readonly code = "BUDGET_EXCEEDED";

  constructor(
    public readonly reason: string,
    public readonly reasonCode: string = "budget_exceeded",
  ) {
    super(reason);
  }
}

const warnedVariables = new Set<string>();

/** Forget which variables already produced a misconfiguration warning (tests). */
export function resetCapWarnings(): void {
  warnedVariables.clear();
}

/** Render a cap for messages: `Infinity` → `unlimited`. */
export function formatCap(cap: number): string {
  return cap === UNLIMITED ? UNLIMITED_SENTINEL : String(cap);
}

/**
 * Parse one cap variable. `name` is only used for the (once-per-variable)
 * warning when the value is `0`, negative or not a number.
 */
export function parseCapEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  const value = raw?.trim() ?? "";
  if (value === "") return fallback;
  if (value.toLowerCase() === UNLIMITED_SENTINEL) return UNLIMITED;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  if (!warnedVariables.has(name)) {
    warnedVariables.add(name);
    log.warn(
      { variable: name, value, fallback: formatCap(fallback) },
      `${name}="${value}" is not a valid cap (0 no longer means unlimited; ` +
        `set the literal value "${UNLIMITED_SENTINEL}" to remove the cap) — using the default`,
    );
  }
  return fallback;
}

/** Resolve all four caps from the environment (see the module header). */
export function resolveSpendCaps(
  env: NodeJS.ProcessEnv = process.env,
): SpendCaps {
  return {
    maxWorkflowCostUsd: parseCapEnv(
      "MAX_WORKFLOW_COST_USD",
      env["MAX_WORKFLOW_COST_USD"],
      DEFAULT_MAX_WORKFLOW_COST_USD,
    ),
    maxWorkflowTokens: parseCapEnv(
      "MAX_WORKFLOW_TOKENS",
      env["MAX_WORKFLOW_TOKENS"],
      UNLIMITED,
    ),
    maxTokenBudget: parseCapEnv(
      "MAX_TOKEN_BUDGET",
      env["MAX_TOKEN_BUDGET"],
      DEFAULT_MAX_TOKEN_BUDGET,
    ),
    maxTaskTokenBudget: parseCapEnv(
      "MAX_TASK_TOKEN_BUDGET",
      env["MAX_TASK_TOKEN_BUDGET"],
      DEFAULT_MAX_TASK_TOKEN_BUDGET,
    ),
  };
}

/** Read the workflow budget from the environment (defaults: 0.50 USD, unlimited tokens). */
export function workflowBudgetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WorkflowBudget {
  const caps = resolveSpendCaps(env);
  return { maxTokens: caps.maxWorkflowTokens, maxCostUsd: caps.maxWorkflowCostUsd };
}

/** A ceiling applies when it is a positive number (`Infinity` never binds). */
function isCapped(ceiling: number): boolean {
  return Number.isFinite(ceiling) && ceiling > 0;
}

/**
 * Returns a human-readable reason when `totals` reach a configured ceiling,
 * or `null` when within budget. A ceiling of `Infinity` (or a non-positive
 * value in a programmatically built budget) never binds.
 */
export function overBudgetReason(
  totals: SpendTotals,
  budget: WorkflowBudget,
): string | null {
  if (isCapped(budget.maxTokens) && totals.totalTokens >= budget.maxTokens) {
    return `token budget exceeded (${totals.totalTokens} >= ${budget.maxTokens})`;
  }
  if (isCapped(budget.maxCostUsd) && totals.estimatedCost >= budget.maxCostUsd) {
    return `cost budget exceeded ($${totals.estimatedCost.toFixed(4)} >= $${budget.maxCostUsd.toFixed(2)})`;
  }
  return null;
}

/** Throws {@link BudgetExceededError} when `totals` reach a configured ceiling. */
export function assertWithinBudget(
  totals: SpendTotals,
  budget: WorkflowBudget,
): void {
  const reason = overBudgetReason(totals, budget);
  if (reason) throw new BudgetExceededError(reason);
}
