/**
 * Prompt-cache accounting (master plan §B5.1 Phase E, ADR-019).
 *
 * A pure, stateless module that prices a step's token usage with the provider's
 * prompt-cache discount broken out, and reports the effective cache hit rate.
 * No I/O, no shared state — it builds and unit-tests independently against the
 * shared economics contract (`./types`).
 */
import type { CostBreakdown, ModelPricing, TokenUsage } from "./types";

/** Clamp `value` into the inclusive `[min, max]` range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Coerce a possibly-negative/undefined token count to a non-negative number. */
function nonNegative(value: number | undefined): number {
  return value !== undefined && value > 0 ? value : 0;
}

/**
 * Price a step's token usage, applying the provider prompt-cache discount to the
 * cached portion of input tokens and surfacing what the cache saved.
 *
 * Defensive: negative token counts are treated as 0, and `cachedInputTokens`
 * can never exceed `inputTokens` (it is clamped). An undefined `cacheDiscount`
 * means no discount (multiplier 1).
 */
export function priceUsage(
  usage: TokenUsage,
  pricing: ModelPricing,
): CostBreakdown {
  const inputTokens = nonNegative(usage.inputTokens);
  const outputTokens = nonNegative(usage.outputTokens);
  const cached = clamp(nonNegative(usage.cachedInputTokens), 0, inputTokens);
  const uncachedInput = inputTokens - cached;
  const discount = pricing.cacheDiscount ?? 1;

  const inputCost =
    (uncachedInput / 1000) * pricing.inputPer1k +
    (cached / 1000) * pricing.inputPer1k * discount;
  const outputCost = (outputTokens / 1000) * pricing.outputPer1k;

  return {
    costUnits: Math.round(inputCost + outputCost),
    cacheSavings: Math.round(
      (cached / 1000) * pricing.inputPer1k * (1 - discount),
    ),
  };
}

/**
 * Effective prompt-cache hit rate for a step: `cached / inputTokens`, returning
 * 0 when there are no input tokens and clamped into `[0, 1]`.
 */
export function effectiveCacheHitRate(usage: TokenUsage): number {
  const inputTokens = nonNegative(usage.inputTokens);
  if (inputTokens === 0) {
    return 0;
  }
  const cached = nonNegative(usage.cachedInputTokens);
  return clamp(cached / inputTokens, 0, 1);
}
