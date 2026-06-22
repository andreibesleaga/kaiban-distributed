/**
 * Readiness + startup probes (master plan §B5.1 Phase R, ADR-018).
 *
 * Kubernetes (and any orchestrator) distinguishes three liveness signals:
 *   - **liveness** — "is the process alive?" → the existing `/health`.
 *   - **readiness** (`/ready`) — "should traffic be routed here *right now*?" It
 *     verifies the process's downstream dependencies (Redis + the messaging
 *     broker) are reachable; a not-ready replica is pulled from the Service
 *     endpoints without being restarted.
 *   - **startup** (`/startup`) — "has one-time boot finished?" It guards slow
 *     starts so the readiness/liveness probes don't trip during boot.
 *
 * Both probes are built from **pluggable, infrastructure-agnostic check
 * functions** (a Redis `ping`, a broker reachability poke, …). The resilience
 * layer never imports a concrete driver — the caller wires the checks — so this
 * stays unit-testable with zero brokers and respects the layer boundaries
 * (no infrastructure import). It performs no writes and touches neither the
 * state nor HITL channels (I4/I5 unaffected).
 */

/** A single named readiness check; resolves `true` when the dependency is up. */
export interface ProbeCheck {
  name: string;
  check: () => Promise<boolean>;
}

/** The outcome of one check inside a probe result. */
export interface ProbeCheckResult {
  name: string;
  ok: boolean;
  /** Present only when the check threw — the stringified failure reason. */
  error?: string;
}

/** The aggregate probe result returned to the HTTP handler. */
export interface ProbeResult {
  ready: boolean;
  checks: ProbeCheckResult[];
}

/** Dependencies for the readiness probe — the set of checks to run. */
export interface ReadinessDeps {
  checks: ProbeCheck[];
}

function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

async function runCheck(c: ProbeCheck): Promise<ProbeCheckResult> {
  try {
    const ok = await c.check();
    return { name: c.name, ok };
  } catch (err: unknown) {
    return { name: c.name, ok: false, error: toMessage(err) };
  }
}

/**
 * Build a readiness probe. The returned function runs every check
 * **concurrently** and reports `ready: true` only when all pass; a check that
 * throws is reported as `ok: false` with its message (it never crashes the probe).
 */
export function buildReadinessProbe(
  deps: ReadinessDeps,
): () => Promise<ProbeResult> {
  return async (): Promise<ProbeResult> => {
    const checks = await Promise.all(deps.checks.map(runCheck));
    return { ready: checks.every((c) => c.ok), checks };
  };
}

/** Dependencies for the startup probe — a predicate that flips true once boot completes. */
export interface StartupDeps {
  started: () => boolean;
}

/**
 * Build a startup probe. The returned function reports `ready` mirroring the
 * `started()` predicate, surfaced as a single `startup` check.
 */
export function buildStartupProbe(
  deps: StartupDeps,
): () => Promise<ProbeResult> {
  return (): Promise<ProbeResult> => {
    const ok = deps.started();
    return Promise.resolve({ ready: ok, checks: [{ name: "startup", ok }] });
  };
}
