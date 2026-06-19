# ADR-019 — Economics / FinOps layer (fleet-wide cost control)

- **Status:** Accepted
- **Date:** 2026-06-19
- **Refs:** `KAIBAN-v2.0-MASTER-PLAN.md` §B5.1 Phase E + §B1.3 (COST NFR guard); §B8 BETA.3

## Context
The runtime already does **per-task** token accounting (`AgentStatePublisher.maxTokenBudget`) and shows
it on the board economics panel. v2.0 adds **fleet-wide** cost control: a global/per-tenant/per-agent
rate + cost limiter, pre-exec admission control, prompt-cache accounting, and model right-sizing — to
discharge the on-record ASVS "global cross-agent rate limit" and keep spend bounded across the whole
deployment. The §B1.3 **COST guard** is hard: this layer must **not** change the existing per-task
accounting or the panel, and must be **default-OFF** (invariant #8).

## Decision
A new **`src/economics/`** layer, all driven by a single contract `src/economics/types.ts`
(`EconomicsConfig`, `BudgetScope`, `CostLimiterPort`, …) and **default-OFF** (`EconomicsConfig.enabled`
gates everything; when false, admission is always `allow` and no limiter is consulted):

- **`rate-cost-limiter.ts` — `RateCostLimiter implements CostLimiterPort`.** Wraps
  **`rate-limiter-flexible`** (cost units ↦ limiter "points"). Enforces request-rate **and** cost
  budgets across the **tightest binding scope** (global ceiling + per-tenant + per-agent). The
  underlying limiter is **injected via `RateLimiterFactory`** — `RateLimiterMemory` in tests (real,
  in-process, no Redis), `RateLimiterRedis` in prod. Multi-scope reservations **compensate** (reward
  back already-consumed scopes) when a later scope rejects, so no partial reservation leaks. Exports a
  pure **`detectSpendAnomaly`** helper (spend-spike detection).
- **`cost-reservation.ts` — `CostReservation`.** **Pre-exec admission control**: `admit(scope, units)`
  returns `allow` / `degrade` / `reject` **before** a step runs — rate first, then cost; rejects an
  over-budget step pre-exec; **degrades at the configured threshold (default 0.75)** ("run cheaper",
  still reserves). `release()` compensates an admitted-but-unrun step.
- **`cache-accounting.ts`** — pure prompt-cache pricing: `priceUsage` bills `cachedInputTokens` at the
  provider's `cacheDiscount` multiplier and breaks out the `cacheSavings`; `effectiveCacheHitRate`.
- **`model-router.ts`** — pure right-sizing: `routeModel` filters candidates by capability + context
  window, then picks by a budget-pressure-weighted score (cheap under pressure, capable otherwise),
  with a deterministic tie-break; `estimatedStepCost` proxy.

- **New direct dependency: `rate-limiter-flexible ^11.2.0`** (0 known vulns; ships its own types).
- **Library API (additive):** the four modules + the `types.ts` contract are exported from the main
  entry point; `economics` block added to `AppConfig` (env: `ECONOMICS_ENABLED`,
  `ECONOMICS_MAX_REQUESTS_PER_WINDOW`, `ECONOMICS_MAX_COST_PER_WINDOW`, `ECONOMICS_GLOBAL_COST_CEILING`,
  `ECONOMICS_WINDOW_SECONDS`, `ECONOMICS_DEGRADE_THRESHOLD`).

## Invariants preserved
- **§B1.3 COST guard:** per-task accounting (`maxTokenBudget`) and the board economics panel are
  untouched; this is an additive *fleet* layer.
- **Default-off / fail-open-when-disabled (invariant #8):** `enabled:false` ⇒ admission always allows,
  the limiter is never constructed/consulted.
- **`0` = unlimited** per dimension, so a partially-configured limiter only enforces what you set.

## Deferred (roadmap)
- **Actor hot-path enforcement wiring** — the modules + `admit()` provide the pre-exec rejection
  *capability*; wiring it into the bundled `AgentActor` execution loop (so the deployed worker calls
  `admit()` before each LLM step) is a follow-up integration, kept separate so the hot path is reviewed
  on its own. Library consumers can call `admit()` today.
- **Phase G consumes this:** the governance Action Gate (ADR-020, next) uses `CostReservation` as one
  of its validators — cost-reservation is owned here (de-duped per §B-plan).
- Provider-specific cache-rate tables (beyond the single `cacheDiscount` multiplier); model-latency in
  routing.

## Consequences
- Operators get a fleet budget/rate ceiling + admission control + cache accounting + right-sizing,
  all opt-in. One new dep (`rate-limiter-flexible`). The four modules are 100%-covered with no broker
  (real `RateLimiterMemory`). Built by four parallel subagents against the shared `types.ts` contract.
