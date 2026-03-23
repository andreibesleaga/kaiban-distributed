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

Maps a `MessagePayload` to a KaibanJS `Team` (one Team per task), calls `team.start(inputs)`, and returns a structured `KaibanHandlerResult` with `{ answer, inputTokens, outputTokens, estimatedCost }`. Token counts and cost come directly from `WorkflowResult.stats` — no extraction hacks needed.

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
- `WorkflowResult.stats.llmUsageStats` provides real token counts; cost is estimated via a built-in `MODEL_PRICING` table (covers OpenAI, Anthropic, OpenRouter models)
- kaiban-board receives real distributed state via the bridge's `DistributedStateMiddleware` attachment
