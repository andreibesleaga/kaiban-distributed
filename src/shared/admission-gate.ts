/**
 * Admission-gate adapters (master plan §B5.1 Phase G hot-path enforcement, ADR-021).
 *
 * Bridges the governance Action Gate (+ economics cost reservation) into the
 * `IAdmissionGate` port the `AgentActor` consults before executing a task:
 *   - `buildAdmissionGate(gate, opts)` — wrap any `ActionGate` as an `IAdmissionGate`
 *     (allow/degrade ⇒ proceed; escalate/block/terminate ⇒ block → DLQ).
 *   - `buildWorkerAdmissionGate(governance, deps)` — assemble the default worker
 *     gate from config: policy-as-code (always) + cost reservation (when economics
 *     is enabled AND a limiter is injected). Returns `undefined` when governance is
 *     disabled, so the actor stays in its default (no-gate) behavior.
 *
 * The worker gate intentionally does NOT include firewall/breaker validators (the
 * actor already runs those directly) nor the agent registry (an empty registry
 * would block every agent — it is a consumer-managed validator). See ADR-021.
 */
import { readFileSync } from "fs";
import type {
  IAdmissionGate,
  AdmissionVerdict,
} from "../domain/security/admission-gate";
import type { EvaluationPayload } from "../domain/security/semantic-firewall";
import {
  ActionGate,
  costValidator,
} from "../governance/action-gate";
import { PolicyEngine, loadPolicySet } from "../governance/policy-engine";
import { AuditLog } from "../governance/audit-log";
import type {
  GateContext,
  GateOperation,
  GateValidator,
  GovernanceConfig,
  PolicySet,
} from "../governance/types";
import { CostReservation } from "../economics/cost-reservation";
import type { CostLimiterPort, EconomicsConfig } from "../economics/types";

/** Gate actions that permit execution; everything else blocks (→ DLQ). */
const PASSING_ACTIONS: ReadonlySet<string> = new Set(["allow", "degrade"]);

export interface AdmissionGateOptions {
  /** Gate operation for the context (default `"tool-call"`). */
  operation?: GateOperation;
  /** Derive the tenant id from the payload (for per-tenant budgets). */
  tenantIdOf?: (payload: EvaluationPayload) => string | undefined;
  /** Derive an estimated cost (cost units) for cost-reservation validators. */
  estimatedCostUnitsOf?: (payload: EvaluationPayload) => number | undefined;
}

/** Wrap an `ActionGate` as the actor's `IAdmissionGate` guard. */
export function buildAdmissionGate(
  gate: Pick<ActionGate, "evaluate">,
  opts: AdmissionGateOptions = {},
): IAdmissionGate {
  return {
    async evaluate(payload: EvaluationPayload): Promise<AdmissionVerdict> {
      const tenantId = opts.tenantIdOf?.(payload);
      const cost = opts.estimatedCostUnitsOf?.(payload);
      const ctx: GateContext = {
        operation: opts.operation ?? "tool-call",
        agentId: payload.agentId,
        payload: payload.data,
        ...(tenantId !== undefined ? { tenantId } : {}),
        ...(cost !== undefined ? { estimatedCostUnits: cost } : {}),
      };
      const decision = await gate.evaluate(ctx);
      return PASSING_ACTIONS.has(decision.action)
        ? { allowed: true }
        : { allowed: false, reason: `gate:${decision.action}` };
    },
  };
}

export interface WorkerAdmissionGateDeps {
  /** Economics config — when `enabled` AND `costLimiter` is given, adds cost reservation. */
  economics?: EconomicsConfig;
  /** Limiter backing the cost-reservation validator (e.g. a Redis `RateCostLimiter`). */
  costLimiter?: CostLimiterPort;
  /** Forwarded to `buildAdmissionGate` (operation / scope / cost derivation). */
  options?: AdmissionGateOptions;
}

/**
 * Assemble the default worker admission gate from config. Returns `undefined`
 * (actor runs un-gated) when governance is disabled.
 */
export function buildWorkerAdmissionGate(
  governance: GovernanceConfig,
  deps: WorkerAdmissionGateDeps = {},
): IAdmissionGate | undefined {
  if (!governance.enabled) return undefined;

  const policies: PolicySet = governance.policiesPath
    ? loadPolicySet(readFileSync(governance.policiesPath, "utf8"))
    : { default: "allow", rules: [] };
  const validators: GateValidator[] = [new PolicyEngine(policies)];

  if (deps.economics?.enabled && deps.costLimiter) {
    const reservation = new CostReservation({
      config: deps.economics,
      limiter: deps.costLimiter,
    });
    validators.push(costValidator(reservation));
  }

  const gate = new ActionGate({
    config: governance,
    validators,
    audit: new AuditLog(),
  });
  return buildAdmissionGate(gate, deps.options ?? {});
}
