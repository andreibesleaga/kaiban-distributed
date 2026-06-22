import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { PolicyEngine, loadPolicySet } from "../../../src/governance/policy-engine";
import type {
  GateContext,
  PolicySet,
} from "../../../src/governance/types";

function ctx(over: Partial<GateContext> = {}): GateContext {
  return {
    operation: "tool-call",
    agentId: "agent-1",
    payload: { foo: "bar" },
    ...over,
  };
}

describe("PolicyEngine", () => {
  it("exposes the validator name 'policy'", () => {
    const engine = new PolicyEngine({ default: "allow", rules: [] });
    expect(engine.name).toBe("policy");
  });

  it("returns the default action with a reason when no rule matches", () => {
    const engine = new PolicyEngine({ default: "block", rules: [] });
    const verdict = engine.check(ctx());
    expect(verdict).toEqual({
      action: "block",
      reason: "no policy matched",
      validator: "policy",
    });
  });

  it("matches a rule by operation alone", () => {
    const set: PolicySet = {
      default: "allow",
      rules: [{ id: "r-op", operation: "memory-write", effect: "block" }],
    };
    const engine = new PolicyEngine(set);
    expect(engine.check(ctx({ operation: "memory-write" }))).toEqual({
      action: "block",
      reason: "r-op",
      validator: "policy",
    });
    // Different operation does NOT match -> default.
    expect(engine.check(ctx({ operation: "tool-call" })).action).toBe("allow");
  });

  it("matches a rule by agentId alone", () => {
    const set: PolicySet = {
      default: "allow",
      rules: [{ id: "r-agent", agentId: "rogue", effect: "terminate" }],
    };
    const engine = new PolicyEngine(set);
    expect(engine.check(ctx({ agentId: "rogue" })).action).toBe("terminate");
    expect(engine.check(ctx({ agentId: "nice" })).action).toBe("allow");
  });

  it("matches by matchAny as a case-insensitive substring of the JSON payload", () => {
    const set: PolicySet = {
      default: "allow",
      rules: [{ id: "r-secret", matchAny: ["PASSWORD", "secret"], effect: "block" }],
    };
    const engine = new PolicyEngine(set);
    // Upper-cased rule term matches lower-cased payload (case-insensitive).
    expect(
      engine.check(ctx({ payload: { note: "my Password is x" } })).action,
    ).toBe("block");
    // Second term matches.
    expect(
      engine.check(ctx({ payload: { k: "a SECRET value" } })).action,
    ).toBe("block");
    // No term present -> default.
    expect(engine.check(ctx({ payload: { k: "harmless" } })).action).toBe("allow");
  });

  it("requires ALL provided fields to match (combined operation + agentId)", () => {
    const set: PolicySet = {
      default: "allow",
      rules: [
        {
          id: "r-combo",
          operation: "tool-call",
          agentId: "agent-1",
          effect: "escalate",
        },
      ],
    };
    const engine = new PolicyEngine(set);
    // Both match.
    expect(
      engine.check(ctx({ operation: "tool-call", agentId: "agent-1" })).action,
    ).toBe("escalate");
    // agentId mismatches -> not matched.
    expect(
      engine.check(ctx({ operation: "tool-call", agentId: "other" })).action,
    ).toBe("allow");
    // operation mismatches -> not matched.
    expect(
      engine.check(ctx({ operation: "memory-write", agentId: "agent-1" })).action,
    ).toBe("allow");
  });

  it("requires ALL provided fields to match (combined matchAny + operation)", () => {
    const set: PolicySet = {
      default: "allow",
      rules: [
        {
          id: "r-combo2",
          operation: "memory-write",
          matchAny: ["token"],
          effect: "block",
        },
      ],
    };
    const engine = new PolicyEngine(set);
    expect(
      engine.check(
        ctx({ operation: "memory-write", payload: { x: "a token here" } }),
      ).action,
    ).toBe("block");
    // matchAny present but operation wrong -> not matched.
    expect(
      engine.check(
        ctx({ operation: "tool-call", payload: { x: "a token here" } }),
      ).action,
    ).toBe("allow");
    // operation right but matchAny absent -> not matched.
    expect(
      engine.check(
        ctx({ operation: "memory-write", payload: { x: "clean" } }),
      ).action,
    ).toBe("allow");
  });

  it("returns the FIRST matching rule (first-match-wins ordering)", () => {
    const set: PolicySet = {
      default: "allow",
      rules: [
        { id: "first", operation: "tool-call", effect: "escalate" },
        { id: "second", operation: "tool-call", effect: "block" },
      ],
    };
    const engine = new PolicyEngine(set);
    expect(engine.check(ctx({ operation: "tool-call" }))).toEqual({
      action: "escalate",
      reason: "first",
      validator: "policy",
    });
  });

  it("uses rule.reason when present, else falls back to rule.id", () => {
    const set: PolicySet = {
      default: "allow",
      rules: [
        { id: "with-reason", operation: "tool-call", effect: "block", reason: "explained" },
      ],
    };
    const engine = new PolicyEngine(set);
    expect(engine.check(ctx({ operation: "tool-call" })).reason).toBe("explained");
  });

  it("hot-reloads via load() and changes behavior", () => {
    const engine = new PolicyEngine({ default: "allow", rules: [] });
    expect(engine.check(ctx()).action).toBe("allow");
    engine.load({
      default: "block",
      rules: [{ id: "r", operation: "tool-call", effect: "terminate" }],
    });
    expect(engine.check(ctx({ operation: "tool-call" })).action).toBe("terminate");
    expect(engine.check(ctx({ operation: "memory-write" })).action).toBe("block");
  });
});

