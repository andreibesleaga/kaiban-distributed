/**
 * Governance & enforcement shared contract (master plan §B5.1 Phase G, ADR-020).
 *
 * The **Action Gate** is the external, non-bypassable enforcement point: every
 * gated operation (tool-call / outbound message / memory write) passes through an
 * ordered set of `GateValidator`s, the gate aggregates their verdicts to the MOST
 * SEVERE action, and records the decision to a tamper-evident `AuditSink`.
 *
 * Posture (§B-plan + invariant #8): **opt-in / no-op when unconfigured; when
 * enabled, non-bypassable** (no per-request opt-out). Default-OFF — with
 * `GovernanceConfig.enabled = false` the gate is a passthrough (`allow`) that
 * consults no validator and records nothing.
 *
 * Pure types/contract so the Phase-G modules (`action-gate`, `audit-log`,
 * `policy-engine`, `registry`) build independently against it.
 */

/** Gate outcomes, least → most severe. The gate returns the most severe verdict. */
export type GateAction =
  | "allow"
  | "degrade"
  | "escalate"
  | "block"
  | "terminate";

/** Severity ranking used to aggregate validator verdicts (higher = more severe). */
export const GATE_ACTION_SEVERITY: Record<GateAction, number> = {
  allow: 0,
  degrade: 1,
  escalate: 2,
  block: 3,
  terminate: 4,
};

/** The kinds of operation the gate guards. */
export type GateOperation = "tool-call" | "outbound-message" | "memory-write";

/** What is being gated. */
export interface GateContext {
  operation: GateOperation;
  agentId: string;
  tenantId?: string;
  /** The thing being gated (tool args / message body / memory entry). */
  payload: Record<string, unknown>;
  /** Estimated cost units, for cost-reservation validators. */
  estimatedCostUnits?: number;
}

/** One validator's verdict. */
export interface GateVerdict {
  action: GateAction;
  reason: string;
  /** Name of the validator that produced this verdict. */
  validator: string;
}

/** A pluggable enforcement check. Sync or async. */
export interface GateValidator {
  readonly name: string;
  check(ctx: GateContext): GateVerdict | Promise<GateVerdict>;
}

/** The aggregate decision recorded for one gated operation. */
export interface GateDecision {
  action: GateAction;
  /** All verdicts; the deciding (most-severe) verdict is first. */
  verdicts: GateVerdict[];
  context: GateContext;
}

/** A hash-chained audit record (one per gate decision). */
export interface AuditRecord {
  /** Monotonic position in the chain (genesis = 0). */
  index: number;
  /** ISO timestamp (injected — deterministic in tests). */
  timestamp: string;
  decision: GateDecision;
  /** Previous record's `hash` (genesis = ""). */
  prevHash: string;
  /** SHA-256 over `prevHash` + canonical JSON of {index,timestamp,decision}. */
  hash: string;
}

/** Where the gate writes decisions. Implemented by the hash-chained `AuditLog`. */
export interface AuditSink {
  /** Append a decision; returns the newly chained record. */
  append(decision: GateDecision, timestamp: string): AuditRecord;
}

/** Result of verifying an audit chain's integrity. */
export interface AuditVerification {
  valid: boolean;
  /** Index of the first tampered/broken record, when `valid` is false. */
  brokenAt?: number;
}

/** Governance configuration (default-OFF). */
export interface GovernanceConfig {
  enabled: boolean;
  /** Optional path to a `policies.yml` loaded at startup. */
  policiesPath?: string;
}

// ── Policy-as-code (policy-engine) ───────────────────────────────────────────

/** A single policy rule. A rule matches when ALL of its provided fields match. */
export interface PolicyRule {
  id: string;
  /** Match this operation (any when omitted). */
  operation?: GateOperation;
  /** Match this agentId (any when omitted). */
  agentId?: string;
  /** Match when ANY of these (lower-cased) substrings appear in the JSON payload. */
  matchAny?: string[];
  /** Action applied when the rule matches. */
  effect: GateAction;
  reason?: string;
}

/** An ordered rule set with a default action when nothing matches. */
export interface PolicySet {
  /** Action when no rule matches (typically `allow`). */
  default: GateAction;
  rules: PolicyRule[];
}

// ── Agent registry + kill-switch (PDLSS) ─────────────────────────────────────

/**
 * An agent's PDLSS registration — Purpose / Duration / Limit / Scope /
 * Self-instantiation. The registry uses it to decide if an operation is allowed.
 */
export interface AgentRegistration {
  agentId: string;
  /** Purpose — human-readable reason the agent exists. */
  purpose: string;
  /** Duration — ISO expiry timestamp; omitted = no expiry. */
  expiresAt?: string;
  /** Limit — max invocations; 0/omitted = unlimited. */
  invocationLimit?: number;
  /** Scope — operations the agent may perform; omitted = all. */
  scope?: GateOperation[];
  /** Self-instantiation — may this agent spawn sub-agents? */
  selfInstantiation: boolean;
}

/** A registry's verdict on whether an agent is currently usable. */
export interface RegistryStatus {
  active: boolean;
  reason: string;
}
