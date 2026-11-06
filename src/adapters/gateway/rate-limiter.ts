// SPDX-License-Identifier: Apache-2.0
// ── In-memory sliding-window rate limiter (zero-dependency) ──────────

/** Keys kept at most; the oldest are dropped first (bounds memory under address spray). */
const DEFAULT_MAX_KEYS = 100_000;

/** Per-key sliding window: at most `maxRequests` per `windowMs`. */
export class SlidingWindowRateLimiter {
  private windows = new Map<string, number[]>();
  private lastSweepAt = 0;

  constructor(
    private readonly windowMs = 60_000,
    private readonly maxRequests = 100,
    private readonly maxKeys = DEFAULT_MAX_KEYS,
  ) {}

  /** Number of keys currently tracked (tests, diagnostics). */
  get size(): number {
    return this.windows.size;
  }

  isAllowed(key: string): boolean {
    const now = Date.now();
    this.sweep(now);
    const cutoff = now - this.windowMs;
    const timestamps = this.windows.get(key) ?? [];
    while (timestamps.length > 0 && timestamps[0]! < cutoff) {
      timestamps.shift();
    }
    if (timestamps.length >= this.maxRequests) return false;
    timestamps.push(now);
    this.windows.delete(key); // re-insert last: Map order = least recently used first
    this.windows.set(key, timestamps);
    this.evictOldest();
    return true;
  }

  /** Once per window, drop every key whose newest hit is outside the window. */
  private sweep(now: number): void {
    if (now - this.lastSweepAt < this.windowMs) return;
    this.lastSweepAt = now;
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.windows) {
      if (timestamps[timestamps.length - 1]! < cutoff) this.windows.delete(key);
    }
  }

  /** Hard cap: a key spray cannot grow the map past `maxKeys`. */
  private evictOldest(): void {
    while (this.windows.size > this.maxKeys) {
      const oldest = this.windows.keys().next().value as string;
      this.windows.delete(oldest);
    }
  }
}