describe("loadPolicySet", () => {
  it("parses a valid YAML string into a PolicySet", () => {
    const yaml = [
      "default: allow",
      "rules:",
      "  - id: block-secrets",
      "    operation: memory-write",
      "    matchAny: [password, secret]",
      "    effect: block",
      "    reason: no secrets in memory",
      "  - id: kill-rogue",
      "    agentId: rogue-agent",
      "    effect: terminate",
    ].join("\n");
    const set = loadPolicySet(yaml);
    expect(set.default).toBe("allow");
    expect(set.rules).toHaveLength(2);
    expect(set.rules[0]).toEqual({
      id: "block-secrets",
      operation: "memory-write",
      matchAny: ["password", "secret"],
      effect: "block",
      reason: "no secrets in memory",
    });
    expect(set.rules[1]?.effect).toBe("terminate");
  });

  it("parses an empty rules array", () => {
    const set = loadPolicySet("default: allow\nrules: []\n");
    expect(set).toEqual({ default: "allow", rules: [] });
  });

  it("throws when the parsed root is not an object", () => {
    expect(() => loadPolicySet("- just\n- a\n- list")).toThrow(/object/i);
    expect(() => loadPolicySet("just a string")).toThrow(/object/i);
    expect(() => loadPolicySet("null")).toThrow(/object/i);
  });

  it("throws when 'default' is missing or not a valid GateAction", () => {
    expect(() => loadPolicySet("rules: []\n")).toThrow(/default/i);
    expect(() => loadPolicySet("default: 42\nrules: []\n")).toThrow(/default/i);
    expect(() => loadPolicySet("default: nonsense\nrules: []\n")).toThrow(/default/i);
  });

  it("throws when 'rules' is not an array", () => {
    expect(() => loadPolicySet("default: allow\nrules: nope\n")).toThrow(/rules/i);
    expect(() => loadPolicySet("default: allow\n")).toThrow(/rules/i);
  });

  it("throws when a rule is not an object", () => {
    expect(() => loadPolicySet("default: allow\nrules:\n  - just-a-string\n")).toThrow(
      /rule/i,
    );
  });

  it("throws when a rule is missing a string 'id'", () => {
    const yaml = "default: allow\nrules:\n  - effect: block\n";
    expect(() => loadPolicySet(yaml)).toThrow(/id/i);
  });

  it("throws when a rule has an invalid 'effect'", () => {
    const yaml = "default: allow\nrules:\n  - id: r1\n    effect: nope\n";
    expect(() => loadPolicySet(yaml)).toThrow(/effect/i);
  });

  it("accepts the shipped example policies.yml", () => {
    const text = readFileSync(
      join(__dirname, "../../../src/governance/policies.yml"),
      "utf8",
    );
    const set = loadPolicySet(text);
    expect(set.default).toBe("allow");
    expect(set.rules.length).toBeGreaterThan(0);
  });
});
