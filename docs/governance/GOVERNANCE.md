# Governance & enforcement — Phase G

> Authoritative spec: `KAIBAN-v2.0-MASTER-PLAN.md` §B5.1 Phase G · decision: `docs/decisions/ADR-020`.

An external, **non-bypassable** enforcement spine — **default-OFF**. With `GOVERNANCE_ENABLED` unset the
Action Gate is a no-op (`allow`, no validators consulted, nothing audited). When enabled it is
non-bypassable: every gated operation runs through all validators.

```bash
GOVERNANCE_ENABLED=false                       # master switch (default false)
GOVERNANCE_POLICIES_PATH=/etc/kaiban/policies.yml   # optional policy-as-code file
```

## The Action Gate
Every sensitive operation (`tool-call` / `outbound-message` / `memory-write`) passes through
`ActionGate.evaluate(ctx)`, which runs an ordered list of `GateValidator`s and returns the **most
severe** verdict: `allow < degrade < escalate < block < terminate`. Each decision is appended to a
tamper-evident `AuditSink`.

```ts
import {
  ActionGate, AuditLog, PolicyEngine, AgentRegistry,
  firewallValidator, breakerValidator, costValidator,
} from "kaiban-distributed";

const audit = new AuditLog();
const policy = new PolicyEngine(loadPolicySet(readFileSync(policiesPath, "utf8")));
const registry = new AgentRegistry();

const gate = new ActionGate({
  config: appConfig.governance,           // { enabled, policiesPath? }
  audit,
  validators: [
    registry.asValidator(),               // kill-switch / PDLSS
    policy,                               // policy-as-code
    firewallValidator(semanticFirewall),  // existing semantic firewall
    breakerValidator(circuitBreaker),     // existing circuit breaker
    costValidator(costReservation),       // Phase-E cost reservation
  ],
});

const decision = await gate.evaluate({
  operation: "tool-call", agentId, payload: toolArgs, estimatedCostUnits: 1200,
});
if (decision.action === "block" || decision.action === "terminate") return;  // enforced
```

The gate **adapts** the existing security controls (firewall, breaker, cost reservation) rather than
reinventing them; cost-reservation is owned by Economics (Phase E) and validated here.

## Hash-chained audit (`AuditLog`)
Append-only, SHA-256 chained: each record's hash covers `prevHash + {index,timestamp,decision}`.
`verify()` recomputes the chain and returns `{ valid, brokenAt? }` — any tampering with a past decision
breaks the chain at that index.

```ts
const v = audit.verify();        // { valid: true } | { valid: false, brokenAt: 3 }
```

## Policy-as-code (`PolicyEngine` / `policies.yml`)
An ordered, first-match-wins rule set (match on `operation`, `agentId`, and case-insensitive payload
substrings), hot-reloadable via `load()`. See `src/governance/policies.yml` for an example.

```yaml
default: allow
rules:
  - id: block-secret-writes
    operation: memory-write
    matchAny: ["password", "secret", "api_key"]
    effect: block
  - id: escalate-destructive-tools
    operation: tool-call
    matchAny: ["rm -rf", "drop table"]
    effect: escalate
```

## Agent registry + kill-switch (PDLSS)
`AgentRegistry` tracks each agent's **P**urpose / **D**uration (`expiresAt`) / **L**imit
(`invocationLimit`) / **S**cope (`scope[]`) / **S**elf-instantiation. `revoke()` is the instant
kill-switch; `asValidator()` blocks/terminates revoked, expired, out-of-scope, or unregistered agents.

## Memory hardening (`SecureMemoryStore`)
A tenant-keyspaced store (no cross-tenant reads) where every entry carries **provenance + trust**, is
**classified** (`public`/`internal`/`confidential`), enforces **retrieval-time RBAC** (role ×
classification; missing role ⇒ viewer), supports **TTL eviction** + **minTrust** filtering, and
`revoke()` to drop a poisoned entry.

```ts
import { SecureMemoryStore } from "kaiban-distributed";
const mem = new SecureMemoryStore();
mem.put("tenant-a", "k", value, { provenance: { source: "tool:web", trust: "low" }, classification: "internal", ttlMs: 60000, now });
mem.get("tenant-a", "k", { now, role: "operator", minTrust: "low" });  // RBAC + TTL + trust enforced
```

## Hot-path enforcement (ADR-021)

When `GOVERNANCE_ENABLED` is set, the gate is **enforced in the deployed `AgentActor` execution loop**,
not just callable. The actor consults an optional
[`IAdmissionGate`](../../src/domain/security/admission-gate.ts) as a third pre-execution guard (after
the circuit breaker + semantic firewall); a blocked verdict routes the task to the DLQ
(`blocked_by_admission_gate`) **without running the handler** (no tokens burned).
`buildSecurityDeps`/`buildWorkerAdmissionGate` wire **policy-as-code** into every worker by default;
**cost-reservation** enforcement is added when economics is enabled **and** a fleet `CostLimiterPort`
(e.g. a Redis `RateCostLimiter`) is injected. Wrap any `ActionGate` (with cost + registry validators)
via `buildAdmissionGate` and inject it as `AgentActorDeps.admissionGate` for full enforcement.

```ts
import { buildAdmissionGate } from "kaiban-distributed";
const admissionGate = buildAdmissionGate(actionGate, {
  estimatedCostUnitsOf: (p) => Number(p.data["estimatedCostUnits"] ?? 0),
});
new AgentActor(agentId, driver, queue, handler, { firewall, circuitBreaker, admissionGate });
```

## Guarantees / invariants
- **Default-OFF** (invariant #8): disabled gate = no-op `allow`; the memory store is a new opt-in component.
- **Non-bypassable when enabled** (no per-request opt-out); all validators run so the audit is complete.
- Unit-tested to 100% with **no broker**.

## Deferred (roadmap)
Wiring `evaluate()` into the deployed `AgentActor` hot path / federation egress; durable + signed audit
chain; richer policy DSL. See ADR-020.
