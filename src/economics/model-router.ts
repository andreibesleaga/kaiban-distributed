/**
 * Model routing / right-sizing (master plan §B5.1 Phase E, ADR-019).
 *
 * A pure, stateless module that picks the best model for a step from a set of
 * candidates, balancing capability against cost under a budget-pressure dial.
 * No I/O, no shared state — it builds and unit-tests independently against the
 * shared economics contract (`./types`).
 */
import type {
  CostUnits,
  ModelCandidate,
  RoutingDecision,
  RoutingRequest,
} from "./types";

/** Clamp `value` into the inclusive `[min, max]` range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Combined per-1k cost used as a right-sizing proxy (input + output). */
function costProxy(candidate: ModelCandidate): CostUnits {
  return candidate.pricing.inputPer1k + candidate.pricing.outputPer1k;
}

/**
 * Right-sizing score: capability is weighted by `(1 - pressure)` and cost is
 * penalised by `pressure`, so higher budget pressure pulls the pick toward
 * cheaper, smaller models.
 */
function score(candidate: ModelCandidate, pressure: number): number {
  return candidate.capability * (1 - pressure) - costProxy(candidate) * pressure;
}

/** Whether `candidate` satisfies the request's capability + context floor. */
function isEligible(candidate: ModelCandidate, req: RoutingRequest): boolean {
  return (
    candidate.capability >= req.minCapability &&
    candidate.contextWindow >= req.estimatedTokens
  );
}

/**
 * Deterministic ordering: prefer the higher score, then break ties by higher
 * capability, then lower cost proxy, then the lexicographically smallest id.
 * Returns true when `a` should be preferred over `b`.
 */
function preferred(a: ModelCandidate, b: ModelCandidate, pressure: number): boolean {
  const scoreDelta = score(a, pressure) - score(b, pressure);
  if (scoreDelta !== 0) {
    return scoreDelta > 0;
  }
  if (a.capability !== b.capability) {
    return a.capability > b.capability;
  }
  const costDelta = costProxy(a) - costProxy(b);
  if (costDelta !== 0) {
    return costDelta < 0;
  }
  return a.id < b.id;
}

/** Reduce the eligible candidates to the single best pick under `pressure`. */
function pickBest(
  eligible: ModelCandidate[],
  pressure: number,
): ModelCandidate {
  return eligible.reduce((best, candidate) =>
    preferred(candidate, best, pressure) ? candidate : best,
  );
}

/**
 * Route a step to the best eligible model, right-sizing under budget pressure.
 *
 * Filters out candidates that miss the capability/context floor, then picks the
 * highest-scoring survivor with deterministic tie-breaking. Returns a null
 * `modelId` when nothing is eligible.
 */
export function routeModel(
  req: RoutingRequest,
  candidates: ModelCandidate[],
): RoutingDecision {
  const eligible = candidates.filter((candidate) => isEligible(candidate, req));
  if (eligible.length === 0) {
    return {
      modelId: null,
      reason: "no candidate meets capability/context requirements",
    };
  }
  const pressure = clamp(req.budgetPressure, 0, 1);
  const winner = pickBest(eligible, pressure);
  const reason =
    pressure >= 0.5
      ? "right-sized under budget pressure"
      : "capability-first selection";
  return { modelId: winner.id, reason };
}

/**
 * A simple, rounded cost proxy for one step: scale the combined per-1k pricing
 * by the estimated token count. Negative token counts are guarded to 0.
 */
export function estimatedStepCost(
  candidate: ModelCandidate,
  estimatedTokens: number,
): CostUnits {
  const tokens = estimatedTokens > 0 ? estimatedTokens : 0;
  return Math.round((tokens / 1000) * costProxy(candidate));
}
