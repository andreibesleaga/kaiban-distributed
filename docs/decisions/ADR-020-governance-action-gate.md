# ADR-020 — Governance: the Action Gate + audit chain + policy-as-code + registry + memory hardening

- **Status:** Accepted
- **Date:** 2026-06-19
- **Refs:** `KAIBAN-v2.0-MASTER-PLAN.md` §B5.1 Phase G + §B1 invariants (#8 default-off); §B8 BETA.3

## Context
v2.0 needs **external, non-bypassable enforcement**: a single point every sensitive operation
(tool-call / outbound message / memory write) must pass through, composing the existing security
controls (semantic firewall, circuit breaker, token/cost budget) with new ones (policy-as-code,
provenance, kill-switch) and writing a **tamper-evident** record of every decision. It must be
**opt-in / default-OFF** (invariant #8): unconfigured ⇒ zero overhead and zero behavior change.

## Decision
A new **`src/governance/`** layer (contract `src/governance/types.ts`) plus a hardened memory store
(`src/memory/`), built by **five parallel subagents** against the shared contract, all **default-OFF**:

- **`action-gate.ts` — `ActionGate`.** The enforcement point. `evaluate(ctx)` runs an injected,
  ordered list of `GateValidator`s, aggregates their verdicts to the **MOST SEVERE** action
  (`allow < degrade < escalate < block < terminate`), records the decision to an injected `AuditSink`,
  and returns it. **Opt-in / no-op when disabled** (`GovernanceConfig.enabled = false` ⇒ `allow`, no
  validator consulted, nothing recorded); **when enabled, non-bypassable** (no per-request opt-out, all
  validators run so the audit is complete). Ships thin adapter factories that turn the EXISTING
  components into validators — `firewallValidator(ISemanticFirewall)`, `breakerValidator(ICircuitBreaker)`,
  `costValidator(CostReservation-like)` (maps Phase-E `admit` allow/degrade/reject → allow/degrade/block).
  **Phase G consumes Phase E** (cost-reservation is owned by Economics, validated here).
- **`audit-log.ts` — `AuditLog implements AuditSink`.** Append-only, **hash-chained (SHA-256)**:
  each record's hash covers `prevHash + {index,timestamp,decision}`. `verify()` recomputes the chain and
  returns the first `brokenAt` index on any tamper — tamper-evident without external storage.
- **`policy-engine.ts` — `PolicyEngine implements GateValidator` + `loadPolicySet(yaml)`.**
  Policy-as-code: an ordered `PolicySet` (first-match-wins; match on operation / agentId / payload
  substrings) yields a `GateAction`; **hot-reloadable** via `load()`. `loadPolicySet` parses+validates
  YAML (`yaml` dep). Example `policies.yml` ships as reference.
- **`registry.ts` — `AgentRegistry`.** Agent registry + **kill-switch** with **PDLSS** lifecycle
  (Purpose / Duration `expiresAt` / Limit `invocationLimit` / Scope `scope[]` / Self-instantiation).
  `revoke()` is the instant kill-switch; `asValidator()` blocks/terminates revoked / expired /
  out-of-scope / unregistered agents at the gate.
- **`src/memory/secure-memory-store.ts` — `SecureMemoryStore`.** Memory hardening: **tenant keyspaces**
  (no cross-tenant reads), **provenance + trust tags**, **retrieval-time RBAC** (role × classification
  matrix; missing role ⇒ viewer), **TTL eviction**, **minTrust** filtering, and
  **`revoke()` (revoke-poisoned-entry)**. Deterministic (`now` injected, no `Date.now()`).

- **New direct dependency: `yaml ^2.9.0`** (0 vulns; for `loadPolicySet`).
- **Config:** `governance` block on `AppConfig` (`GOVERNANCE_ENABLED` default false,
  `GOVERNANCE_POLICIES_PATH` optional).
- **Library API (additive):** the governance + memory modules and the `governance/types` contract are
  exported from the main entry point.

## Invariants preserved
- **Default-OFF (invariant #8):** disabled gate = no-op `allow`, no validators, no audit. The memory
  store is a new opt-in component (nothing pre-existing changes).
- **Composition, not reinvention:** the gate *adapts* the existing firewall/breaker/cost controls
  rather than duplicating them.
- **Cost-reservation ownership:** Economics (Phase E) owns it; Governance consumes it as a validator.

## Deferred (roadmap)
- Wiring `ActionGate.evaluate()` into the deployed `AgentActor` hot path / MCP+A2A egress (the engine +
  validators are shipped and unit-tested; the hot-path interception is a separate reviewed step, like
  Phase E's `admit()`).
- Persisting the audit chain to durable storage (today in-memory + verifiable); signing the chain head.
- A richer policy DSL (conditions/quantifiers) beyond first-match substring rules.

## Consequences
- A composable, default-off enforcement spine with a tamper-evident trail, hot-loadable policy, a
  kill-switch, and a hardened memory store — all 100%-covered with no broker. One new dep (`yaml`).
