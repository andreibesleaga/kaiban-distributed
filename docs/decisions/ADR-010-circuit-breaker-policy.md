# ADR-010: Sliding-window circuit breaker

- Status: Accepted
- Date: 2026-06

## Context
A failing LLM provider or downstream dependency can cause every agent to retry in
lockstep, amplifying load and cascading failures (OWASP ASI08). The actor already
retries 3× with linear backoff before DLQ; we need a higher-level guard.

## Decision
`ICircuitBreaker` is a domain interface; `SlidingWindowBreaker`
(`src/infrastructure/security/sliding-window-breaker.ts`) trips when failures within
a rolling window exceed a threshold (defaults: `CIRCUIT_BREAKER_THRESHOLD=10`,
`CIRCUIT_BREAKER_WINDOW_MS=60000`). It is **opt-in** via `CIRCUIT_BREAKER_ENABLED`.
While open, new messages route straight to the DLQ instead of hammering the
dependency. Maps to OWASP ASI08 (Cascading Failures) / LLM10 (Unbounded Consumption).

## Consequences
- **+** Bounds blast radius of a sick dependency; configurable per deployment.
- **+** Composes with retry/DLQ and the per-task timeout.
- **−** A tripped breaker fast-fails tasks to the DLQ — operators must monitor DLQ
  depth and tune the threshold for their workload.
