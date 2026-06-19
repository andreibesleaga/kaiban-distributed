/**
 * Economics / FinOps shared contract (master plan §B5.1 Phase E, ADR-019).
 *
 * The economics layer adds **fleet-wide** cost control on top of the existing
 * per-task token accounting (`AgentStatePublisher.maxTokenBudget`), which it MUST
 * NOT change (§B1.3 COST guard). Everything here is **default-OFF** (invariant #8):
 * unset/`enabled:false` ⇒ admission always `allow` and no limiter is consulted.
 *
 * This module is pure types/contract so the four Phase-E modules
 * (`rate-cost-limiter`, `cost-reservation`, `cache-accounting`, `model-router`)
 * build independently against it.
 */
import type { RateLimiterAbstract } from "rate-limiter-flexible";

/** Cost measured in abstract integer "cost units" (e.g. micro-USD, or tokens). */
export type CostUnits = number;

/**
 * The scopes a single admission decision is checked against. A check binds on the
 * tightest applicable scope: the global ceiling always applies (when configured);
 * `tenantId` / `agentId` add per-tenant / per-agent budgets when present.
 */
export interface BudgetScope {
  tenantId?: string;
  agentId?: string;
}

/**
 * Economics/FinOps configuration. Default-OFF. Any `0` ceiling/limit means
 * "unlimited" for that dimension (so a partially-configured limiter only enforces
 * the dimensions you set).
 */
export interface EconomicsConfig {
  /** Master switch — when false the whole layer is a no-op (admission = allow). */
  enabled: boolean;
  /** Max requests per window per scope (0 = unlimited). */
  maxRequestsPerWindow: number;
  /** Max cost units per window per scope (0 = unlimited). */
  maxCostPerWindow: CostUnits;
  /** Global cost-unit ceiling across ALL scopes per window (0 = unlimited). */
  globalCostCeiling: CostUnits;
  /** Sliding window length, seconds. */
  windowSeconds: number;
  /** Utilization fraction (0..1) at/after which to DEGRADE rather than allow-full. */
  degradeThreshold: number;
}

/** A single underlying-limiter reservation/consume outcome. */
export interface LimiterReservation {
  /** True when the consume stayed within budget (false ⇒ over budget). */
  ok: boolean;
  /** Remaining cost units (or requests) in the tightest binding scope. */
  remaining: number;
  /** Consumed / limit in the tightest binding scope (0..1; 0 when unlimited). */
  utilization: number;
}

/**
 * What `cost-reservation` consumes from `rate-cost-limiter` (a port, so the two
 * modules build and unit-test independently — reservation against a fake port,
 * the limiter against `RateLimiterMemory`).
 */
export interface CostLimiterPort {
  /** Consume one request against the rate limit for `scope`. */
  consumeRequest(scope: BudgetScope): Promise<LimiterReservation>;
  /** Reserve `units` of cost for `scope` (global + tenant + agent as configured). */
  reserveCost(scope: BudgetScope, units: CostUnits): Promise<LimiterReservation>;
  /** Release a prior cost reservation (compensation when a step is not run). */
  releaseCost(scope: BudgetScope, units: CostUnits): Promise<void>;
}

/**
 * Factory that builds one underlying limiter. Prod injects a `RateLimiterRedis`
 * factory (shared `storeClient`); tests inject a `RateLimiterMemory` factory.
 */
export type RateLimiterFactory = (opts: {
  keyPrefix: string;
  points: number;
  durationSeconds: number;
}) => RateLimiterAbstract;

/** Admission-control verdict for a step, decided BEFORE execution. */
export type AdmissionDecision = "allow" | "degrade" | "reject";

export interface AdmissionResult {
  decision: AdmissionDecision;
  /** Remaining cost units in the tightest binding scope after the check. */
  remaining: number;
  /** Utilization (0..1) in the tightest binding scope. */
  utilization: number;
  reason: string;
}

/** Token usage for a step (mirrors OTel GenAI `gen_ai.usage.*`). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Portion of `inputTokens` served from the provider's prompt cache (discounted). */
  cachedInputTokens?: number;
}

/** Per-1K-token pricing in cost units, plus the prompt-cache discount multiplier. */
export interface ModelPricing {
  /** Cost units per 1K input tokens. */
  inputPer1k: CostUnits;
  /** Cost units per 1K output tokens. */
  outputPer1k: CostUnits;
  /** Multiplier (0..1) applied to cached input tokens (e.g. 0.25 = 75% off). Default 1. */
  cacheDiscount?: number;
}

/** Result of pricing a step's usage, with the cache saving broken out. */
export interface CostBreakdown {
  /** Total cost units after the cache discount. */
  costUnits: CostUnits;
  /** Cost units saved by the prompt cache vs pricing every input token at full rate. */
  cacheSavings: CostUnits;
}

/** A model the router may pick from (right-sizing). */
export interface ModelCandidate {
  id: string;
  pricing: ModelPricing;
  /** Relative capability score (higher = more capable). */
  capability: number;
  /** Max context window (tokens). */
  contextWindow: number;
}

/** A model-routing request. */
export interface RoutingRequest {
  /** Minimum capability the task needs. */
  minCapability: number;
  /** Estimated total tokens (input+output) — candidates must fit their context window. */
  estimatedTokens: number;
  /** Budget pressure (0..1): higher ⇒ prefer cheaper models (right-sizing). */
  budgetPressure: number;
}

export interface RoutingDecision {
  /** Chosen model id, or null when no candidate satisfies the requirements. */
  modelId: string | null;
  reason: string;
}
