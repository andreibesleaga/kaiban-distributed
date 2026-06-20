# ADR-021 — Hot-path enforcement: wiring the Action Gate into the AgentActor

- **Status:** Accepted
- **Date:** 2026-06-19
- **Refs:** `KAIBAN-v2.0-MASTER-PLAN.md` §B5.1 Phase G + §B1.2 invariant #8; ADR-019/ADR-020

## Context
Phase E (economics) and Phase G (governance) shipped `CostReservation.admit()` and
`ActionGate.evaluate()` as fully-tested **capabilities**, but they were not consulted by the deployed
worker — the #1 honest gap in [`docs/COMPLIANCE.md`](../COMPLIANCE.md). The `AgentActor` already had a
clean pre-execution guard pipeline (circuit breaker → semantic firewall → DLQ); enforcement just needed
to plug into it without disturbing the actor's contract (retries, idempotency, AbortSignal, timing).

## Decision
- **New domain port** `src/domain/security/admission-gate.ts` — `IAdmissionGate.evaluate(payload) →
  { allowed, reason? }` (reuses the firewall's `EvaluationPayload`). Domain layer, no framework imports,
  mirroring `ISemanticFirewall` / `ICircuitBreaker`.
- **`AgentActor` consults it** as a third pre-execution guard (after breaker + firewall): a blocked
  verdict routes the task to the DLQ as `blocked_by_admission_gate` (with the reason) **without running
  the handler** — so no tokens are burned. The guard pipeline was refactored into per-guard helpers
  (`blockByBreaker` / `evaluateFirewall` / `evaluateAdmissionGate`) to keep each ≤10 complexity; an
  **absent** guard adds **no `await`**, so a guard-less actor keeps its exact original timing
  (behavior-preserving for every existing deployment).
- **Adapters** `src/shared/admission-gate.ts`:
  - `buildAdmissionGate(actionGate, opts)` maps a `GateDecision` onto the port — **allow/degrade ⇒
    proceed; escalate/block/terminate ⇒ block**. `opts` derives the gate operation, tenant id, and
    estimated cost from the payload.
  - `buildWorkerAdmissionGate(governance, deps)` assembles the default worker gate from config:
    **policy-as-code** (`PolicyEngine` from `policiesPath`, else default-allow) **always**, plus a
    **cost-reservation** validator **only when economics is enabled AND a `CostLimiterPort` is
    injected**. Returns `undefined` when governance is disabled (actor runs un-gated).
- **Wired in `buildSecurityDeps`** (the worker/example bootstrap) from env (`GOVERNANCE_ENABLED` /
  `GOVERNANCE_POLICIES_PATH`), **default-OFF**.

## Key decisions
- **No double-enforcement:** the admission gate does NOT re-run the firewall/breaker validators — the
  actor already runs those directly; the gate adds policy (+ optional cost) on top.
- **No auto-registry:** the `AgentRegistry` kill-switch is NOT auto-wired — an empty registry's
  `asValidator` returns "not registered" → block, which would block every agent. It is a
  consumer-managed validator (compose it explicitly with `buildAdmissionGate`).
- **Cost enforcement needs a fleet limiter:** the default worker wiring enforces **policy** only;
  cost-reservation enforcement requires a `CostLimiterPort` (e.g. a Redis `RateCostLimiter`) injected by
  the deployment — kept optional to avoid forcing a Redis client into every node and to keep budgets
  fleet-wide (not per-node) when used.

## Invariants preserved
- **Default-OFF (invariant #8):** no `GOVERNANCE_ENABLED` ⇒ no admission gate ⇒ the actor behaves
  exactly as before (verified by the unchanged abort/timing tests).
- **`taskId` idempotency / DLQ taxonomy:** a gate block is a terminal, non-retryable DLQ outcome
  (`blocked_by_admission_gate`), consistent with the firewall/breaker block taxonomy.

## Consequences
- When enabled, governance policy (and optionally economics cost reservation) is **actively enforced
  in the deployed worker hot path** — closing the COMPLIANCE gap. 100%-covered, no broker. Library
  consumers can wrap any `ActionGate` (incl. cost + registry validators) via `buildAdmissionGate` and
  inject it as `AgentActorDeps.admissionGate`.
- **Still deferred:** federation-egress enforcement (A2A/MCP outbound) and a durable/signed audit chain.
