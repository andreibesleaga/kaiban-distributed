import { describe, it, expect, beforeEach } from "vitest";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { RateCostLimiter, detectSpendAnomaly } from "../../../src/economics/rate-cost-limiter";
import type { EconomicsConfig, RateLimiterFactory } from "../../../src/economics/types";

/**
 * Real in-process limiter factory (no Redis) — every limiter is a distinct
 * `RateLimiterMemory` so the cache-by-keyPrefix behaviour is exercised end-to-end.
 */
function memoryFactory(): RateLimiterFactory {
  return ({ keyPrefix, points, durationSeconds }): RateLimiterMemory =>
    new RateLimiterMemory({ keyPrefix, points, duration: durationSeconds });
}

/**
 * Factory whose limiters reject `consume` with a plain `Error` (NOT a `RateLimiterRes`) — the way a
 * store/DB-backed limiter surfaces an infrastructure failure. Exercises the rethrow path.
 */
function throwingFactory(error: Error): RateLimiterFactory {
  return ({ keyPrefix, points, durationSeconds }): RateLimiterMemory => {
    const limiter = new RateLimiterMemory({ keyPrefix, points, duration: durationSeconds });
    limiter.consume = (): Promise<never> => Promise.reject(error);
    return limiter;
  };
}

function baseConfig(overrides: Partial<EconomicsConfig> = {}): EconomicsConfig {
  return {
    enabled: true,
    maxRequestsPerWindow: 0,
    maxCostPerWindow: 0,
    globalCostCeiling: 0,
    windowSeconds: 60,
    degradeThreshold: 0.8,
    ...overrides,
  };
}

