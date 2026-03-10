# ADR-003: KaibanJS Integration — Bridge Pattern

**Date:** 2026-03-10
**Status:** Accepted
**Deciders:** Engineering Team

---

## Context

KaibanJS agents run in-process with a monolithic Zustand store. To distribute agents across multiple Node.js processes while preserving the KaibanJS programming model and enabling kaiban-board visibility, a bridge pattern is needed.

## Decision

Two bridge classes wrap KaibanJS to make it distribution-aware:

### KaibanAgentBridge (`src/infrastructure/kaibanjs/kaiban-agent-bridge.ts`)

```typescript
createKaibanTaskHandler(agentConfig: KaibanAgentConfig, driver: IMessagingDriver)
  → (payload: MessagePayload) => Promise<unknown>
```

Maps a `MessagePayload` to a KaibanJS `Task`, calls `agent.workOnTask(task, inputs, context)`, and returns the LLM `finalAnswer`. This result is included in the BullMQ completion event so downstream agents (e.g., the editor) receive real LLM output.

### KaibanTeamBridge (`src/infrastructure/kaibanjs/kaiban-team-bridge.ts`)

Wraps a KaibanJS `Team` and attaches `DistributedStateMiddleware` to `team.getStore()`. Every Zustand state mutation propagates to Redis Pub/Sub → SocketGateway → kaiban-board in real-time.

## Considered Alternatives

| Option | Pros | Cons |
|--------|------|------|
| Direct KaibanJS API calls in AgentActor | No bridge indirection | Couples AgentActor to KaibanJS; not testable in isolation |
| Modify KaibanJS internals | Full control | Forks upstream; maintenance burden |
| **Bridge pattern** ✓ | AgentActor stays framework-agnostic; testable with mocks | Two extra classes |

## Consequences

- `AgentActor` is completely decoupled from KaibanJS — can run any `TaskHandler`
- `createKaibanTaskHandler` returns `Promise<unknown>` (not `void`) to carry LLM results through completion events
- The `extractFinalAnswer()` helper handles four KaibanJS `AgentLoopResult` variants
- kaiban-board receives real distributed state via the bridge's `DistributedStateMiddleware` attachment
