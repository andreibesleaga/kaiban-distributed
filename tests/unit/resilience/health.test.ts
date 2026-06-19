/**
 * Readiness + startup probes (master plan §B5.1 Phase R, ADR-018).
 *
 * `/ready` verifies the process's downstream dependencies (Redis + broker) are
 * reachable; `/startup` reports whether one-time boot work has finished. Both are
 * built from pluggable, infrastructure-agnostic check functions so they unit-test
 * with zero brokers.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildReadinessProbe,
  buildStartupProbe,
} from "../../../src/resilience/health";

describe("buildReadinessProbe", () => {
  it("is ready when every check passes", async () => {
    const probe = buildReadinessProbe({
      checks: [
        { name: "redis", check: (): Promise<boolean> => Promise.resolve(true) },
        { name: "broker", check: (): Promise<boolean> => Promise.resolve(true) },
      ],
    });

    const result = await probe();

    expect(result.ready).toBe(true);
    expect(result.checks).toEqual([
      { name: "redis", ok: true },
      { name: "broker", ok: true },
    ]);
  });

  it("is NOT ready when any check returns false", async () => {
    const probe = buildReadinessProbe({
      checks: [
        { name: "redis", check: (): Promise<boolean> => Promise.resolve(true) },
        { name: "broker", check: (): Promise<boolean> => Promise.resolve(false) },
      ],
    });

    const result = await probe();

    expect(result.ready).toBe(false);
    expect(result.checks).toContainEqual({ name: "broker", ok: false });
  });

  it("treats a throwing check as a failed (not crashing) dependency", async () => {
    const probe = buildReadinessProbe({
      checks: [
        {
          name: "redis",
          check: (): Promise<boolean> => Promise.reject(new Error("ECONNREFUSED")),
        },
      ],
    });

    const result = await probe();

    expect(result.ready).toBe(false);
    expect(result.checks).toEqual([
      { name: "redis", ok: false, error: "ECONNREFUSED" },
    ]);
  });

  it("stringifies a non-Error rejection reason", async () => {
    const probe = buildReadinessProbe({
      checks: [{ name: "broker", check: (): Promise<boolean> => Promise.reject("down") }],
    });

    const result = await probe();

    expect(result.checks).toEqual([
      { name: "broker", ok: false, error: "down" },
    ]);
  });

  it("runs the checks concurrently (not serially)", async () => {
    const order: string[] = [];
    const slow = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          setTimeout(() => {
            order.push("slow");
            resolve(true);
          }, 20);
        }),
    );
    const fast = vi.fn(() => {
      order.push("fast");
      return Promise.resolve(true);
    });

    const probe = buildReadinessProbe({
      checks: [
        { name: "slow", check: slow },
        { name: "fast", check: fast },
      ],
    });
    await probe();

    // Fast resolved before slow → they were not awaited serially.
    expect(order).toEqual(["fast", "slow"]);
  });

  it("is ready (vacuously) with no checks", async () => {
    const probe = buildReadinessProbe({ checks: [] });
    const result = await probe();
    expect(result).toEqual({ ready: true, checks: [] });
  });
});

describe("buildStartupProbe", () => {
  it("is not ready until the started predicate flips true", async () => {
    let booted = false;
    const probe = buildStartupProbe({ started: () => booted });

    expect((await probe()).ready).toBe(false);
    booted = true;
    expect((await probe()).ready).toBe(true);
  });

  it("reports a single 'startup' check reflecting the predicate", async () => {
    const probe = buildStartupProbe({ started: () => true });
    const result = await probe();
    expect(result).toEqual({
      ready: true,
      checks: [{ name: "startup", ok: true }],
    });
  });
});
