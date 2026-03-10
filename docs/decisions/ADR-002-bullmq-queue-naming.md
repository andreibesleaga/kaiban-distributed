# ADR-002: BullMQ Queue Naming — Dashes Instead of Colons

**Date:** 2026-03-10
**Status:** Accepted
**Deciders:** Engineering Team

---

## Context

During E2E testing, BullMQ v5 threw `Error: Queue name cannot contain ':'` when queue names used the Redis key-namespace convention (`kaiban:agents:researcher`). This blocked all integration tests.

## Decision

All queue and channel names use **dashes** instead of colons:

| Before | After |
|--------|-------|
| `kaiban:agents:researcher` | `kaiban-agents-researcher` |
| `kaiban:events:completed` | `kaiban-events-completed` |
| `kaiban:events:failed` | `kaiban-events-failed` |
| `kaiban:state:events` | `kaiban-state-events` |

Exception: SocketGateway uses ioredis pub/sub directly, which **does** support colons. The `STATE_CHANNEL` constant (`kaiban-state-events`) deliberately avoids colons for consistency even though ioredis would allow them.

## Considered Alternatives

| Option | Result |
|--------|--------|
| Use colons (Redis convention) | BullMQ v5 rejects — hard failure |
| Use underscores | Works but inconsistent with distributed system naming conventions |
| **Use dashes** ✓ | Works in BullMQ, ioredis, and Kafka; readable; consistent |

## Consequences

- All queue names defined as constants in `examples/blog-team/team-config.ts` and `src/application/actor/AgentActor.ts`
- CONTINUITY.md updated with this failure pattern to prevent future regressions
- SocketGateway state channel (`kaiban-state-events`) uses same convention even though ioredis permits colons
