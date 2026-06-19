/**
 * Pre-exec admission control (master plan §B5.1 Phase E, ADR-019).
 *
 * `CostReservation` decides — BEFORE a step executes — whether to allow, degrade,
 * or reject it, by consulting a `CostLimiterPort` (the rate + cost limiter). It is
 * default-OFF (invariant #8): when `enabled:false` admission is always `allow` and
 * the limiter is NEVER consulted. The order of checks is rate (request) first, then
 * cost reservation; an over-budget cost reservation rejects pre-exec, and budget
 * pressure at/above `degradeThreshold` degrades (still reserves — "run cheaper",
 * not "don't run").
 *
 * The limiter is faked from `vi.fn()`s so every branch is driven deterministically
 * with no real limiter/Redis.
 */
import { describe, it, expect, vi, type Mock } from "vitest";
import { CostReservation } from "../../../src/economics/cost-reservation";
import type {
  BudgetScope,
  CostUnits,
  EconomicsConfig,
  LimiterReservation,
} from "../../../src/economics/types";

interface FakeLimiter {
  consumeRequest: Mock<(scope: BudgetScope) => Promise<LimiterReservation>>;
  reserveCost: Mock<
    (scope: BudgetScope, units: CostUnits) => Promise<LimiterReservation>
  >;
  releaseCost: Mock<(scope: BudgetScope, units: CostUnits) => Promise<void>>;
}

function makeLimiter(overrides: Partial<FakeLimiter> = {}): FakeLimiter {
  const ok: LimiterReservation = { ok: true, remaining: 100, utilization: 0.1 };
  return {
    consumeRequest: vi.fn(
      (_scope: BudgetScope): Promise<LimiterReservation> => Promise.resolve(ok),
    ),
    reserveCost: vi.fn(
      (_scope: BudgetScope, _units: CostUnits): Promise<LimiterReservation> =>
        Promise.resolve(ok),
    ),
    releaseCost: vi.fn(
      (_scope: BudgetScope, _units: CostUnits): Promise<void> => Promise.resolve(),
    ),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<EconomicsConfig> = {}): EconomicsConfig {
  return {
    enabled: true,
    maxRequestsPerWindow: 10,
    maxCostPerWindow: 1000,
    globalCostCeiling: 10000,
    windowSeconds: 60,
    degradeThreshold: 0.75,
    ...overrides,
  };
}

const SCOPE: BudgetScope = { tenantId: "t1", agentId: "a1" };

describe("CostReservation.admit", () => {
  it("allows without consulting the limiter when economics is disabled", async () => {
    const limiter = makeLimiter();
    const cr = new CostReservation({ config: makeConfig({ enabled: false }), limiter });

    const result = await cr.admit(SCOPE, 50);

    expect(result).toEqual({
      decision: "allow",
      remaining: Number.POSITIVE_INFINITY,
      utilization: 0,
      reason: "economics disabled",
    });
    expect(limiter.consumeRequest).not.toHaveBeenCalled();
    expect(limiter.reserveCost).not.toHaveBeenCalled();
  });

  it("rejects when the request rate is exceeded and does NOT reserve cost", async () => {
    const limiter = makeLimiter({
      consumeRequest: vi.fn(
        (): Promise<LimiterReservation> =>
          Promise.resolve({ ok: false, remaining: 0, utilization: 1 }),
      ),
    });
    const cr = new CostReservation({ config: makeConfig(), limiter });

    const result = await cr.admit(SCOPE, 50);

    expect(result).toEqual({
      decision: "reject",
      remaining: 0,
      utilization: 1,
      reason: "request rate exceeded",
    });
    expect(limiter.consumeRequest).toHaveBeenCalledWith(SCOPE);
    expect(limiter.reserveCost).not.toHaveBeenCalled();
  });

  it("rejects pre-exec when the cost reservation is over budget", async () => {
    const limiter = makeLimiter({
      reserveCost: vi.fn(
        (): Promise<LimiterReservation> =>
          Promise.resolve({ ok: false, remaining: 5, utilization: 0.99 }),
      ),
    });
    const cr = new CostReservation({ config: makeConfig(), limiter });

    const result = await cr.admit(SCOPE, 50);

    expect(result).toEqual({
      decision: "reject",
      remaining: 5,
      utilization: 0.99,
      reason: "cost budget exceeded (pre-exec)",
    });
    expect(limiter.consumeRequest).toHaveBeenCalledWith(SCOPE);
    expect(limiter.reserveCost).toHaveBeenCalledWith(SCOPE, 50);
  });

  it("degrades (but still reserves) when utilization is AT the degrade threshold", async () => {
    const limiter = makeLimiter({
      reserveCost: vi.fn(
        (): Promise<LimiterReservation> =>
          Promise.resolve({ ok: true, remaining: 200, utilization: 0.75 }),
      ),
    });
    const cr = new CostReservation({ config: makeConfig({ degradeThreshold: 0.75 }), limiter });

    const result = await cr.admit(SCOPE, 50);

    expect(result).toEqual({
      decision: "degrade",
      remaining: 200,
      utilization: 0.75,
      reason: "budget pressure ≥ degrade threshold",
    });
    expect(limiter.reserveCost).toHaveBeenCalledWith(SCOPE, 50);
  });

  it("degrades when utilization is ABOVE the degrade threshold", async () => {
    const limiter = makeLimiter({
      reserveCost: vi.fn(
        (): Promise<LimiterReservation> =>
          Promise.resolve({ ok: true, remaining: 50, utilization: 0.9 }),
      ),
    });
    const cr = new CostReservation({ config: makeConfig({ degradeThreshold: 0.75 }), limiter });

    const result = await cr.admit(SCOPE, 50);

    expect(result.decision).toBe("degrade");
    expect(result.utilization).toBe(0.9);
    expect(result.remaining).toBe(50);
  });

  it("allows when within budget and below the degrade threshold", async () => {
    const limiter = makeLimiter({
      reserveCost: vi.fn(
        (): Promise<LimiterReservation> =>
          Promise.resolve({ ok: true, remaining: 800, utilization: 0.2 }),
      ),
    });
    const cr = new CostReservation({ config: makeConfig({ degradeThreshold: 0.75 }), limiter });

    const result = await cr.admit(SCOPE, 50);

    expect(result).toEqual({
      decision: "allow",
      remaining: 800,
      utilization: 0.2,
      reason: "within budget",
    });
  });
});

describe("CostReservation.release", () => {
  it("forwards a release to the limiter's releaseCost", async () => {
    const limiter = makeLimiter();
    const cr = new CostReservation({ config: makeConfig(), limiter });

    await cr.release(SCOPE, 30);

    expect(limiter.releaseCost).toHaveBeenCalledWith(SCOPE, 30);
  });

  it("still forwards a release when economics is disabled (limiter handles disabled)", async () => {
    const limiter = makeLimiter();
    const cr = new CostReservation({ config: makeConfig({ enabled: false }), limiter });

    await cr.release(SCOPE, 30);

    expect(limiter.releaseCost).toHaveBeenCalledWith(SCOPE, 30);
  });
});
