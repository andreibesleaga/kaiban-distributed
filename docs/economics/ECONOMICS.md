# Economics / FinOps — Phase E

> Authoritative spec: `KAIBAN-v2.0-MASTER-PLAN.md` §B5.1 Phase E · decision: `docs/decisions/ADR-019`.

A **fleet-wide** cost-control layer on top of the existing **per-task** token accounting
(`AgentStatePublisher.maxTokenBudget`, board economics panel) — which it does **not** change
(§B1.3 COST guard). Everything is **default-OFF**: with `ECONOMICS_ENABLED` unset, admission always
allows and no limiter is constructed.

## Enabling it

```bash
ECONOMICS_ENABLED=true                  # master switch (default false)
ECONOMICS_MAX_REQUESTS_PER_WINDOW=600   # request-rate ceiling per scope (0 = unlimited)
ECONOMICS_MAX_COST_PER_WINDOW=50000     # cost-unit budget per tenant/agent scope (0 = unlimited)
ECONOMICS_GLOBAL_COST_CEILING=500000    # cost-unit ceiling across ALL scopes (0 = unlimited)
ECONOMICS_WINDOW_SECONDS=60             # sliding window length
ECONOMICS_DEGRADE_THRESHOLD=0.75        # utilization at/above which to DEGRADE (run cheaper)
```

`0` means *unlimited* for that dimension, so a partially-configured limiter only enforces what you set.

## The four modules (`src/economics/`)

### Rate + cost limiter — `RateCostLimiter` (implements `CostLimiterPort`)
Enforces request-rate **and** cost budgets across the **tightest binding scope** (global + per-tenant +
per-agent), backed by [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible).
The underlying store is **injected** via a `RateLimiterFactory` — use `RateLimiterMemory` for a single
node/tests, `RateLimiterRedis` for a fleet:

```ts
import { RateLimiterRedis } from "rate-limiter-flexible";
import { RateCostLimiter } from "kaiban-distributed";

const limiter = new RateCostLimiter({
  config: appConfig.economics,
  factory: ({ keyPrefix, points, durationSeconds }) =>
    new RateLimiterRedis({ storeClient: redis, keyPrefix, points, duration: durationSeconds }),
});
```

Multi-scope reservations **compensate** (reward back already-consumed scopes) if a later scope rejects,
so no partial reservation leaks. `detectSpendAnomaly(samples, factor)` flags a spend spike.

### Pre-exec admission control — `CostReservation`
Decides **before** a step runs whether to `allow` / `degrade` / `reject`:

```ts
import { CostReservation } from "kaiban-distributed";

const reservation = new CostReservation({ config: appConfig.economics, limiter });
const verdict = await reservation.admit({ tenantId, agentId }, estimatedCostUnits);
// verdict.decision: "allow" | "degrade" | "reject"
if (verdict.decision === "reject") return;          // over budget — never executed
if (verdict.decision === "degrade") model = cheaperModel;  // budget pressure ≥ threshold
// ... run the step ...
// on a step that was admitted but ultimately not executed:
await reservation.release({ tenantId, agentId }, estimatedCostUnits);
```

Order: **rate first, then cost**. An over-budget cost reservation rejects pre-exec; utilization at/above
`degradeThreshold` degrades (still reserves — "run cheaper", not "don't run").

### Prompt-cache accounting — `priceUsage` / `effectiveCacheHitRate`
Pure pricing that bills `cachedInputTokens` at the provider's `cacheDiscount` multiplier and breaks out
the saving:

```ts
import { priceUsage } from "kaiban-distributed";
const { costUnits, cacheSavings } = priceUsage(
  { inputTokens: 4000, outputTokens: 800, cachedInputTokens: 3000 },
  { inputPer1k: 10, outputPer1k: 30, cacheDiscount: 0.25 }, // cached input billed at 25%
);
```

### Model right-sizing — `routeModel` / `estimatedStepCost`
Picks the right model for a task by capability + context window, weighted by **budget pressure**
(cheaper under pressure, more capable otherwise), deterministic tie-break:

```ts
import { routeModel } from "kaiban-distributed";
const { modelId } = routeModel(
  { minCapability: 6, estimatedTokens: 8000, budgetPressure: 0.8 },
  candidates, // ModelCandidate[]
);
```

## Guarantees / invariants
- **Default-OFF** (invariant #8): disabled ⇒ admission allows, limiter never consulted.
- **COST guard** (§B1.3): per-task accounting + the board economics panel are unchanged.
- Unit-tested to 100% with **no broker** (real `RateLimiterMemory`).

## Deferred (roadmap)
Wiring `admit()` into the bundled `AgentActor` hot path (deployed-worker enforcement), provider-specific
cache-rate tables, and latency-aware routing. The governance **Action Gate** (Phase G) consumes
`CostReservation` as a validator. See ADR-019.
