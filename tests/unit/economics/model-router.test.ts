import { describe, it, expect } from "vitest";
import type { ModelCandidate } from "../../../src/economics/types";
import {
  routeModel,
  estimatedStepCost,
} from "../../../src/economics/model-router";

/** Build a candidate with sensible defaults so each test states only what matters. */
function candidate(
  id: string,
  capability: number,
  inputPer1k: number,
  outputPer1k: number,
  contextWindow: number,
): ModelCandidate {
  return {
    id,
    capability,
    contextWindow,
    pricing: { inputPer1k, outputPer1k },
  };
}

describe("routeModel — eligibility", () => {
  it("returns null when every candidate is below the capability floor", () => {
    const candidates: ModelCandidate[] = [
      candidate("weak-a", 0.4, 1, 1, 100_000),
      candidate("weak-b", 0.5, 1, 1, 100_000),
    ];
    expect(
      routeModel(
        { minCapability: 0.6, estimatedTokens: 1000, budgetPressure: 0 },
        candidates,
      ),
    ).toEqual({
      modelId: null,
      reason: "no candidate meets capability/context requirements",
    });
  });

  it("returns null when every candidate's context window is too small", () => {
    const candidates: ModelCandidate[] = [
      candidate("small-a", 0.9, 1, 1, 4_000),
      candidate("small-b", 0.95, 1, 1, 8_000),
    ];
    expect(
      routeModel(
        { minCapability: 0.5, estimatedTokens: 16_000, budgetPressure: 0 },
        candidates,
      ),
    ).toEqual({
      modelId: null,
      reason: "no candidate meets capability/context requirements",
    });
  });

  it("returns null when the candidate list is empty", () => {
    expect(
      routeModel(
        { minCapability: 0.5, estimatedTokens: 1000, budgetPressure: 0 },
        [],
      ),
    ).toEqual({
      modelId: null,
      reason: "no candidate meets capability/context requirements",
    });
  });
});

describe("routeModel — right-sizing regime", () => {
  it("picks the cheaper eligible model under high budget pressure", () => {
    // p = 1 -> score = -costProxy. cheap-fast has the smallest costProxy.
    const candidates: ModelCandidate[] = [
      candidate("flagship", 0.99, 30, 60, 200_000), // costProxy 90
      candidate("cheap-fast", 0.7, 1, 2, 200_000), // costProxy 3
      candidate("mid", 0.85, 5, 10, 200_000), // costProxy 15
    ];
    expect(
      routeModel(
        { minCapability: 0.6, estimatedTokens: 1000, budgetPressure: 1 },
        candidates,
      ),
    ).toEqual({
      modelId: "cheap-fast",
      reason: "right-sized under budget pressure",
    });
  });

  it("picks the more capable eligible model under low budget pressure", () => {
    // p = 0 -> score = capability. flagship wins.
    const candidates: ModelCandidate[] = [
      candidate("flagship", 0.99, 30, 60, 200_000),
      candidate("cheap-fast", 0.7, 1, 2, 200_000),
      candidate("mid", 0.85, 5, 10, 200_000),
    ];
    expect(
      routeModel(
        { minCapability: 0.6, estimatedTokens: 1000, budgetPressure: 0 },
        candidates,
      ),
    ).toEqual({
      modelId: "flagship",
      reason: "capability-first selection",
    });
  });

  it("uses the budget-pressure reason exactly at the p >= 0.5 boundary", () => {
    // p = 0.5 -> score = 0.5*(capability - costProxy). Integer caps/costProxies
    // keep the subtraction exact in binary float so the scores tie cleanly.
    // alpha: 0.5*(8 - 4) = 2 ; beta: 0.5*(6 - 2) = 2 -> tie on score.
    // tie-break: higher capability -> alpha (8 > 6).
    const candidates: ModelCandidate[] = [
      candidate("alpha", 8, 2, 2, 100_000), // costProxy 4
      candidate("beta", 6, 1, 1, 100_000), // costProxy 2
    ];
    expect(
      routeModel(
        { minCapability: 5, estimatedTokens: 1000, budgetPressure: 0.5 },
        candidates,
      ),
    ).toEqual({
      modelId: "alpha",
      reason: "right-sized under budget pressure",
    });
  });
});

