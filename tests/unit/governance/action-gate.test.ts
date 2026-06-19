/**
 * Action Gate — external, non-bypassable enforcement (master plan §B5.1 Phase G,
 * ADR-020).
 *
 * The gate is **opt-in / no-op when disabled**: with `GovernanceConfig.enabled =
 * false` it returns `allow` with an empty verdict list, consulting NO validator
 * and recording NOTHING. When enabled it runs EVERY validator (no short-circuit,
 * so the audit captures all), aggregates to the MOST-SEVERE action, orders the
 * deciding verdict first, records the decision to the `AuditSink`, and returns it.
 *
 * Validators and the audit sink are faked as plain objects (some `check`s async)
 * so every branch is driven deterministically with no real components.
 */
import { describe, it, expect } from "vitest";
import {
  ActionGate,
  firewallValidator,
  breakerValidator,
  costValidator,
} from "../../../src/governance/action-gate";
import type {
  GateContext,
  GateDecision,
  GateValidator,
  GateVerdict,
  AuditRecord,
  AuditSink,
  GovernanceConfig,
} from "../../../src/governance/types";
import type {
  ISemanticFirewall,
  EvaluationPayload,
  FirewallVerdict,
} from "../../../src/domain/security/semantic-firewall";
import type { ICircuitBreaker } from "../../../src/domain/security/circuit-breaker";
import type {
  BudgetScope,
  CostUnits,
  AdmissionResult,
} from "../../../src/economics/types";

// ── Fakes ────────────────────────────────────────────────────────────────────

function ctx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    operation: "tool-call",
    agentId: "agent-1",
    payload: {},
    ...overrides,
  };
}

function verdict(
  action: GateVerdict["action"],
  validator: string,
): GateVerdict {
  return { action, reason: `${validator}:${action}`, validator };
}

function syncValidator(name: string, v: GateVerdict): GateValidator {
  return { name, check: (): GateVerdict => v };
}

function asyncValidator(name: string, v: GateVerdict): GateValidator {
  return { name, check: (): Promise<GateVerdict> => Promise.resolve(v) };
}

interface RecordingAudit extends AuditSink {
  appended: Array<{ decision: GateDecision; timestamp: string }>;
}

function makeAudit(): RecordingAudit {
  const appended: Array<{ decision: GateDecision; timestamp: string }> = [];
  return {
    appended,
    append(decision: GateDecision, timestamp: string): AuditRecord {
      appended.push({ decision, timestamp });
      return {
        index: appended.length - 1,
        timestamp,
        decision,
        prevHash: "",
        hash: "h",
      };
    },
  };
}

function config(enabled: boolean): GovernanceConfig {
  return { enabled };
}

// ── ActionGate.evaluate ───────────────────────────────────────────────────────

