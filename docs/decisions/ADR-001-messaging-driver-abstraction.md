# ADR-001: Messaging Abstraction Layer — IMessagingDriver Interface

**Date:** 2026-03-10
**Status:** Accepted
**Deciders:** Engineering Team

---

## Context

KaibanJS uses an in-process Zustand store for agent state. Distributing agents across multiple Node.js processes requires a messaging layer to route tasks between nodes. Multiple messaging backends exist (BullMQ/Redis, Kafka, AMQP) with different trade-offs.

## Decision

Introduce `IMessagingDriver` — a generic publish/subscribe interface that abstracts all messaging backends behind four methods:

```typescript
interface IMessagingDriver {
  publish(queueName: string, payload: MessagePayload): Promise<void>;
  subscribe(queueName: string, handler: (payload: MessagePayload) => Promise<void>): Promise<void>;
  unsubscribe(queueName: string): Promise<void>;
  disconnect(): Promise<void>;
}
```

The active driver is selected at runtime via the `MESSAGING_DRIVER` environment variable (`bullmq` | `kafka`). All agent and state code depends only on the interface, never the concrete driver.

## Considered Alternatives

| Option | Pros | Cons |
|--------|------|------|
| Direct BullMQ usage | Simpler, less abstraction | Couples all code to BullMQ; no Kafka path |
| AMQP (RabbitMQ) | Mature, durable queues | Adds ops complexity; not in current ecosystem |
| **IMessagingDriver abstraction** ✓ | Swap drivers without changing agent code; testable with mocks | One extra indirection |

## Consequences

**Positive:**
- BullMQ and Kafka are both fully supported with identical agent code
- All 113 unit tests use mock implementations — no real infrastructure needed for unit testing
- Driver can be changed per-environment via env var with no code changes

**Negative:**
- `IMessagingDriver` is more generic than domain-specific (e.g., SPEC.md originally specified `publishTask`/`subscribeToTasks`). SPEC.md updated to reflect the generalized interface.

**Note:** SPEC.md interface names (`publishTask`, `subscribeToTasks`, `publishStateDelta`, `subscribeToState`) were superseded by this generalized pattern. SPEC.md updated accordingly (see ADR-001 rationale).
