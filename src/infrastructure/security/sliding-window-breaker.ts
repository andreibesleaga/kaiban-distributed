import type { ICircuitBreaker } from "../../domain/security/circuit-breaker";

/**
 * Sliding-window circuit breaker.
 * Tracks failures within a rolling time window and trips (opens) when failures
 * exceed the configured threshold. Once open, it remains open until the window
 * duration passes without new failures.
 *
 * Emits console warnings when tripping — OTLP span events should be wired
 * at the caller level (AgentActor) for proper distributed tracing.
 */
export class SlidingWindowBreaker implements ICircuitBreaker {
  private failures: number[] = [];
  private threshold: number;
  private windowMs: number;
  private opened = false;

  constructor(threshold: number, windowMs: number) {
    this.threshold = threshold;
    this.windowMs = windowMs;
  }

  recordSuccess(): void {
    this.pruneOldFailures();
    if (this.opened && this.failures.length < this.threshold) {
      this.opened = false;
      console.log("[CircuitBreaker] Circuit closed — recovered");
    }
  }

  recordFailure(): void {
    this.failures.push(Date.now());
    this.pruneOldFailures();

    if (!this.opened && this.failures.length >= this.threshold) {
      this.opened = true;
      console.warn(
        `[CircuitBreaker] Circuit OPEN — ${this.failures.length} failures in ${this.windowMs}ms window`,
      );
    }
  }

  isOpen(): boolean {
    this.pruneOldFailures();
    if (this.opened && this.failures.length < this.threshold) {
      this.opened = false;
    }
    return this.opened;
  }

  private pruneOldFailures(): void {
    const cutoff = Date.now() - this.windowMs;
    this.failures = this.failures.filter((ts) => ts > cutoff);
  }
}
