/**
 * Workflow-level spend guard — caps cumulative tokens/cost so a runaway
 * (e.g. repeated revisions) stops instead of draining the budget.
 */
import { describe, it, expect } from "vitest";
import {
  BudgetExceededError,
  workflowBudgetFromEnv,
  overBudgetReason,
  assertWithinBudget,
} from "../../../src/shared/budget";

describe("workflowBudgetFromEnv", () => {
  it("parses positive limits from env", () => {
    const b = workflowBudgetFromEnv({
      MAX_WORKFLOW_TOKENS: "50000",
      MAX_WORKFLOW_COST_USD: "1.50",
    } as NodeJS.ProcessEnv);
    expect(b).toEqual({ maxTokens: 50000, maxCostUsd: 1.5 });
  });

  it("treats unset / zero / negative / non-numeric as unlimited (0)", () => {
    expect(workflowBudgetFromEnv({} as NodeJS.ProcessEnv)).toEqual({
      maxTokens: 0,
      maxCostUsd: 0,
    });
    expect(
      workflowBudgetFromEnv({
        MAX_WORKFLOW_TOKENS: "0",
        MAX_WORKFLOW_COST_USD: "0",
      } as NodeJS.ProcessEnv),
    ).toEqual({ maxTokens: 0, maxCostUsd: 0 });
    expect(
      workflowBudgetFromEnv({
        MAX_WORKFLOW_TOKENS: "-5",
        MAX_WORKFLOW_COST_USD: "-1",
      } as NodeJS.ProcessEnv),
    ).toEqual({ maxTokens: 0, maxCostUsd: 0 });
    expect(
      workflowBudgetFromEnv({
        MAX_WORKFLOW_TOKENS: "abc",
        MAX_WORKFLOW_COST_USD: "xyz",
      } as NodeJS.ProcessEnv),
    ).toEqual({ maxTokens: 0, maxCostUsd: 0 });
  });
});

describe("overBudgetReason", () => {
  it("returns null when within budget", () => {
    expect(
      overBudgetReason(
        { totalTokens: 100, estimatedCost: 0.01 },
        { maxTokens: 1000, maxCostUsd: 1 },
      ),
    ).toBeNull();
  });

  it("returns null when both ceilings are unlimited (0)", () => {
    expect(
      overBudgetReason(
        { totalTokens: 9_999_999, estimatedCost: 999 },
        { maxTokens: 0, maxCostUsd: 0 },
      ),
    ).toBeNull();
  });

  it("flags a token-budget breach", () => {
    const reason = overBudgetReason(
      { totalTokens: 1500, estimatedCost: 0 },
      { maxTokens: 1000, maxCostUsd: 0 },
    );
    expect(reason).toContain("token budget exceeded");
    expect(reason).toContain("1500");
    expect(reason).toContain("1000");
  });

  it("flags a cost-budget breach", () => {
    const reason = overBudgetReason(
      { totalTokens: 0, estimatedCost: 2.5 },
      { maxTokens: 0, maxCostUsd: 1 },
    );
    expect(reason).toContain("cost budget exceeded");
    expect(reason).toContain("$2.5000");
    expect(reason).toContain("$1.00");
  });

  it("checks tokens before cost (token breach reported first)", () => {
    const reason = overBudgetReason(
      { totalTokens: 2000, estimatedCost: 5 },
      { maxTokens: 1000, maxCostUsd: 1 },
    );
    expect(reason).toContain("token budget exceeded");
  });
});

describe("assertWithinBudget", () => {
  it("does not throw when within budget", () => {
    expect(() =>
      assertWithinBudget(
        { totalTokens: 10, estimatedCost: 0.001 },
        { maxTokens: 1000, maxCostUsd: 1 },
      ),
    ).not.toThrow();
  });

  it("throws BudgetExceededError (with reason) when over budget", () => {
    try {
      assertWithinBudget(
        { totalTokens: 5000, estimatedCost: 0 },
        { maxTokens: 1000, maxCostUsd: 0 },
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect((err as BudgetExceededError).name).toBe("BudgetExceededError");
      expect((err as BudgetExceededError).reason).toContain(
        "token budget exceeded",
      );
    }
  });
});
