// SPDX-License-Identifier: Apache-2.0
// ── In-memory sliding-window rate limiter (zero-dependency) ──────────

/** Per-key sliding window: at most `maxRequests` per `windowMs`. */
export class SlidingWindowRateLimiter {
  private windows = new Map<string, number[]>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly maxRequests = 100,
  ) {}

  isAllowed(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }
    // Evict expired entries
    while (timestamps.length > 0 && timestamps[0]! < cutoff) {
      timestamps.shift();
    }
    // Prune dead keys to prevent unbounded Map growth under IP-spray attacks.
    // Replace the stale array with a fresh one (also handles brand-new keys correctly).
    if (timestamps.length === 0) {
      const fresh = [now];
      this.windows.set(key, fresh);
      return true;
    }
    if (timestamps.length >= this.maxRequests) return false;
    timestamps.push(now);
    return true;
  }
}

