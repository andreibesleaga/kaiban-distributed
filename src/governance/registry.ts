/**
 * Agent registry + kill-switch (PDLSS) (master plan §B5.1 Phase G, ADR-020).
 *
 * Holds every agent's PDLSS registration (Purpose / Duration / Limit / Scope /
 * Self-instantiation) and decides whether an agent is currently usable. The
 * {@link AgentRegistry.revoke} method is the **kill-switch**: an instant,
 * non-bypassable deactivation that a {@link GateValidator} surfaces as a
 * `terminate` verdict.
 *
 * Exposed as a {@link GateValidator} via {@link AgentRegistry.asValidator} so the
 * Action Gate consults it like any other validator: active ⇒ `allow`, revoked ⇒
 * `terminate`, every other inactive reason ⇒ `block`.
 */

import type {
  AgentRegistration,
  GateContext,
  GateOperation,
  GateValidator,
  GateVerdict,
  RegistryStatus,
} from "./types";

const VALIDATOR_NAME = "kill-switch" as const;
const REVOKED_PREFIX = "revoked: " as const;

/** Internal mutable state tracked per registered agent. */
interface AgentRecord {
  registration: AgentRegistration;
  invocations: number;
  revokedReason?: string;
}

/** Default clock for {@link AgentRegistry.asValidator}: the current ISO instant. */
function defaultNow(): string {
  return new Date().toISOString();
}

/** In-memory agent registry implementing the PDLSS kill-switch contract. */
export class AgentRegistry {
  private readonly records = new Map<string, AgentRecord>();

  /** Upsert by agentId — clears any prior revocation and resets the count to 0. */
  public register(reg: AgentRegistration): void {
    this.records.set(reg.agentId, { registration: reg, invocations: 0 });
  }

  /** The kill-switch: instantly deactivate an agent (default reason `"revoked"`). */
  public revoke(agentId: string, reason = "revoked"): void {
    const record = this.records.get(agentId);
    if (record !== undefined) {
      record.revokedReason = reason;
    }
  }

  /** Increment an agent's invocation counter (no-op for unknown agents). */
  public recordInvocation(agentId: string): void {
    const record = this.records.get(agentId);
    if (record !== undefined) {
      record.invocations += 1;
    }
  }

  /** Whether the agent is currently usable, with a specific inactivity reason. */
  public status(
    agentId: string,
    opts?: { now?: string; operation?: GateOperation },
  ): RegistryStatus {
    const record = this.records.get(agentId);
    if (record === undefined) {
      return inactive("not registered");
    }
    if (record.revokedReason !== undefined) {
      return inactive(`${REVOKED_PREFIX}${record.revokedReason}`);
    }
    if (this.isExpired(record, opts?.now)) {
      return inactive("expired");
    }
    if (this.overLimit(record)) {
      return inactive("invocation limit reached");
    }
    if (this.outOfScope(record, opts?.operation)) {
      return inactive("operation out of scope");
    }
    return { active: true, reason: "active" };
  }

  /** True only when registered, not revoked, and `selfInstantiation` is set. */
  public mayInstantiate(agentId: string): boolean {
    const record = this.records.get(agentId);
    return (
      record !== undefined &&
      record.revokedReason === undefined &&
      record.registration.selfInstantiation
    );
  }

  /** Expose the registry as a {@link GateValidator} named `"kill-switch"`. */
  public asValidator(opts?: { now?: () => string }): GateValidator {
    const now = opts?.now ?? defaultNow;
    const check = (ctx: GateContext): GateVerdict => {
      const result = this.status(ctx.agentId, {
        now: now(),
        operation: ctx.operation,
      });
      return {
        action: toAction(result),
        reason: result.reason,
        validator: VALIDATOR_NAME,
      };
    };
    return { name: VALIDATOR_NAME, check };
  }

  private isExpired(record: AgentRecord, now?: string): boolean {
    const { expiresAt } = record.registration;
    return expiresAt !== undefined && now !== undefined && expiresAt < now;
  }

  private overLimit(record: AgentRecord): boolean {
    const limit = record.registration.invocationLimit ?? 0;
    return limit > 0 && record.invocations >= limit;
  }

  private outOfScope(record: AgentRecord, operation?: GateOperation): boolean {
    const { scope } = record.registration;
    return (
      operation !== undefined &&
      scope !== undefined &&
      !scope.includes(operation)
    );
  }
}

/** Build an inactive {@link RegistryStatus} with the given reason. */
function inactive(reason: string): RegistryStatus {
  return { active: false, reason };
}

/** Map a {@link RegistryStatus} to a gate action (active→allow, revoked→terminate, else→block). */
function toAction(status: RegistryStatus): GateVerdict["action"] {
  if (status.active) {
    return "allow";
  }
  return status.reason.startsWith(REVOKED_PREFIX) ? "terminate" : "block";
}
