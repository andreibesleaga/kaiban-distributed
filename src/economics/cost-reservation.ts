/**
 * Pre-exec admission control (master plan §B5.1 Phase E, ADR-019).
 *
 * `CostReservation` decides — BEFORE a step runs — whether to `allow`, `degrade`,
 * or `reject` it, by reserving against a `CostLimiterPort` (the rate + cost
 * limiter). It is default-OFF (invariant #8): when `config.enabled` is false the
 * limiter is NEVER consulted and admission is always `allow`.
 *
 * Check order (fail-fast, cheapest first):
 *   1. rate (consume one request) — reject without touching the cost budget;
 *   2. cost reservation — reject pre-exec when the reservation is over budget;
 *   3. budget pressure ≥ `degradeThreshold` — `degrade` but KEEP the reservation
 *      ("run cheaper", not "don't run");
 *   4. otherwise `allow`.
 *
 * `release` compensates an admitted-but-not-executed step by forwarding to the
 * limiter (safe to call when disabled — the limiter handles the no-op).
 */
import type {
  AdmissionDecision,
  AdmissionResult,
  BudgetScope,
  CostLimiterPort,
  CostUnits,
  EconomicsConfig,
} from "./types";

/** Construction dependencies for {@link CostReservation}. */
export interface CostReservationDeps {
  config: EconomicsConfig;
  limiter: CostLimiterPort;
}

function result(
  decision: AdmissionDecision,
  remaining: number,
  utilization: number,
  reason: string,
): AdmissionResult {
  return { decision, remaining, utilization, reason };
}

export class CostReservation {
  private readonly config: EconomicsConfig;
  private readonly limiter: CostLimiterPort;

  constructor(deps: CostReservationDeps) {
    this.config = deps.config;
    this.limiter = deps.limiter;
  }

  async admit(scope: BudgetScope, units: CostUnits): Promise<AdmissionResult> {
    if (!this.config.enabled) {
      return result("allow", Number.POSITIVE_INFINITY, 0, "economics disabled");
    }

    const rate = await this.limiter.consumeRequest(scope);
    if (!rate.ok) {
      return result("reject", 0, 1, "request rate exceeded");
    }

    const cost = await this.limiter.reserveCost(scope, units);
    if (!cost.ok) {
      return result(
        "reject",
        cost.remaining,
        cost.utilization,
        "cost budget exceeded (pre-exec)",
      );
    }

    if (cost.utilization >= this.config.degradeThreshold) {
      return result(
        "degrade",
        cost.remaining,
        cost.utilization,
        "budget pressure ≥ degrade threshold",
      );
    }

    return result("allow", cost.remaining, cost.utilization, "within budget");
  }

  async release(scope: BudgetScope, units: CostUnits): Promise<void> {
    await this.limiter.releaseCost(scope, units);
  }
}
