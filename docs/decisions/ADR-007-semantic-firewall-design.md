# ADR-007: Heuristic semantic firewall (opt-in)

- Status: Accepted
- Date: 2026-06

## Context
Agent task payloads carry untrusted, free-form instructions that may attempt
prompt-injection / goal-hijacking (OWASP LLM01 / ASI01). We need a lightweight,
dependency-free first line of defense that does not change behavior for existing
deployments.

## Decision
`ISemanticFirewall` is a domain interface; `HeuristicFirewall`
(`src/infrastructure/security/heuristic-firewall.ts`) implements it with ~10 curated
regex patterns over the `instruction`/`context` fields, returning
`{ allowed, reason }`. It is **opt-in** via `SEMANTIC_FIREWALL_ENABLED` (default off).
Blocked payloads route straight to the DLQ (`kaiban-events-failed`) without retries.
An optional LLM deep-analysis hook (`SEMANTIC_FIREWALL_LLM_URL`) can layer on top.

## Consequences
- **+** Cheap, stateless, zero new runtime deps; backward-compatible (off by default).
- **+** Domain interface lets a stronger classifier be swapped in.
- **−** Regex heuristics are best-effort, not exhaustive — defense in depth, not a guarantee.
