import { describe, it, expect } from "vitest";
import { AgentRegistry } from "../../../src/governance/registry";
import type {
  AgentRegistration,
  GateContext,
  GateOperation,
} from "../../../src/governance/types";

/** A fixed reference instant + a later one, for deterministic expiry tests. */
const NOW = "2026-06-19T12:00:00.000Z";
const LATER = "2026-06-19T13:00:00.000Z";

function reg(over: Partial<AgentRegistration> = {}): AgentRegistration {
  return {
    agentId: "agent-1",
    purpose: "unit test",
    selfInstantiation: false,
    ...over,
  };
}

function ctx(over: Partial<GateContext> = {}): GateContext {
  return {
    operation: "tool-call",
    agentId: "agent-1",
    payload: {},
    ...over,
  };
}

describe("AgentRegistry.status", () => {
  it("reports 'not registered' for an unknown agent", () => {
    const registry = new AgentRegistry();
    expect(registry.status("ghost")).toEqual({
      active: false,
      reason: "not registered",
    });
  });

  it("reports 'active' for a freshly registered agent", () => {
    const registry = new AgentRegistry();
    registry.register(reg());
    expect(registry.status("agent-1")).toEqual({
      active: true,
      reason: "active",
    });
  });

  it("reports a revocation with its reason (kill-switch)", () => {
    const registry = new AgentRegistry();
    registry.register(reg());
    registry.revoke("agent-1", "compromised");
    expect(registry.status("agent-1")).toEqual({
      active: false,
      reason: "revoked: compromised",
    });
  });

  it("uses the default revoke reason 'revoked' when none is given", () => {
    const registry = new AgentRegistry();
    registry.register(reg());
    registry.revoke("agent-1");
    expect(registry.status("agent-1")).toEqual({
      active: false,
      reason: "revoked: revoked",
    });
  });

  it("reports 'expired' when expiresAt is before the given now", () => {
    const registry = new AgentRegistry();
    registry.register(reg({ expiresAt: NOW }));
    expect(registry.status("agent-1", { now: LATER })).toEqual({
      active: false,
      reason: "expired",
    });
  });

  it("is still active at-or-after registration when no now is supplied (skips expiry)", () => {
    const registry = new AgentRegistry();
    registry.register(reg({ expiresAt: NOW }));
    expect(registry.status("agent-1")).toEqual({ active: true, reason: "active" });
  });

  it("is active when expiresAt is after now", () => {
    const registry = new AgentRegistry();
    registry.register(reg({ expiresAt: LATER }));
    expect(registry.status("agent-1", { now: NOW })).toEqual({
      active: true,
      reason: "active",
    });
  });

  it("reports 'invocation limit reached' once the count meets the limit", () => {
    const registry = new AgentRegistry();
    registry.register(reg({ invocationLimit: 2 }));
    registry.recordInvocation("agent-1");
    expect(registry.status("agent-1").active).toBe(true);
    registry.recordInvocation("agent-1");
    expect(registry.status("agent-1")).toEqual({
      active: false,
      reason: "invocation limit reached",
    });
  });

  it("treats invocationLimit 0 as unlimited", () => {
    const registry = new AgentRegistry();
    registry.register(reg({ invocationLimit: 0 }));
    registry.recordInvocation("agent-1");
    registry.recordInvocation("agent-1");
    expect(registry.status("agent-1")).toEqual({ active: true, reason: "active" });
  });

  it("reports 'operation out of scope' when the operation is excluded", () => {
    const registry = new AgentRegistry();
    const scope: GateOperation[] = ["tool-call"];
    registry.register(reg({ scope }));
    expect(
      registry.status("agent-1", { operation: "memory-write" }),
    ).toEqual({ active: false, reason: "operation out of scope" });
  });

  it("is active when the operation is within scope", () => {
    const registry = new AgentRegistry();
    registry.register(reg({ scope: ["tool-call", "memory-write"] }));
    expect(
      registry.status("agent-1", { operation: "memory-write" }),
    ).toEqual({ active: true, reason: "active" });
  });

  it("ignores scope when no operation is supplied", () => {
    const registry = new AgentRegistry();
    registry.register(reg({ scope: ["tool-call"] }));
    expect(registry.status("agent-1")).toEqual({ active: true, reason: "active" });
  });

  it("records invocations independently per agent", () => {
    const registry = new AgentRegistry();
    registry.register(reg({ agentId: "a", invocationLimit: 1 }));
    registry.register(reg({ agentId: "b", invocationLimit: 1 }));
    registry.recordInvocation("a");
    expect(registry.status("a").active).toBe(false);
    expect(registry.status("b").active).toBe(true);
  });

  it("ignores recordInvocation for an unregistered agent", () => {
    const registry = new AgentRegistry();
    registry.recordInvocation("ghost");
    expect(registry.status("ghost")).toEqual({
      active: false,
      reason: "not registered",
    });
  });

  it("ignores revoke for an unregistered agent", () => {
    const registry = new AgentRegistry();
    registry.revoke("ghost", "kill");
    expect(registry.status("ghost")).toEqual({
      active: false,
      reason: "not registered",
    });
  });
});

