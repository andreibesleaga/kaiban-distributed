import { describe, it, expect } from "vitest";
import type { ModelPricing, TokenUsage } from "../../../src/economics/types";
import {
  priceUsage,
  effectiveCacheHitRate,
} from "../../../src/economics/cache-accounting";

describe("priceUsage", () => {
  it("prices at full rate with zero savings when no cache is reported", () => {
    const usage: TokenUsage = { inputTokens: 1000, outputTokens: 500 };
    const pricing: ModelPricing = {
      inputPer1k: 30,
      outputPer1k: 60,
      cacheDiscount: 0.25,
    };
    // inputCost = (1000/1000)*30 = 30 ; outputCost = (500/1000)*60 = 30
    expect(priceUsage(usage, pricing)).toEqual({
      costUnits: 60,
      cacheSavings: 0,
    });
  });

  it("applies the cache discount to cached input tokens (partial cache)", () => {
    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 400,
    };
    const pricing: ModelPricing = {
      inputPer1k: 30,
      outputPer1k: 60,
      cacheDiscount: 0.25,
    };
    // uncached=600 -> 18 ; cached=400 -> (0.4)*30*0.25 = 3 ; input=21
    // output = (500/1000)*60 = 30 ; total = 51
    // savings = (0.4)*30*(1-0.25) = 9
    expect(priceUsage(usage, pricing)).toEqual({
      costUnits: 51,
      cacheSavings: 9,
    });
  });

  it("treats an undefined cacheDiscount as no discount (multiplier 1)", () => {
    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 0,
      cachedInputTokens: 400,
    };
    const pricing: ModelPricing = { inputPer1k: 30, outputPer1k: 60 };
    // discount = 1 ; inputCost = (600/1000)*30 + (400/1000)*30*1 = 18 + 12 = 30
    // savings = (0.4)*30*(1-1) = 0
    expect(priceUsage(usage, pricing)).toEqual({
      costUnits: 30,
      cacheSavings: 0,
    });
  });

  it("clamps cached input tokens to the reported input tokens", () => {
    const usage: TokenUsage = {
      inputTokens: 500,
      outputTokens: 0,
      cachedInputTokens: 900,
    };
    const pricing: ModelPricing = {
      inputPer1k: 100,
      outputPer1k: 0,
      cacheDiscount: 0.5,
    };
    // cached clamped to 500 ; uncached = 0
    // inputCost = 0 + (500/1000)*100*0.5 = 25 ; savings = (0.5)*100*0.5 = 25
    expect(priceUsage(usage, pricing)).toEqual({
      costUnits: 25,
      cacheSavings: 25,
    });
  });

  it("clamps negative token counts to zero", () => {
    const usage: TokenUsage = {
      inputTokens: -100,
      outputTokens: -50,
      cachedInputTokens: -10,
    };
    const pricing: ModelPricing = {
      inputPer1k: 30,
      outputPer1k: 60,
      cacheDiscount: 0.25,
    };
    expect(priceUsage(usage, pricing)).toEqual({
      costUnits: 0,
      cacheSavings: 0,
    });
  });

  it("rounds fractional input and savings cost to the nearest unit", () => {
    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 0,
      cachedInputTokens: 333,
    };
    const pricing: ModelPricing = {
      inputPer1k: 10,
      outputPer1k: 0,
      cacheDiscount: 0.5,
    };
    // uncached=667 -> 6.67 ; cached=333 -> (0.333)*10*0.5 = 1.665 ; input = 8.335
    // costUnits = round(8.335) = 8 ; savings = round(1.665) = 2
    expect(priceUsage(usage, pricing)).toEqual({
      costUnits: 8,
      cacheSavings: 2,
    });
  });

  it("returns zero cost for zero-token usage", () => {
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const pricing: ModelPricing = { inputPer1k: 30, outputPer1k: 60 };
    expect(priceUsage(usage, pricing)).toEqual({
      costUnits: 0,
      cacheSavings: 0,
    });
  });
});

describe("effectiveCacheHitRate", () => {
  it("returns cached / inputTokens", () => {
    expect(
      effectiveCacheHitRate({
        inputTokens: 1000,
        outputTokens: 0,
        cachedInputTokens: 400,
      }),
    ).toBe(0.4);
  });

  it("returns 0 when inputTokens is 0 (divide-by-zero guard)", () => {
    expect(
      effectiveCacheHitRate({
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
      }),
    ).toBe(0);
  });

  it("clamps the rate to 1 when cached exceeds input", () => {
    expect(
      effectiveCacheHitRate({
        inputTokens: 500,
        outputTokens: 0,
        cachedInputTokens: 900,
      }),
    ).toBe(1);
  });

  it("returns 0 when inputTokens is negative (clamped to 0)", () => {
    expect(
      effectiveCacheHitRate({
        inputTokens: -100,
        outputTokens: 0,
        cachedInputTokens: 50,
      }),
    ).toBe(0);
  });

  it("returns 0 when cachedInputTokens is undefined", () => {
    expect(effectiveCacheHitRate({ inputTokens: 1000, outputTokens: 0 })).toBe(
      0,
    );
  });

  it("clamps negative cachedInputTokens to 0", () => {
    expect(
      effectiveCacheHitRate({
        inputTokens: 1000,
        outputTokens: 0,
        cachedInputTokens: -50,
      }),
    ).toBe(0);
  });
});
