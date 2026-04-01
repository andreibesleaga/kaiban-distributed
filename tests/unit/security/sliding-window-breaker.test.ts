import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlidingWindowBreaker } from "../../../src/infrastructure/security/sliding-window-breaker";

describe("SlidingWindowBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in closed state", () => {
    const breaker = new SlidingWindowBreaker(3, 1000);
    expect(breaker.isOpen()).toBe(false);
  });

  it("opens after threshold failures within the window", () => {
    const breaker = new SlidingWindowBreaker(3, 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
  });

  it("does not open if failures are outside the window", () => {
    const breaker = new SlidingWindowBreaker(3, 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    vi.advanceTimersByTime(1100);
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
  });

  it("closes automatically when failures expire from the window", () => {
    const breaker = new SlidingWindowBreaker(3, 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);

    vi.advanceTimersByTime(1100);
    expect(breaker.isOpen()).toBe(false);
  });

  it("closes on recordSuccess when failures drop below threshold", () => {
    const breaker = new SlidingWindowBreaker(3, 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);

    vi.advanceTimersByTime(1100);
    breaker.recordSuccess();
    expect(breaker.isOpen()).toBe(false);
  });

  it("remains closed with only successes", () => {
    const breaker = new SlidingWindowBreaker(3, 1000);
    breaker.recordSuccess();
    breaker.recordSuccess();
    breaker.recordSuccess();
    expect(breaker.isOpen()).toBe(false);
  });

  it("re-opens if new failures exceed threshold after recovery", () => {
    const breaker = new SlidingWindowBreaker(2, 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);

    vi.advanceTimersByTime(1100);
    breaker.recordSuccess();
    expect(breaker.isOpen()).toBe(false);

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
  });
});
