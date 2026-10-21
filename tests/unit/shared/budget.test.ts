/**
 * Workflow-level spend guard — caps cumulative tokens/cost so a runaway
 * (e.g. repeated revisions) stops instead of draining the budget.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../../src/shared/structured-logger", () => ({
  createStructuredLogger: (): typeof mockLog => mockLog,
  logger: mockLog,
  resolveLogLevel: (): string => "silent",
}));

import {
  BudgetExceededError,
  workflowBudgetFromEnv,
  resolveSpendCaps,
  parseCapEnv,
  resetCapWarnings,
  formatCap,
  overBudgetReason,
  assertWithinBudget,
  DEFAULT_MAX_WORKFLOW_COST_USD,
  DEFAULT_MAX_TOKEN_BUDGET,
  DEFAULT_MAX_TASK_TOKEN_BUDGET,
  UNLIMITED,
} from "../../../src/shared/budget";
import { NonRetryableError } from "../../../src/domain/errors/DomainError";

const env = (vars: Record<string, string>): NodeJS.ProcessEnv =>
  vars as NodeJS.ProcessEnv;

beforeEach(() => {
  vi.clearAllMocks();
  resetCapWarnings();
});

describe("parseCapEnv — the single cap parser", () => {
  it("unset or empty → the default, no warning", () => {
    expect(parseCapEnv("X", undefined, 42)).toBe(42);
    expect(parseCapEnv("X", "", 42)).toBe(42);
    expect(parseCapEnv("X", "   ", 42)).toBe(42);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it("a positive number → that value (integers, decimals, surrounding spaces)", () => {
    expect(parseCapEnv("X", "1500", 42)).toBe(1500);
    expect(parseCapEnv("X", "0.25", 42)).toBe(0.25);
    expect(parseCapEnv("X", " 7 ", 42)).toBe(7);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it("the literal `unlimited` (any case) → Infinity, no warning", () => {
    expect(parseCapEnv("X", "unlimited", 42)).toBe(UNLIMITED);
    expect(parseCapEnv("X", "UNLIMITED", 42)).toBe(Number.POSITIVE_INFINITY);
    expect(parseCapEnv("X", " Unlimited ", 42)).toBe(UNLIMITED);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it("`0` is a misconfiguration → the default plus ONE warning per variable", () => {
    expect(parseCapEnv("MAX_TOKEN_BUDGET", "0", 42)).toBe(42);
    expect(parseCapEnv("MAX_TOKEN_BUDGET", "0", 42)).toBe(42);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn.mock.calls[0]?.[0]).toMatchObject({
      variable: "MAX_TOKEN_BUDGET",
      value: "0",
      fallback: "42",
    });
    expect(String(mockLog.warn.mock.calls[0]?.[1])).toContain(
      "0 no longer means unlimited",
    );
    // A different variable warns on its own.
    expect(parseCapEnv("MAX_TASK_TOKEN_BUDGET", "0", 9)).toBe(9);
    expect(mockLog.warn).toHaveBeenCalledTimes(2);
  });

  it("garbage, negative, NaN and Infinity-as-text → the default plus a warning", () => {
    expect(parseCapEnv("A", "lots", 42)).toBe(42);
    expect(parseCapEnv("B", "-5", 42)).toBe(42);
    expect(parseCapEnv("C", "NaN", 42)).toBe(42);
    expect(parseCapEnv("D", "Infinity", 42)).toBe(42);
    expect(mockLog.warn).toHaveBeenCalledTimes(4);
  });

  it("resetCapWarnings() lets the same variable warn again", () => {
    parseCapEnv("X", "0", 1);
    resetCapWarnings();
    parseCapEnv("X", "0", 1);
    expect(mockLog.warn).toHaveBeenCalledTimes(2);
  });

  it("formatCap renders Infinity as `unlimited`", () => {
    expect(formatCap(UNLIMITED)).toBe("unlimited");
    expect(formatCap(200_000)).toBe("200000");
  });
});

describe("resolveSpendCaps — defaults when nothing is set", () => {
  it("unset → 0.50 USD / unlimited workflow tokens / 200 000 per agent / 50 000 per task", () => {
    expect(resolveSpendCaps(env({}))).toEqual({
      maxWorkflowCostUsd: DEFAULT_MAX_WORKFLOW_COST_USD,
      maxWorkflowTokens: UNLIMITED,
      maxTokenBudget: DEFAULT_MAX_TOKEN_BUDGET,
      maxTaskTokenBudget: DEFAULT_MAX_TASK_TOKEN_BUDGET,
    });
    expect(DEFAULT_MAX_WORKFLOW_COST_USD).toBe(0.5);
    expect(DEFAULT_MAX_TOKEN_BUDGET).toBe(200_000);
    expect(DEFAULT_MAX_TASK_TOKEN_BUDGET).toBe(50_000);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it("numeric values are used; `unlimited` removes a cap", () => {
    expect(
      resolveSpendCaps(
        env({
          MAX_WORKFLOW_COST_USD: "2.5",
          MAX_WORKFLOW_TOKENS: "1000000",
          MAX_TOKEN_BUDGET: "unlimited",
          MAX_TASK_TOKEN_BUDGET: "123",
        }),
      ),
    ).toEqual({
      maxWorkflowCostUsd: 2.5,
      maxWorkflowTokens: 1_000_000,
      maxTokenBudget: UNLIMITED,
      maxTaskTokenBudget: 123,
    });
  });

  it("`0` and garbage fall back to the defaults with one warning each", () => {
    expect(
      resolveSpendCaps(
        env({
          MAX_WORKFLOW_COST_USD: "0",
          MAX_WORKFLOW_TOKENS: "0",
          MAX_TOKEN_BUDGET: "abc",
          MAX_TASK_TOKEN_BUDGET: "-1",
        }),
      ),
    ).toEqual({
      maxWorkflowCostUsd: DEFAULT_MAX_WORKFLOW_COST_USD,
      maxWorkflowTokens: UNLIMITED,
      maxTokenBudget: DEFAULT_MAX_TOKEN_BUDGET,
      maxTaskTokenBudget: DEFAULT_MAX_TASK_TOKEN_BUDGET,
    });
    expect(mockLog.warn).toHaveBeenCalledTimes(4);
  });

  it("reads process.env by default", () => {
    const prev = process.env["MAX_TASK_TOKEN_BUDGET"];
    process.env["MAX_TASK_TOKEN_BUDGET"] = "777";
    try {
      expect(resolveSpendCaps().maxTaskTokenBudget).toBe(777);
    } finally {
      if (prev === undefined) delete process.env["MAX_TASK_TOKEN_BUDGET"];
      else process.env["MAX_TASK_TOKEN_BUDGET"] = prev;
    }
  });
});

describe("workflowBudgetFromEnv", () => {
  it("parses positive limits from env", () => {
    const b = workflowBudgetFromEnv(
      env({ MAX_WORKFLOW_TOKENS: "50000", MAX_WORKFLOW_COST_USD: "1.50" }),
    );
    expect(b).toEqual({ maxTokens: 50000, maxCostUsd: 1.5 });
  });

  it("unset → 0.50 USD and unlimited tokens; `unlimited` removes the cost cap", () => {
    expect(workflowBudgetFromEnv(env({}))).toEqual({
      maxTokens: UNLIMITED,
      maxCostUsd: 0.5,
    });
    expect(
      workflowBudgetFromEnv(env({ MAX_WORKFLOW_COST_USD: "unlimited" })),
    ).toEqual({ maxTokens: UNLIMITED, maxCostUsd: UNLIMITED });
  });

  it("`0`, negative and non-numeric are NOT unlimited: defaults + a warning", () => {
    expect(
      workflowBudgetFromEnv(
        env({ MAX_WORKFLOW_TOKENS: "0", MAX_WORKFLOW_COST_USD: "0" }),
      ),
    ).toEqual({ maxTokens: UNLIMITED, maxCostUsd: 0.5 });
    expect(
      workflowBudgetFromEnv(
        env({ MAX_WORKFLOW_TOKENS: "-5", MAX_WORKFLOW_COST_USD: "xyz" }),
      ),
    ).toEqual({ maxTokens: UNLIMITED, maxCostUsd: 0.5 });
    expect(mockLog.warn).toHaveBeenCalledTimes(2); // once per variable
  });
});

describe("BudgetExceededError", () => {
  it("is a NonRetryableError with a stable reasonCode (default budget_exceeded)", () => {
    const e = new BudgetExceededError("over");
    expect(e).toBeInstanceOf(NonRetryableError);
    expect(e.reasonCode).toBe("budget_exceeded");
    expect(e.code).toBe("BUDGET_EXCEEDED");
    expect(e.reason).toBe("over");
    expect(e.message).toBe("over");
    expect(new BudgetExceededError("x", "token_budget_exceeded").reasonCode).toBe(
      "token_budget_exceeded",
    );
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

  it("returns null when both ceilings are unlimited (Infinity, or a programmatic 0)", () => {
    expect(
      overBudgetReason(
        { totalTokens: 9_999_999, estimatedCost: 999 },
        { maxTokens: UNLIMITED, maxCostUsd: UNLIMITED },
      ),
    ).toBeNull();
    expect(
      overBudgetReason(
        { totalTokens: 9_999_999, estimatedCost: 999 },
        { maxTokens: 0, maxCostUsd: 0 },
      ),
    ).toBeNull();
  });

  it("a ceiling binds when the total REACHES it (>=), not only when it is passed", () => {
    expect(
      overBudgetReason(
        { totalTokens: 1000, estimatedCost: 0 },
        { maxTokens: 1000, maxCostUsd: UNLIMITED },
      ),
    ).toContain("token budget exceeded");
    expect(
      overBudgetReason(
        { totalTokens: 0, estimatedCost: 0.5 },
        { maxTokens: UNLIMITED, maxCostUsd: 0.5 },
      ),
    ).toContain("cost budget exceeded");
    expect(
      overBudgetReason(
        { totalTokens: 999, estimatedCost: 0.4999 },
        { maxTokens: 1000, maxCostUsd: 0.5 },
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
