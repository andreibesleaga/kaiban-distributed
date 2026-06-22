/**
 * Workflow-level spend guard for the orchestrators.
 *
 * The per-agent `MAX_TOKEN_BUDGET` (see agent-node) caps a single agent call;
 * this caps the WHOLE workflow's cumulative spend, so a runaway (e.g. repeated
 * revisions, or a HITL that never terminates) stops instead of draining the
 * budget. Both limits are opt-in via env; `0` (or unset) means unlimited.
 *
 *   MAX_WORKFLOW_TOKENS    cumulative input+output token ceiling
 *   MAX_WORKFLOW_COST_USD  cumulative estimated-USD ceiling
 *
 * The example orchestrators check the running totals between phases (and before
 * each revision) and, when a ceiling is crossed, stop the workflow gracefully
 * (publishing STOPPED) rather than throwing the generic FAILED path.
 */

/** Running spend totals an orchestrator accumulates across phases. */
export interface SpendTotals {
  totalTokens: number;
  estimatedCost: number;
}

/** Configured ceilings (0 = unlimited). */
export interface WorkflowBudget {
  maxTokens: number;
  maxCostUsd: number;
}

/** Thrown when running totals cross a configured ceiling. */
export class BudgetExceededError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "BudgetExceededError";
  }
}

/** Read the workflow budget from the environment. Non-positive / invalid → unlimited (0). */
export function workflowBudgetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WorkflowBudget {
  const tokens = Number.parseInt(env["MAX_WORKFLOW_TOKENS"] ?? "0", 10);
  const cost = Number.parseFloat(env["MAX_WORKFLOW_COST_USD"] ?? "0");
  return {
    maxTokens: Number.isFinite(tokens) && tokens > 0 ? tokens : 0,
    maxCostUsd: Number.isFinite(cost) && cost > 0 ? cost : 0,
  };
}

/**
 * Returns a human-readable reason when `totals` exceed a configured ceiling,
 * or `null` when within budget. A ceiling of 0 is treated as unlimited.
 */
export function overBudgetReason(
  totals: SpendTotals,
  budget: WorkflowBudget,
): string | null {
  if (budget.maxTokens > 0 && totals.totalTokens > budget.maxTokens) {
    return `token budget exceeded (${totals.totalTokens} > ${budget.maxTokens})`;
  }
  if (budget.maxCostUsd > 0 && totals.estimatedCost > budget.maxCostUsd) {
    return `cost budget exceeded ($${totals.estimatedCost.toFixed(4)} > $${budget.maxCostUsd.toFixed(2)})`;
  }
  return null;
}

/** Throws {@link BudgetExceededError} when `totals` cross a configured ceiling. */
export function assertWithinBudget(
  totals: SpendTotals,
  budget: WorkflowBudget,
): void {
  const reason = overBudgetReason(totals, budget);
  if (reason) throw new BudgetExceededError(reason);
}