describe("RateCostLimiter", () => {
  let factory: RateLimiterFactory;

  beforeEach(() => {
    factory = memoryFactory();
  });

  describe("disabled passthrough", () => {
    it("allows every request when disabled", async () => {
      const limiter = new RateCostLimiter({
        config: baseConfig({ enabled: false, maxRequestsPerWindow: 1, maxCostPerWindow: 1, globalCostCeiling: 1 }),
        factory,
      });

      const req = await limiter.consumeRequest({ tenantId: "t1", agentId: "a1" });
      const cost = await limiter.reserveCost({ tenantId: "t1", agentId: "a1" }, 99);

      expect(req).toEqual({ ok: true, remaining: Number.POSITIVE_INFINITY, utilization: 0 });
      expect(cost).toEqual({ ok: true, remaining: Number.POSITIVE_INFINITY, utilization: 0 });
      // releaseCost is a no-op when disabled (must not throw).
      await expect(limiter.releaseCost({ tenantId: "t1" }, 5)).resolves.toBeUndefined();
    });
  });

  describe("unlimited dimensions", () => {
    it("allows requests when no rate limit is configured", async () => {
      const limiter = new RateCostLimiter({ config: baseConfig(), factory });
      const res = await limiter.consumeRequest({ tenantId: "t1", agentId: "a1" });
      expect(res).toEqual({ ok: true, remaining: Number.POSITIVE_INFINITY, utilization: 0 });
    });

    it("allows cost reservation when no cost ceiling is configured", async () => {
      const limiter = new RateCostLimiter({ config: baseConfig(), factory });
      const res = await limiter.reserveCost({ tenantId: "t1", agentId: "a1" }, 1000);
      expect(res).toEqual({ ok: true, remaining: Number.POSITIVE_INFINITY, utilization: 0 });
    });

    it("releaseCost is a no-op when nothing is configured", async () => {
      const limiter = new RateCostLimiter({ config: baseConfig(), factory });
      await expect(limiter.releaseCost({ tenantId: "t1", agentId: "a1" }, 10)).resolves.toBeUndefined();
    });
  });

  describe("request rate", () => {
    it("allows up to the limit then rejects", async () => {
      const limiter = new RateCostLimiter({
        config: baseConfig({ maxRequestsPerWindow: 2 }),
        factory,
      });

      const first = await limiter.consumeRequest({ tenantId: "t1" });
      expect(first.ok).toBe(true);
      expect(first.remaining).toBe(1);
      expect(first.utilization).toBeCloseTo(0.5, 5);

      const second = await limiter.consumeRequest({ tenantId: "t1" });
      expect(second.ok).toBe(true);
      expect(second.remaining).toBe(0);
      expect(second.utilization).toBeCloseTo(1, 5);

      const third = await limiter.consumeRequest({ tenantId: "t1" });
      expect(third).toEqual({ ok: false, remaining: 0, utilization: 1 });
    });

    it("uses 'global' as the key when no scope id is set", async () => {
      const limiter = new RateCostLimiter({
        config: baseConfig({ maxRequestsPerWindow: 1 }),
        factory,
      });
      const first = await limiter.consumeRequest({});
      const second = await limiter.consumeRequest({});
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(false);
    });
  });

  describe("cost reservation within budget", () => {
    it("reports remaining and utilization correctly", async () => {
      const limiter = new RateCostLimiter({
        config: baseConfig({ maxCostPerWindow: 100 }),
        factory,
      });

      const res = await limiter.reserveCost({ tenantId: "t1" }, 40);
      expect(res.ok).toBe(true);
      expect(res.remaining).toBe(60);
      expect(res.utilization).toBeCloseTo(0.4, 5);
    });
  });

  describe("cost rejection with compensation", () => {
    it("rejects when over the tenant budget and rewards back the already-consumed global scope", async () => {
      // global ceiling is generous; tenant budget is tight ⇒ global consumes first (ok), then the
      // tenant scope rejects (over budget). The earlier global consume MUST be rewarded back.
      const limiter = new RateCostLimiter({
        config: baseConfig({ maxCostPerWindow: 50, globalCostCeiling: 1000 }),
        factory,
      });

      const over = await limiter.reserveCost({ tenantId: "t1" }, 80);
      expect(over.ok).toBe(false);

      // Compensation proof: a *different*, still-funded tenant (sharing the global ceiling) can
      // reserve its full per-tenant budget. If global had NOT been rewarded, the global remaining
      // would already be 1000-80=920; instead it is the full 1000, so t2 binds on its own tenant
      // budget (remaining 0) rather than on a depleted global.
      const otherTenant = await limiter.reserveCost({ tenantId: "t2" }, 50);
      expect(otherTenant.ok).toBe(true);
      expect(otherTenant.remaining).toBe(0);
      expect(otherTenant.utilization).toBeCloseTo(1, 5);
    });

    it("rejects when the agent scope is over budget and rewards back tenant + global", async () => {
      // tenant + agent share maxCostPerWindow=50; global=1000. reserve(t1/a1, 60): global ok (60),
      // tenant rejects (60>50). Compensation rewards global back; tenant/agent t1 keep the rejected
      // penalty. A fresh, still-funded tenant+agent (t2/a2) then reserves cleanly ⇒ global was rewarded.
      const limiter = new RateCostLimiter({
        config: baseConfig({ maxCostPerWindow: 50, globalCostCeiling: 1000 }),
        factory,
      });

      const over = await limiter.reserveCost({ tenantId: "t1", agentId: "a1" }, 60);
      expect(over.ok).toBe(false);

      const recovered = await limiter.reserveCost({ tenantId: "t2", agentId: "a2" }, 50);
      expect(recovered.ok).toBe(true);
      // global: 50/1000 ⇒ remaining 950; tenant t2: 0; agent a2: 0. Tightest ⇒ remaining 0.
      expect(recovered.remaining).toBe(0);
    });

    it("rejects when the global ceiling is over budget (nothing consumed yet to compensate)", async () => {
      // global is checked first; an over-ceiling reserve rejects immediately, so no sibling scope
      // was consumed and the compensation loop is a no-op (REJECTED with no leak).
      const limiter = new RateCostLimiter({
        config: baseConfig({ maxCostPerWindow: 1000, globalCostCeiling: 30 }),
        factory,
      });

      const over = await limiter.reserveCost({ tenantId: "t1" }, 40);
      expect(over).toEqual({ ok: false, remaining: 0, utilization: 1 });
    });
  });

  describe("request rejection does not leak a partial reservation", () => {
    it("rejects cleanly and keeps a multi-scope request atomic", async () => {
      // global + tenant + agent all share maxRequestsPerWindow=1. The first multi-scope request
      // consumes one slot on each; the second rejects on the global scope (checked first), so the
      // compensation loop runs with an empty consumed list (no partial leak).
      const limiter = new RateCostLimiter({
        config: baseConfig({ maxRequestsPerWindow: 1 }),
        factory,
      });

      const first = await limiter.consumeRequest({ tenantId: "t1", agentId: "a1" });
      expect(first.ok).toBe(true);
      expect(first.remaining).toBe(0);
      expect(first.utilization).toBeCloseTo(1, 5);

      const second = await limiter.consumeRequest({ tenantId: "t1", agentId: "a1" });
      expect(second).toEqual({ ok: false, remaining: 0, utilization: 1 });
    });

    it("rethrows a non-RateLimiterRes consume failure (store/infrastructure error)", async () => {
      const storeError = new Error("redis unavailable");
      const limiter = new RateCostLimiter({
        config: baseConfig({ maxRequestsPerWindow: 1 }),
        factory: throwingFactory(storeError),
      });

      await expect(limiter.consumeRequest({ tenantId: "t1" })).rejects.toThrow("redis unavailable");
    });
  });

  describe("releaseCost restores budget", () => {
    it("returns reserved units so a later reservation succeeds", async () => {
      const limiter = new RateCostLimiter({
        config: baseConfig({ maxCostPerWindow: 100 }),
        factory,
      });

      const first = await limiter.reserveCost({ tenantId: "t1" }, 100);
      expect(first.ok).toBe(true);

      // No budget left now. (rate-limiter-flexible records the rejected consume as a +1 penalty,
      // so consumed becomes 101 — see below.)
      const blocked = await limiter.reserveCost({ tenantId: "t1" }, 1);
      expect(blocked.ok).toBe(false);

      // Release 60 units back ⇒ consumed 101 - 60 = 41.
      await limiter.releaseCost({ tenantId: "t1" }, 60);

      // Reserve 50 ⇒ consumed 91, remaining 100 - 91 = 9.
      const after = await limiter.reserveCost({ tenantId: "t1" }, 50);
      expect(after.ok).toBe(true);
      expect(after.remaining).toBe(9);
    });
  });

  describe("tightest-binding selection", () => {
    it("binds on the tenant scope when it is tighter than global", async () => {
      const limiter = new RateCostLimiter({
        config: baseConfig({ maxCostPerWindow: 20, globalCostCeiling: 1000 }),
        factory,
      });

      const res = await limiter.reserveCost({ tenantId: "t1" }, 10);
      expect(res.ok).toBe(true);
      // tenant: 20-10=10 remaining, util 0.5 ; global: 1000-10=990, util 0.01.
      // Tightest ⇒ min remaining (10) and max utilization (0.5).
      expect(res.remaining).toBe(10);
      expect(res.utilization).toBeCloseTo(0.5, 5);
    });

    it("binds on the global scope when it is tighter than tenant", async () => {
      const limiter = new RateCostLimiter({
        config: baseConfig({ maxCostPerWindow: 1000, globalCostCeiling: 20 }),
        factory,
      });

      const res = await limiter.reserveCost({ tenantId: "t1" }, 10);
      expect(res.ok).toBe(true);
      expect(res.remaining).toBe(10);
      expect(res.utilization).toBeCloseTo(0.5, 5);
    });
  });

  describe("detectSpendAnomaly", () => {
    it("returns false for fewer than two samples", () => {
      expect(detectSpendAnomaly([])).toBe(false);
      expect(detectSpendAnomaly([100])).toBe(false);
    });

    it("returns true when the last sample exceeds mean(previous) * factor", () => {
      expect(detectSpendAnomaly([10, 10, 10, 100])).toBe(true);
    });

    it("returns false when the last sample is within mean(previous) * factor", () => {
      expect(detectSpendAnomaly([10, 10, 10, 20])).toBe(false);
    });

    it("honours a custom factor", () => {
      // mean(previous) = 10, factor 2 ⇒ threshold 20; 25 > 20 ⇒ anomaly.
      expect(detectSpendAnomaly([10, 10, 25], 2)).toBe(true);
      // factor 5 ⇒ threshold 50; 25 < 50 ⇒ no anomaly.
      expect(detectSpendAnomaly([10, 10, 25], 5)).toBe(false);
    });
  });
});
