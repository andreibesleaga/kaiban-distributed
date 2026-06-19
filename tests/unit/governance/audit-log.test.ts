import { describe, it, expect } from "vitest";
import { AuditLog } from "../../../src/governance/audit-log";
import type {
  GateAction,
  GateContext,
  GateDecision,
  GateOperation,
} from "../../../src/governance/types";

const TS = "2026-06-19T00:00:00.000Z";

/** Build a minimal `GateDecision` for the audit chain under test. */
function makeDecision(
  action: GateAction = "allow",
  operation: GateOperation = "tool-call",
  agentId = "agent-1",
): GateDecision {
  const context: GateContext = {
    operation,
    agentId,
    payload: { foo: "bar" },
  };
  return {
    action,
    verdicts: [{ action, reason: "ok", validator: "test" }],
    context,
  };
}

describe("AuditLog", () => {
  it("genesis record has empty prevHash and index 0", () => {
    const log = new AuditLog();
    const record = log.append(makeDecision(), TS);

    expect(record.index).toBe(0);
    expect(record.prevHash).toBe("");
    expect(record.timestamp).toBe(TS);
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(log.records()).toHaveLength(1);
  });

  it("links a 3-record chain (prevHash === previous hash)", () => {
    const log = new AuditLog();
    const r0 = log.append(makeDecision("allow"), TS);
    const r1 = log.append(makeDecision("degrade"), TS);
    const r2 = log.append(makeDecision("block"), TS);

    expect(r0.index).toBe(0);
    expect(r1.index).toBe(1);
    expect(r2.index).toBe(2);
    expect(r1.prevHash).toBe(r0.hash);
    expect(r2.prevHash).toBe(r1.hash);
    expect(log.records()).toHaveLength(3);
  });

  it("verifies an untampered chain as valid", () => {
    const log = new AuditLog();
    log.append(makeDecision("allow"), TS);
    log.append(makeDecision("degrade"), TS);
    log.append(makeDecision("escalate"), TS);

    expect(log.verify()).toEqual({ valid: true });
  });

  it("verifies an empty log as valid", () => {
    const log = new AuditLog();
    expect(log.verify()).toEqual({ valid: true });
  });

  it("detects content tampering (mutated decision.action)", () => {
    const log = new AuditLog();
    log.append(makeDecision("allow"), TS);
    log.append(makeDecision("allow"), TS);
    log.append(makeDecision("allow"), TS);

    // Records are references — mutate a stored record's content.
    const tampered = log.records()[1];
    tampered.decision.action = "terminate";

    expect(log.verify()).toEqual({ valid: false, brokenAt: 1 });
  });

  it("detects linkage tampering (mutated prevHash)", () => {
    const log = new AuditLog();
    log.append(makeDecision("allow"), TS);
    log.append(makeDecision("degrade"), TS);
    log.append(makeDecision("block"), TS);

    const tampered = log.records()[2];
    tampered.prevHash = "0".repeat(64);

    expect(log.verify()).toEqual({ valid: false, brokenAt: 2 });
  });

  it("returns a readonly snapshot via records()", () => {
    const log = new AuditLog();
    log.append(makeDecision(), TS);
    expect(Array.isArray(log.records())).toBe(true);
  });
});
