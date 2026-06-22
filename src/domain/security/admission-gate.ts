/**
 * Admission-gate port (master plan §B5.1 Phase G hot-path enforcement, ADR-021).
 *
 * An OPTIONAL pre-execution guard the `AgentActor` consults BEFORE running a task
 * handler — alongside the circuit breaker and semantic firewall. A blocked verdict
 * routes the task to the DLQ without executing (so no tokens are burned).
 *
 * Concrete implementations adapt the governance Action Gate (+ economics cost
 * reservation) into this port — see `shared/admission-gate.ts`. Default-OFF: when
 * no admission gate is wired, the actor behaves exactly as before. Domain layer —
 * no framework imports.
 */
import type { EvaluationPayload } from "./semantic-firewall";

export interface AdmissionVerdict {
  /** True ⇒ proceed with execution; false ⇒ block (route to DLQ, do not run). */
  allowed: boolean;
  /** Why the task was blocked (undefined when allowed). */
  reason?: string;
}

export interface IAdmissionGate {
  /** Decide whether a task may execute. Reuses the firewall's `EvaluationPayload`. */
  evaluate(payload: EvaluationPayload): Promise<AdmissionVerdict>;
}
