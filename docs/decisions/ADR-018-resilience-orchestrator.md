# ADR-018 — Resilience layer + crash-safe single-active orchestrator

- **Status:** Accepted
- **Date:** 2026-06-18
- **Refs:** `KAIBAN-v2.0-MASTER-PLAN.md` §B5.1 Phase R + §B1.2/§B3 (invariants); §B8 BETA.2

## Context
v2.0 must make the **core components** (gateway, orchestrator, workflows) resilient and self-healing —
traced **and** revived — not just per-node/per-task DLQ. The example orchestrators lived only in
`examples/` and lost all in-flight progress on restart.

## Decision
- **Promote a reusable single-active orchestrator into `src/shared/orchestrator.ts`** (core, exported
  from `.` and `./shared`): drives a workflow over `CompletionRouter` with **Redis checkpoint→resume**
  (workflow progress persisted per transition under a namespaced key; on restart it resumes from the
  last checkpoint instead of restarting). **Idempotent** — dedup by `taskId`; duplicate at-least-once
  deliveries never double-advance. Both examples refactored to consume it. **Single-active per
  workflow** (no leader election); failover = checkpoint, **not** HA (HA = roadmap).
- **Health + lifecycle (`src/resilience/health.ts`, `graceful-shutdown.ts`):** `/ready` (readiness —
  Redis + broker reachable) and `/startup` probes wired into the gateway (which already serves
  `/health`); **graceful shutdown** runs ordered, best-effort, deadline-bounded steps (stop intake →
  drain → finish acks → flush → close) so a hung dependency cannot wedge shutdown.
- **DLQ replay (`src/resilience/dlq-replay.ts`):** respects the §B3 DLQ taxonomy — **skips
  non-retryable poison** (firewall-block / breaker-open); only replays the retries-exhausted class.

## Invariants preserved (kaiban-actor-invariants)
I4 (workers never set `teamWorkflowStatus` — only the orchestrator owns lifecycle), I5
(`kaiban-state-events` / `kaiban-hitl-decisions` stay on Redis Pub/Sub), `taskId` idempotency
(AP+BASE). The "no centralized bottleneck" NFR is scoped to the worker tier (orchestrator is
single-active by design).

## Consequences
- (+) Crash-safe workflows; clean readiness/startup signalling for k8s; bounded graceful drain;
  safe DLQ replay. The orchestrator is now reusable core (examples consume it, not duplicate it).
- (−) `GatewayApp` constructor gains optional `readinessProbe`/`startupProbe` deps (documented in
  MIGRATION). Orchestrator HA (leader election) remains roadmap.

## Deferred (documented, not silently skipped)
Supervision/auto-revival (backoff+jitter reconnect), bulkhead, backpressure, retry budgets, and
loop-termination guards — tracked as a Phase-R follow-up (see the master plan §B5.1).
