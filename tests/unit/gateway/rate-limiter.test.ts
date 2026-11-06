/** SlidingWindowRateLimiter — bounded memory under a key spray (SEC-04). */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlidingWindowRateLimiter } from "../../../src/adapters/gateway/rate-limiter";

describe("SlidingWindowRateLimiter memory bounds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("drops keys that are never seen again once their window has passed", () => {
    const limiter = new SlidingWindowRateLimiter(1_000, 5);
    for (let i = 0; i < 50; i++) limiter.isAllowed(`ip-${i}`);
    expect(limiter.size).toBe(50);
    vi.advanceTimersByTime(1_500);
    limiter.isAllowed("someone-else"); // any call triggers the sweep
    expect(limiter.size).toBe(1);
  });

  it("keeps a key whose newest hit is still inside the window", () => {
    const limiter = new SlidingWindowRateLimiter(1_000, 5);
    limiter.isAllowed("old");
    vi.advanceTimersByTime(900);
    limiter.isAllowed("fresh");
    vi.advanceTimersByTime(200); // old is 1100 ms old, fresh 200 ms
    limiter.isAllowed("trigger");
    expect(limiter.size).toBe(2);
  });

  it("never holds more than maxKeys entries; the oldest go first", () => {
    const limiter = new SlidingWindowRateLimiter(60_000, 5, 3);
    for (const k of ["a", "b", "c", "d"]) limiter.isAllowed(k);
    expect(limiter.size).toBe(3);
    // "a" was evicted, so it starts a fresh window (5 more hits allowed)
    for (let i = 0; i < 5; i++) expect(limiter.isAllowed("a")).toBe(true);
    expect(limiter.isAllowed("a")).toBe(false);
  });

  it("still refuses the (max+1)th hit inside one window", () => {
    const limiter = new SlidingWindowRateLimiter(1_000, 2);
    expect(limiter.isAllowed("x")).toBe(true);
    expect(limiter.isAllowed("x")).toBe(true);
    expect(limiter.isAllowed("x")).toBe(false);
    vi.advanceTimersByTime(1_001);
    expect(limiter.isAllowed("x")).toBe(true);
  });

  it("forgets a key's oldest hits as they leave the window (sliding, not fixed)", () => {
    const limiter = new SlidingWindowRateLimiter(1_000, 2);
    expect(limiter.isAllowed("x")).toBe(true); // t=0
    vi.advanceTimersByTime(600);
    expect(limiter.isAllowed("x")).toBe(true); // t=600
    vi.advanceTimersByTime(500); // t=1100: the t=0 hit is out, t=600 still in
    expect(limiter.isAllowed("x")).toBe(true);
    expect(limiter.isAllowed("x")).toBe(false);
  });
});