describe("ActionGate.evaluate", () => {
  it("disabled ⇒ allow with empty verdicts, consulting no validator and recording nothing", async () => {
    const audit = makeAudit();
    const validator = syncValidator("never", verdict("block", "never"));
    const gate = new ActionGate({
      config: config(false),
      validators: [validator],
      audit,
    });
    const context = ctx();

    const decision = await gate.evaluate(context);

    expect(decision).toEqual({ action: "allow", verdicts: [], context });
    expect(audit.appended).toHaveLength(0);
  });

  it("enabled all-allow ⇒ allow + audit called once with the decision and injected timestamp", async () => {
    const audit = makeAudit();
    const gate = new ActionGate({
      config: config(true),
      validators: [
        syncValidator("a", verdict("allow", "a")),
        asyncValidator("b", verdict("allow", "b")),
      ],
      audit,
      clock: (): string => "2026-06-19T00:00:00.000Z",
    });

    const decision = await gate.evaluate(ctx());

    expect(decision.action).toBe("allow");
    expect(decision.verdicts.map((v) => v.validator)).toEqual(["a", "b"]);
    expect(audit.appended).toHaveLength(1);
    expect(audit.appended[0]?.decision).toBe(decision);
    expect(audit.appended[0]?.timestamp).toBe("2026-06-19T00:00:00.000Z");
  });

  it("mixed-severity ⇒ most-severe action with the deciding verdict first (no short-circuit)", async () => {
    const audit = makeAudit();
    const gate = new ActionGate({
      config: config(true),
      validators: [
        syncValidator("a", verdict("allow", "a")),
        asyncValidator("b", verdict("block", "b")),
        syncValidator("c", verdict("degrade", "c")),
      ],
      audit,
      clock: (): string => "T",
    });

    const decision = await gate.evaluate(ctx());

    expect(decision.action).toBe("block");
    expect(decision.verdicts[0]?.validator).toBe("b");
    // every validator ran (no short-circuit) — all three verdicts captured
    expect(decision.verdicts).toHaveLength(3);
    expect(decision.verdicts.map((v) => v.validator).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("ties keep the FIRST-encountered verdict at the deciding severity first", async () => {
    const audit = makeAudit();
    const gate = new ActionGate({
      config: config(true),
      validators: [
        syncValidator("first-block", verdict("block", "first-block")),
        syncValidator("second-block", verdict("block", "second-block")),
      ],
      audit,
    });

    const decision = await gate.evaluate(ctx());

    expect(decision.action).toBe("block");
    expect(decision.verdicts[0]?.validator).toBe("first-block");
  });

  it("enabled with NO validators ⇒ allow (empty verdicts) and still records", async () => {
    const audit = makeAudit();
    const gate = new ActionGate({
      config: config(true),
      validators: [],
      audit,
      clock: (): string => "T",
    });

    const decision = await gate.evaluate(ctx());

    expect(decision.action).toBe("allow");
    expect(decision.verdicts).toEqual([]);
    expect(audit.appended).toHaveLength(1);
  });

  it("default clock ⇒ a string ISO timestamp reaches the audit", async () => {
    const audit = makeAudit();
    const gate = new ActionGate({
      config: config(true),
      validators: [syncValidator("a", verdict("allow", "a"))],
      audit,
    });

    await gate.evaluate(ctx());

    expect(audit.appended).toHaveLength(1);
    expect(typeof audit.appended[0]?.timestamp).toBe("string");
    expect(audit.appended[0]?.timestamp.length).toBeGreaterThan(0);
  });
});

// ── firewallValidator ──────────────────────────────────────────────────────────

describe("firewallValidator", () => {
  function fakeFirewall(v: FirewallVerdict): {
    fw: ISemanticFirewall;
    calls: EvaluationPayload[];
  } {
    const calls: EvaluationPayload[] = [];
    const fw: ISemanticFirewall = {
      evaluate(payload: EvaluationPayload): Promise<FirewallVerdict> {
        calls.push(payload);
        return Promise.resolve(v);
      },
    };
    return { fw, calls };
  }

  it("allowed ⇒ allow, with the payload built from ctx (taskId from payload)", async () => {
    const { fw, calls } = fakeFirewall({ allowed: true });
    const validator = firewallValidator(fw);
    expect(validator.name).toBe("semantic-firewall");

    const context = ctx({ payload: { taskId: "t-9", foo: "bar" } });
    const v = await validator.check(context);

    expect(v.action).toBe("allow");
    expect(v.validator).toBe("semantic-firewall");
    expect(calls[0]).toEqual({
      taskId: "t-9",
      agentId: "agent-1",
      data: { taskId: "t-9", foo: "bar" },
    });
  });

  it("blocked ⇒ block, reason from the verdict; taskId falls back to agentId", async () => {
    const { fw, calls } = fakeFirewall({ allowed: false, reason: "unsafe" });
    const validator = firewallValidator(fw);

    const context = ctx({ agentId: "agent-x", payload: {} });
    const v = await validator.check(context);

    expect(v.action).toBe("block");
    expect(v.reason).toBe("unsafe");
    expect(calls[0]?.taskId).toBe("agent-x");
  });

  it("blocked without a reason ⇒ a default reason string", async () => {
    const { fw } = fakeFirewall({ allowed: false });
    const validator = firewallValidator(fw);

    const v = await validator.check(ctx());

    expect(v.action).toBe("block");
    expect(typeof v.reason).toBe("string");
    expect(v.reason.length).toBeGreaterThan(0);
  });
});

// ── breakerValidator ────────────────────────────────────────────────────────────

describe("breakerValidator", () => {
  function fakeBreaker(open: boolean): ICircuitBreaker {
    return {
      isOpen: (): boolean => open,
      recordSuccess: (): void => undefined,
      recordFailure: (): void => undefined,
    };
  }

  it("open ⇒ escalate", () => {
    const validator = breakerValidator(fakeBreaker(true));
    expect(validator.name).toBe("circuit-breaker");

    const v = validator.check(ctx());

    expect(v).toMatchObject({ action: "escalate", validator: "circuit-breaker" });
  });

  it("closed ⇒ allow", () => {
    const validator = breakerValidator(fakeBreaker(false));

    const v = validator.check(ctx());

    expect((v as GateVerdict).action).toBe("allow");
  });
});

// ── costValidator ──────────────────────────────────────────────────────────────

describe("costValidator", () => {
  function fakeReservation(result: AdmissionResult): {
    reservation: { admit(scope: BudgetScope, units: CostUnits): Promise<AdmissionResult> };
    calls: Array<{ scope: BudgetScope; units: CostUnits }>;
  } {
    const calls: Array<{ scope: BudgetScope; units: CostUnits }> = [];
    const reservation = {
      admit(scope: BudgetScope, units: CostUnits): Promise<AdmissionResult> {
        calls.push({ scope, units });
        return Promise.resolve(result);
      },
    };
    return { reservation, calls };
  }

  function admission(decision: AdmissionResult["decision"]): AdmissionResult {
    return { decision, remaining: 10, utilization: 0.1, reason: "r" };
  }

  it("admit allow ⇒ allow; units default 0; default scope without tenantId", async () => {
    const { reservation, calls } = fakeReservation(admission("allow"));
    const validator = costValidator(reservation);
    expect(validator.name).toBe("cost-reservation");

    const v = await validator.check(ctx({ agentId: "agent-7" }));

    expect(v.action).toBe("allow");
    expect(calls[0]?.units).toBe(0);
    expect(calls[0]?.scope).toEqual({ agentId: "agent-7" });
  });

  it("admit degrade ⇒ degrade; uses estimatedCostUnits; default scope WITH tenantId", async () => {
    const { reservation, calls } = fakeReservation(admission("degrade"));
    const validator = costValidator(reservation);

    const v = await validator.check(
      ctx({ agentId: "a", tenantId: "tenant-1", estimatedCostUnits: 42 }),
    );

    expect(v.action).toBe("degrade");
    expect(calls[0]?.units).toBe(42);
    expect(calls[0]?.scope).toEqual({ agentId: "a", tenantId: "tenant-1" });
  });

  it("admit reject ⇒ block", async () => {
    const { reservation } = fakeReservation(admission("reject"));
    const validator = costValidator(reservation);

    const v = await validator.check(ctx());

    expect(v.action).toBe("block");
  });

  it("scopeFor override is used instead of the default scope", async () => {
    const { reservation, calls } = fakeReservation(admission("allow"));
    const scopeFor = (c: GateContext): BudgetScope => ({
      tenantId: `override-${c.agentId}`,
    });
    const validator = costValidator(reservation, scopeFor);

    await validator.check(ctx({ agentId: "agent-9" }));

    expect(calls[0]?.scope).toEqual({ tenantId: "override-agent-9" });
  });
});
