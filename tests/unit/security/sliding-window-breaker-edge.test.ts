import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlidingWindowBreaker } from '../../../src/infrastructure/security/sliding-window-breaker';

describe('SlidingWindowBreaker — edge cases', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // ── Boundary: threshold=1 ───────────────────────────────────────
  it('trips immediately with threshold=1 on single failure', () => {
    const breaker = new SlidingWindowBreaker(1, 1000);
    expect(breaker.isOpen()).toBe(false);
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
  });

  // ── No-op: recordSuccess when already closed ────────────────────
  it('recordSuccess when closed is a no-op', () => {
    const breaker = new SlidingWindowBreaker(3, 1000);
    // Never opened — this should not throw or change state
    breaker.recordSuccess();
    expect(breaker.isOpen()).toBe(false);
  });

  // ── Console output: warns on trip ───────────────────────────────
  it('logs console.warn when circuit opens', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const breaker = new SlidingWindowBreaker(2, 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Circuit OPEN'),
    );
    warnSpy.mockRestore();
  });

  it('logs console.log when circuit closes on success after recovery', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const breaker = new SlidingWindowBreaker(2, 1000);
    breaker.recordFailure();
    breaker.recordFailure(); // trips
    vi.advanceTimersByTime(1100); // window expires
    breaker.recordSuccess(); // should close and log
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Circuit closed'),
    );
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // ── Large number of rapid failures ──────────────────────────────
  it('handles many rapid failures without error', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const breaker = new SlidingWindowBreaker(5, 10000);
    for (let i = 0; i < 100; i++) {
      breaker.recordFailure();
    }
    expect(breaker.isOpen()).toBe(true);
    warnSpy.mockRestore();
  });

  // ── isOpen auto-recovers without recordSuccess ──────────────────
  it('isOpen auto-recovers after window even without explicit recordSuccess', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const breaker = new SlidingWindowBreaker(2, 500);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
    vi.advanceTimersByTime(600);
    // isOpen prunes old failures and auto-closes
    expect(breaker.isOpen()).toBe(false);
    warnSpy.mockRestore();
  });

  // ── recordFailure when already open doesn't double-warn ─────────
  it('does not log additional warn if already open', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const breaker = new SlidingWindowBreaker(2, 1000);
    breaker.recordFailure();
    breaker.recordFailure(); // trips — 1 warn
    breaker.recordFailure(); // already open — no new warn
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
