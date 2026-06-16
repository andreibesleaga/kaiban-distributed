# ADR-009: Domain-Driven Design layering

- Status: Accepted
- Date: 2026-06

## Context
A distributed actor system mixes pure policy (task state machine, security rules)
with heavy I/O (Redis, Kafka, KaibanJS, OpenTelemetry, HTTP). Without enforced
boundaries, framework concerns leak into business logic and tests require real
infrastructure.

## Decision
Code is layered: `domain/` (pure types, `Result`, entities, security *interfaces*) →
`application/` (the `AgentActor` use case) → `adapters/` (gateway, state) and
`infrastructure/` (messaging drivers, security implementations, telemetry,
KaibanJS bridges) → `shared/` (cross-cutting glue) → `main/` (composition root).
The domain imports no framework. Boundaries are enforced by file layout and a
circular-import check (`madge --circular --extensions ts src/`).

## Consequences
- **+** Domain is unit-testable with mocks (100% coverage); messaging is pluggable (ADR-001).
- **+** New transports/security impls slot in behind interfaces.
- **−** More indirection than a flat structure; the composition root (`main/index.ts`)
  carries the wiring.