describe("routeModel — deterministic tie-break", () => {
  it("breaks an equal score by higher capability", () => {
    // p = 0.5 ; score = 0.5*(capability - costProxy). Integers keep it exact.
    // hi: 0.5*(9 - 5) = 2 ; lo: 0.5*(6 - 2) = 2 -> tie. higher capability -> hi.
    const candidates: ModelCandidate[] = [
      candidate("lo", 6, 1, 1, 100_000), // costProxy 2
      candidate("hi", 9, 2.5, 2.5, 100_000), // costProxy 5
    ];
    expect(
      routeModel(
        { minCapability: 5, estimatedTokens: 1000, budgetPressure: 0.5 },
        candidates,
      ),
    ).toEqual({
      modelId: "hi",
      reason: "right-sized under budget pressure",
    });
  });

  it("keeps the higher-capability incumbent when a lower-capability peer ties on score", () => {
    // hi is FIRST (the reduce seed); lo is compared against it. The capability
    // tie-break must reject lo (lo.capability < hi.capability -> not preferred),
    // exercising the false branch of the higher-capability comparison.
    // p = 0.5 ; score = 0.5*(9 - 5) = 2 ; lo: 0.5*(6 - 2) = 2 -> tie (exact).
    const candidates: ModelCandidate[] = [
      candidate("hi", 9, 2.5, 2.5, 100_000), // costProxy 5
      candidate("lo", 6, 1, 1, 100_000), // costProxy 2
    ];
    expect(
      routeModel(
        { minCapability: 5, estimatedTokens: 1000, budgetPressure: 0.5 },
        candidates,
      ),
    ).toEqual({
      modelId: "hi",
      reason: "right-sized under budget pressure",
    });
  });

  it("breaks an equal score AND equal capability by lower costProxy", () => {
    // identical capability -> scores differ only if costProxy differs, so to get a
    // genuine score+capability tie we need equal costProxy too. Force the score tie
    // with p = 0 (score = capability) so capability ties and costProxy decides.
    const candidates: ModelCandidate[] = [
      candidate("pricey", 0.8, 30, 30, 100_000), // costProxy 60
      candidate("thrifty", 0.8, 5, 5, 100_000), // costProxy 10
    ];
    // p = 0 -> both score 0.8 ; equal capability -> lower costProxy wins -> thrifty.
    expect(
      routeModel(
        { minCapability: 0.5, estimatedTokens: 1000, budgetPressure: 0 },
        candidates,
      ),
    ).toEqual({
      modelId: "thrifty",
      reason: "capability-first selection",
    });
  });

  it("keeps the cheaper incumbent when a pricier equal-score peer is compared", () => {
    // thrifty is FIRST (the reduce seed); pricey is compared against it. The
    // costProxy tie-break must reject pricey (costDelta > 0 -> not preferred),
    // exercising the false branch of the lower-costProxy comparison.
    const candidates: ModelCandidate[] = [
      candidate("thrifty", 0.8, 5, 5, 100_000), // costProxy 10
      candidate("pricey", 0.8, 30, 30, 100_000), // costProxy 60
    ];
    expect(
      routeModel(
        { minCapability: 0.5, estimatedTokens: 1000, budgetPressure: 0 },
        candidates,
      ),
    ).toEqual({
      modelId: "thrifty",
      reason: "capability-first selection",
    });
  });

  it("breaks a full tie (score, capability, costProxy equal) by smallest id", () => {
    // identical everything except id -> lexicographically smallest id wins.
    const candidates: ModelCandidate[] = [
      candidate("zeta", 0.8, 10, 10, 100_000),
      candidate("alpha", 0.8, 10, 10, 100_000),
      candidate("mu", 0.8, 10, 10, 100_000),
    ];
    expect(
      routeModel(
        { minCapability: 0.5, estimatedTokens: 1000, budgetPressure: 0 },
        candidates,
      ),
    ).toEqual({
      modelId: "alpha",
      reason: "capability-first selection",
    });
  });
});

describe("routeModel — budgetPressure clamping", () => {
  it("treats budgetPressure > 1 as 1 (behaves like maximum pressure)", () => {
    // p clamped to 1 -> score = -costProxy -> cheapest wins, and p >= 0.5 reason.
    const candidates: ModelCandidate[] = [
      candidate("flagship", 0.99, 30, 60, 200_000),
      candidate("cheap-fast", 0.7, 1, 2, 200_000),
    ];
    expect(
      routeModel(
        { minCapability: 0.6, estimatedTokens: 1000, budgetPressure: 2 },
        candidates,
      ),
    ).toEqual({
      modelId: "cheap-fast",
      reason: "right-sized under budget pressure",
    });
  });

  it("treats negative budgetPressure as 0 (behaves like no pressure)", () => {
    // p clamped to 0 -> score = capability -> most capable wins, capability-first reason.
    const candidates: ModelCandidate[] = [
      candidate("flagship", 0.99, 30, 60, 200_000),
      candidate("cheap-fast", 0.7, 1, 2, 200_000),
    ];
    expect(
      routeModel(
        { minCapability: 0.6, estimatedTokens: 1000, budgetPressure: -3 },
        candidates,
      ),
    ).toEqual({
      modelId: "flagship",
      reason: "capability-first selection",
    });
  });
});

describe("estimatedStepCost", () => {
  it("computes a rounded proxy from tokens and combined per-1k pricing", () => {
    const model = candidate("m", 0.8, 30, 60, 100_000); // sum 90
    // (2000/1000) * 90 = 180
    expect(estimatedStepCost(model, 2000)).toBe(180);
  });

  it("rounds the fractional proxy to the nearest unit", () => {
    const model = candidate("m", 0.8, 10, 5, 100_000); // sum 15
    // (1500/1000) * 15 = 22.5 -> round -> 23 (round-half-up)
    expect(estimatedStepCost(model, 1500)).toBe(23);
  });

  it("guards negative token counts to 0", () => {
    const model = candidate("m", 0.8, 30, 60, 100_000);
    expect(estimatedStepCost(model, -1000)).toBe(0);
  });

  it("returns 0 for zero tokens", () => {
    const model = candidate("m", 0.8, 30, 60, 100_000);
    expect(estimatedStepCost(model, 0)).toBe(0);
  });
});