describe("AgentRegistry.register (upsert)", () => {
  it("clears a prior revocation on re-registration", () => {
    const registry = new AgentRegistry();
    registry.register(reg());
    registry.revoke("agent-1", "oops");
    expect(registry.status("agent-1").active).toBe(false);
    registry.register(reg());
    expect(registry.status("agent-1")).toEqual({ active: true, reason: "active" });
  });

  it("resets the invocation count on re-registration", () => {
    const registry = new AgentRegistry();
    registry.register(reg({ invocationLimit: 2 }));
    registry.recordInvocation("agent-1");
    registry.recordInvocation("agent-1");
    expect(registry.status("agent-1").active).toBe(false);
    registry.register(reg({ invocationLimit: 2 }));
    expect(registry.status("agent-1")).toEqual({ active: true, reason: "active" });
  });
});

describe("AgentRegistry.mayInstantiate", () => {
  it("is true for a registered, active agent with selfInstantiation", () => {
    const registry = new AgentRegistry();
    registry.register(reg({ selfInstantiation: true }));
    expect(registry.mayInstantiate("agent-1")).toBe(true);
  });

  it("is false when selfInstantiation is disabled", () => {
    const registry = new AgentRegistry();
    registry.register(reg({ selfInstantiation: false }));
    expect(registry.mayInstantiate("agent-1")).toBe(false);
  });

  it("is false for an unregistered agent", () => {
    const registry = new AgentRegistry();
    expect(registry.mayInstantiate("ghost")).toBe(false);
  });

  it("is false once the agent is revoked", () => {
    const registry = new AgentRegistry();
    registry.register(reg({ selfInstantiation: true }));
    registry.revoke("agent-1");
    expect(registry.mayInstantiate("agent-1")).toBe(false);
  });
});

describe("AgentRegistry.asValidator", () => {
  it("is named 'kill-switch'", () => {
    const registry = new AgentRegistry();
    expect(registry.asValidator().name).toBe("kill-switch");
  });

  it("maps an active agent to allow", () => {
    const registry = new AgentRegistry();
    registry.register(reg());
    const verdict = registry.asValidator({ now: () => NOW }).check(ctx());
    expect(verdict).toEqual({
      action: "allow",
      reason: "active",
      validator: "kill-switch",
    });
  });

  it("maps a revoked agent to terminate", () => {
    const registry = new AgentRegistry();
    registry.register(reg());
    registry.revoke("agent-1", "compromised");
    const verdict = registry.asValidator({ now: () => NOW }).check(ctx());
    expect(verdict).toEqual({
      action: "terminate",
      reason: "revoked: compromised",
      validator: "kill-switch",
    });
  });

  it("maps an expired agent to block", () => {
    const registry = new AgentRegistry();
    registry.register(reg({ expiresAt: NOW }));
    const verdict = registry.asValidator({ now: () => LATER }).check(ctx());
    expect(verdict).toEqual({
      action: "block",
      reason: "expired",
      validator: "kill-switch",
    });
  });

  it("maps an out-of-scope operation to block", () => {
    const registry = new AgentRegistry();
    registry.register(reg({ scope: ["memory-write"] }));
    const verdict = registry
      .asValidator({ now: () => NOW })
      .check(ctx({ operation: "tool-call" }));
    expect(verdict).toEqual({
      action: "block",
      reason: "operation out of scope",
      validator: "kill-switch",
    });
  });

  it("maps an unregistered agent to block", () => {
    const registry = new AgentRegistry();
    const verdict = registry
      .asValidator({ now: () => NOW })
      .check(ctx({ agentId: "ghost" }));
    expect(verdict).toEqual({
      action: "block",
      reason: "not registered",
      validator: "kill-switch",
    });
  });

  it("defaults now to the current ISO time when no opts are given", () => {
    const registry = new AgentRegistry();
    // expiresAt far in the past -> the default now() must mark it expired.
    registry.register(reg({ expiresAt: "2000-01-01T00:00:00.000Z" }));
    const verdict = registry.asValidator().check(ctx());
    expect(verdict).toEqual({
      action: "block",
      reason: "expired",
      validator: "kill-switch",
    });
  });
});
