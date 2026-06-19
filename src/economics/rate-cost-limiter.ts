/**
 * Rate + cost limiter (master plan §B5.1 Phase E, ADR-019).
 *
 * Enforces request-rate AND cost-unit budgets per scope (global ceiling, per-tenant,
 * per-agent) on top of one or more underlying `rate-limiter-flexible` limiters. Cost
 * units map 1:1 onto limiter "points". Everything is **default-OFF** (invariant #8):
 * `enabled:false` or an unconfigured dimension ⇒ admission always allows and no
 * limiter is consulted.
 *
 * The underlying limiters are injected via a {@link RateLimiterFactory} so production
 * can supply a `RateLimiterRedis` factory (shared store) while unit tests supply an
 * in-process `RateLimiterMemory` factory.
 */
import { RateLimiterRes, type RateLimiterAbstract } from "rate-limiter-flexible";
import type {
  BudgetScope,
  CostLimiterPort,
  CostUnits,
  EconomicsConfig,
  LimiterReservation,
  RateLimiterFactory,
} from "./types";

/** A single (limiter, key, limit) the current check must bind against. */
interface LimiterTarget {
  limiter: RateLimiterAbstract;
  key: string;
  points: number;
}

const GLOBAL_KEY = "global";

/** Allow result when a check is disabled or every dimension is unlimited. */
const UNLIMITED: LimiterReservation = {
  ok: true,
  remaining: Number.POSITIVE_INFINITY,
  utilization: 0,
};

/** Rejection result (no partial reservation leaks — already-consumed scopes are rewarded). */
const REJECTED: LimiterReservation = { ok: false, remaining: 0, utilization: 1 };

export interface RateCostLimiterDeps {
  config: EconomicsConfig;
  factory: RateLimiterFactory;
}

export class RateCostLimiter implements CostLimiterPort {
  private readonly config: EconomicsConfig;
  private readonly factory: RateLimiterFactory;
  private readonly limiters = new Map<string, RateLimiterAbstract>();

  constructor(deps: RateCostLimiterDeps) {
    this.config = deps.config;
    this.factory = deps.factory;
  }

  public async consumeRequest(scope: BudgetScope): Promise<LimiterReservation> {
    const targets = this.rateTargets(scope);
    if (targets.length === 0) {
      return UNLIMITED;
    }
    return this.consumeTargets(targets, 1);
  }

  public async reserveCost(scope: BudgetScope, units: CostUnits): Promise<LimiterReservation> {
    const targets = this.costTargets(scope);
    if (targets.length === 0) {
      return UNLIMITED;
    }
    return this.consumeTargets(targets, units);
  }

  public async releaseCost(scope: BudgetScope, units: CostUnits): Promise<void> {
    const targets = this.costTargets(scope);
    for (const target of targets) {
      await target.limiter.reward(target.key, units);
    }
  }

  /** Lazily build (and cache) one underlying limiter per keyPrefix. */
  private getLimiter(keyPrefix: string, points: number): RateLimiterAbstract {
    const cached = this.limiters.get(keyPrefix);
    if (cached) {
      return cached;
    }
    const created = this.factory({
      keyPrefix,
      points,
      durationSeconds: this.config.windowSeconds,
    });
    this.limiters.set(keyPrefix, created);
    return created;
  }

  /** Targets for the request-rate concern (global + tenant + agent, where configured). */
  private rateTargets(scope: BudgetScope): LimiterTarget[] {
    const limit = this.config.maxRequestsPerWindow;
    return this.buildTargets("rate", scope, limit, limit);
  }

  /** Targets for the cost concern (global ceiling + per-scope cost budgets). */
  private costTargets(scope: BudgetScope): LimiterTarget[] {
    return this.buildTargets("cost", scope, this.config.globalCostCeiling, this.config.maxCostPerWindow);
  }

  /**
   * Build the ordered list of applicable targets (global, then tenant, then agent).
   * A dimension only participates when its limit is > 0 (0 = unlimited) and, for the
   * tenant/agent tiers, when the corresponding scope id is present.
   */
  private buildTargets(
    concern: "rate" | "cost",
    scope: BudgetScope,
    globalLimit: number,
    scopeLimit: number,
  ): LimiterTarget[] {
    const targets: LimiterTarget[] = [];
    if (!this.config.enabled) {
      return targets;
    }
    if (globalLimit > 0) {
      targets.push({ limiter: this.getLimiter(`${concern}:global`, globalLimit), key: GLOBAL_KEY, points: globalLimit });
    }
    if (scope.tenantId !== undefined && scopeLimit > 0) {
      targets.push({ limiter: this.getLimiter(`${concern}:tenant`, scopeLimit), key: scope.tenantId, points: scopeLimit });
    }
    if (scope.agentId !== undefined && scopeLimit > 0) {
      targets.push({ limiter: this.getLimiter(`${concern}:agent`, scopeLimit), key: scope.agentId, points: scopeLimit });
    }
    return targets;
  }

  /**
   * Consume `units` against every target, tracking the tightest binding scope. If any
   * target rejects (over budget), reward back the targets already consumed so no partial
   * reservation leaks, then return {@link REJECTED}.
   */
  private async consumeTargets(targets: LimiterTarget[], units: number): Promise<LimiterReservation> {
    const consumed: LimiterTarget[] = [];
    let remaining = Number.POSITIVE_INFINITY;
    let utilization = 0;

    for (const target of targets) {
      const res = await this.consumeOne(target, units);
      if (res === null) {
        await this.compensate(consumed, units);
        return REJECTED;
      }
      consumed.push(target);
      remaining = Math.min(remaining, res.remainingPoints);
      utilization = Math.max(utilization, res.consumedPoints / target.points);
    }
    return { ok: true, remaining, utilization };
  }

  /** Consume one target; return the result, or null when over budget (RateLimiterRes thrown). */
  private async consumeOne(target: LimiterTarget, units: number): Promise<RateLimiterRes | null> {
    try {
      return await target.limiter.consume(target.key, units);
    } catch (rejRes) {
      if (rejRes instanceof RateLimiterRes) {
        return null;
      }
      throw rejRes;
    }
  }

  /** Reward back every already-consumed target (compensation for an over-budget sibling). */
  private async compensate(consumed: LimiterTarget[], units: number): Promise<void> {
    for (const target of consumed) {
      await target.limiter.reward(target.key, units);
    }
  }
}

/**
 * Spend-anomaly detection: true when the **last** sample exceeds `mean(previous) * factor`.
 * Guards short input (< 2 samples ⇒ false).
 */
export function detectSpendAnomaly(samples: number[], factor = 3): boolean {
  if (samples.length < 2) {
    return false;
  }
  const previous = samples.slice(0, -1);
  const last = samples[samples.length - 1];
  const mean = previous.reduce((sum, value) => sum + value, 0) / previous.length;
  return last > mean * factor;
}
