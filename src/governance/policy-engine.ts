/**
 * Policy-as-code engine (master plan §B5.1 Phase G, ADR-020).
 *
 * A {@link GateValidator} that evaluates a gate context against an ordered
 * {@link PolicySet}. The FIRST matching rule wins; if none match, the set's
 * `default` action applies. Policy sets are hot-reloadable via {@link PolicyEngine.load}
 * and can be parsed + validated from YAML via {@link loadPolicySet}.
 *
 * A rule matches when ALL of its *provided* fields match:
 *  - `operation` — strict equality (any when omitted),
 *  - `agentId`   — strict equality (any when omitted),
 *  - `matchAny`  — at least one (lower-cased) term is a substring of the
 *                  lower-cased JSON serialization of `ctx.payload` (any when omitted).
 */

import { parse } from "yaml";
import type {
  GateAction,
  GateContext,
  GateValidator,
  GateVerdict,
  PolicyRule,
  PolicySet,
} from "./types";

const VALIDATOR_NAME = "policy" as const;

/** All valid {@link GateAction} values, used to validate parsed YAML. */
const GATE_ACTIONS: readonly GateAction[] = [
  "allow",
  "degrade",
  "escalate",
  "block",
  "terminate",
];

function isGateAction(value: unknown): value is GateAction {
  return (
    typeof value === "string" && (GATE_ACTIONS as readonly string[]).includes(value)
  );
}

/** Policy validator: evaluates a context against an ordered, hot-reloadable rule set. */
export class PolicyEngine implements GateValidator {
  public readonly name = VALIDATOR_NAME;

  private policies: PolicySet;

  public constructor(policies: PolicySet) {
    this.policies = policies;
  }

  /** Hot-reload the active policy set (replaces the previous one). */
  public load(policies: PolicySet): void {
    this.policies = policies;
  }

  /** Evaluate `ctx`; return the first matching rule's verdict, else the default. */
  public check(ctx: GateContext): GateVerdict {
    const haystack = JSON.stringify(ctx.payload).toLowerCase();
    for (const rule of this.policies.rules) {
      if (this.ruleMatches(rule, ctx, haystack)) {
        return {
          action: rule.effect,
          reason: rule.reason ?? rule.id,
          validator: VALIDATOR_NAME,
        };
      }
    }
    return {
      action: this.policies.default,
      reason: "no policy matched",
      validator: VALIDATOR_NAME,
    };
  }

  /** True when every provided field of `rule` matches `ctx`. */
  private ruleMatches(rule: PolicyRule, ctx: GateContext, haystack: string): boolean {
    return (
      this.operationMatches(rule, ctx) &&
      this.agentMatches(rule, ctx) &&
      this.payloadMatches(rule, haystack)
    );
  }

  private operationMatches(rule: PolicyRule, ctx: GateContext): boolean {
    return rule.operation === undefined || rule.operation === ctx.operation;
  }

  private agentMatches(rule: PolicyRule, ctx: GateContext): boolean {
    return rule.agentId === undefined || rule.agentId === ctx.agentId;
  }

  private payloadMatches(rule: PolicyRule, haystack: string): boolean {
    if (rule.matchAny === undefined) {
      return true;
    }
    return rule.matchAny.some((term) => haystack.includes(term.toLowerCase()));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRule(raw: unknown, index: number): PolicyRule {
  if (!isRecord(raw)) {
    throw new Error(`Invalid policy: rule at index ${index} must be an object`);
  }
  if (typeof raw["id"] !== "string") {
    throw new Error(`Invalid policy: rule at index ${index} must have a string "id"`);
  }
  if (!isGateAction(raw["effect"])) {
    throw new Error(
      `Invalid policy: rule "${raw["id"]}" has an invalid "effect" (must be a GateAction)`,
    );
  }
  return raw as unknown as PolicyRule;
}

/**
 * Parse + minimally validate YAML into a {@link PolicySet}.
 * @throws {Error} when the shape is invalid (not an object, bad `default`,
 *   `rules` not an array, or any rule missing `id` / having a bad `effect`).
 */
export function loadPolicySet(yamlText: string): PolicySet {
  const parsed: unknown = parse(yamlText);
  if (!isRecord(parsed)) {
    throw new Error("Invalid policy: root must be an object");
  }
  if (!isGateAction(parsed["default"])) {
    throw new Error('Invalid policy: "default" must be a valid GateAction');
  }
  const rules = parsed["rules"];
  if (!Array.isArray(rules)) {
    throw new Error('Invalid policy: "rules" must be an array');
  }
  return {
    default: parsed["default"],
    rules: rules.map((rule, index) => validateRule(rule, index)),
  };
}
