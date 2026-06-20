/**
 * Action Gate — external, non-bypassable enforcement (master plan §B5.1 Phase G,
 * ADR-020).
 *
 * Every gated operation passes through an ordered set of `GateValidator`s. The
 * gate aggregates their verdicts to the MOST SEVERE action and records the
 * decision to a tamper-evident `AuditSink`.
 *
 * Posture (invariant #8): **opt-in / no-op when disabled; non-bypassable when
 * enabled**. With `GovernanceConfig.enabled = false` the gate is a passthrough
 * (`allow`) that consults NO validator and records NOTHING. When enabled it runs
 * EVERY validator (no short-circuit, so the audit captures all verdicts), orders
 * the deciding (most-severe, first-encountered at that severity) verdict first,
 * appends the decision to the audit sink, and returns it.
 *
 * The file also exports thin adapter factories turning existing components
 * (semantic firewall, circuit breaker, cost reservation) into `GateValidator`s,
 * so they plug into the gate without being coupled to it.
 */
import {
  GATE_ACTION_SEVERITY,
  type AuditSink,
  type GateContext,
  type GateDecision,
  type GateValidator,
  type GateVerdict,
  type GovernanceConfig,
} from "./types";
import type {
  ISemanticFirewall,
  EvaluationPayload,
} from "../domain/security/semantic-firewall";
import type { ICircuitBreaker } from "../domain/security/circuit-breaker";
import type { BudgetScope, CostUnits, AdmissionResult } from "../economics/types";

/** What the `ActionGate` is constructed with. */
export interface ActionGateDeps {
  config: GovernanceConfig;
  validators: GateValidator[];
  audit: AuditSink;
  /** Timestamp source for audit records (injected — deterministic in tests). */
  clock?: () => string;
}

/**
 * The external enforcement point. Opt-in / no-op when `config.enabled` is false;
 * non-bypassable (runs every validator, most-severe wins) when enabled.
 */
export class ActionGate {
  private readonly config: GovernanceConfig;
  private readonly validators: GateValidator[];
  private readonly audit: AuditSink;
  private readonly clock: () => string;

  public constructor(deps: ActionGateDeps) {
    this.config = deps.config;
    this.validators = deps.validators;
    this.audit = deps.audit;
    this.clock = deps.clock ?? ((): string => new Date().toISOString());
  }

  /** Evaluate a gated operation against all validators and record the decision. */
  public async evaluate(ctx: GateContext): Promise<GateDecision> {
    if (!this.config.enabled) {
      return { action: "allow", verdicts: [], context: ctx };
    }

    const verdicts: GateVerdict[] = [];
    for (const validator of this.validators) {
      verdicts.push(await this.runValidator(validator, ctx));
    }

    const ordered = orderBySeverity(verdicts);
    const action = ordered[0]?.action ?? "allow";
    const decision: GateDecision = { action, verdicts: ordered, context: ctx };
    this.audit.append(decision, this.clock());
    return decision;
  }

  /**
   * Run one validator, **failing closed**: a validator that throws (e.g. a
   * cost-reservation validator when Redis is unreachable) yields a `block`
   * verdict rather than propagating — a security gate must never error-out into
   * an unhandled task path.
   */
  private async runValidator(
    validator: GateValidator,
    ctx: GateContext,
  ): Promise<GateVerdict> {
    try {
      return await Promise.resolve(validator.check(ctx));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        action: "block",
        reason: `validator error: ${reason}`,
        validator: validator.name,
      };
    }
  }
}

/**
 * Order verdicts so the deciding one is first: most-severe wins, ties broken by
 * first-encountered. A stable sort by descending severity satisfies both.
 */
function orderBySeverity(verdicts: GateVerdict[]): GateVerdict[] {
  return [...verdicts].sort(
    (a, b): number =>
      GATE_ACTION_SEVERITY[b.action] - GATE_ACTION_SEVERITY[a.action],
  );
}

// ── Adapter factories ──────────────────────────────────────────────────────────

/** Adapt a `ISemanticFirewall` into a `GateValidator` (allow / block). */
export function firewallValidator(firewall: ISemanticFirewall): GateValidator {
  return {
    name: "semantic-firewall",
    async check(ctx: GateContext): Promise<GateVerdict> {
      const payload: EvaluationPayload = {
        taskId: String(ctx.payload["taskId"] ?? ctx.agentId),
        agentId: ctx.agentId,
        data: ctx.payload,
      };
      const verdict = await firewall.evaluate(payload);
      if (verdict.allowed) {
        return {
          action: "allow",
          reason: "firewall allowed",
          validator: "semantic-firewall",
        };
      }
      return {
        action: "block",
        reason: verdict.reason ?? "firewall blocked",
        validator: "semantic-firewall",
      };
    },
  };
}

/** Adapt an `ICircuitBreaker` into a `GateValidator` (open ⇒ escalate). */
export function breakerValidator(breaker: ICircuitBreaker): GateValidator {
  return {
    name: "circuit-breaker",
    check(_ctx: GateContext): GateVerdict {
      if (breaker.isOpen()) {
        return {
          action: "escalate",
          reason: "circuit breaker open",
          validator: "circuit-breaker",
        };
      }
      return {
        action: "allow",
        reason: "circuit breaker closed",
        validator: "circuit-breaker",
      };
    },
  };
}

/** Minimal cost-reservation surface — kept local so the gate stays decoupled. */
export interface CostReservationLike {
  admit(scope: BudgetScope, units: CostUnits): Promise<AdmissionResult>;
}

const COST_ACTION: Record<AdmissionResult["decision"], GateVerdict["action"]> = {
  allow: "allow",
  degrade: "degrade",
  reject: "block",
};

/** Adapt a cost reservation into a `GateValidator` (allow / degrade / block). */
export function costValidator(
  reservation: CostReservationLike,
  scopeFor?: (ctx: GateContext) => BudgetScope,
): GateValidator {
  return {
    name: "cost-reservation",
    async check(ctx: GateContext): Promise<GateVerdict> {
      const units = ctx.estimatedCostUnits ?? 0;
      const scope = scopeFor?.(ctx) ?? defaultScope(ctx);
      const result = await reservation.admit(scope, units);
      return {
        action: COST_ACTION[result.decision],
        reason: result.reason,
        validator: "cost-reservation",
      };
    },
  };
}

/** Default budget scope: agent always, tenant only when present. */
function defaultScope(ctx: GateContext): BudgetScope {
  return {
    agentId: ctx.agentId,
    ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
  };
}
