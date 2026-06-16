# ADR-006: `Result<T, E>` for domain error handling

- Status: Accepted
- Date: 2026-06

## Context
Domain logic must distinguish *expected* failures (validation, policy) from
*unexpected* exceptions, without leaking stack traces or coupling the domain to
framework error types.

## Decision
The domain layer (`src/domain/result.ts`) uses an explicit `Result<T, E>` type
(`ok`/`err`) for operations whose failure is part of the contract. Throwing is
reserved for truly exceptional, unrecoverable states. Infrastructure adapters may
still throw; the actor's retry/DLQ machinery treats thrown errors as transient.

## Consequences
- **+** Failures are visible in signatures; callers must handle them.
- **+** Pure, framework-agnostic domain; easy to unit-test (100% covered).
- **−** More verbose than throw/catch at call sites.
- See `ADR-009` (DDD layering) for where this boundary sits.
