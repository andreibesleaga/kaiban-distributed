# Architecture Plan (PLAN.md)
## System Architecture & C4 Diagrams

### 1. System Context Diagram
Source: [diagrams/system-context.mmd](diagrams/system-context.mmd) (one copy; GitHub renders `.mmd` files).

### 2. Container Diagram
Source: [diagrams/container-architecture.mmd](diagrams/container-architecture.mmd) (one copy). The version used in the README, with every channel and the STOP ALL path, is the "C4 container view" in the [README](../../README.md#c4-container-view); more views are in [DIAGRAMS.md](DIAGRAMS.md).

### 3. Component Hierarchy (Internal Node.js Layout)
- `src/infrastructure/messaging/`
  - `interfaces.ts`: Base interfaces for Drivers
  - `bullmq-driver.ts`: Implementation using BullMQ & Redis.
  - `kafka-driver.ts`: Implementation using KafkaJS.
- `src/adapters/state/`
  - `distributedMiddleware.ts`: Zustand interceptor publishing state deltas.
  - `agent-state-publisher.ts`: Direct Redis pub/sub; 15s heartbeat; lifecycle.
- `src/application/actor/`
  - `AgentActor.ts`: Encapsulation of a single KaibanJS agent with local task queue processing.
- `src/infrastructure/federation/`
  - `a2a-executor.ts` / `a2a-task-store.ts` / `a2a-agent-card.ts` / `agent-status-tracker.ts`: the official `@a2a-js/sdk` v0.3 server building blocks — builds the v0.3 AgentCard and bridges `message/send` onto the agent mailbox (replaced the removed `a2a-connector.ts`, ADR-015).
  - `mcp-client.ts`: Integrates existing MCP servers securely.
- `src/infrastructure/control/`: `control-channel.ts`, the `kaiban-control` channel and `ControlSubscriber` for the emergency STOP ALL (ADR-025).
- `src/economics/`: fleet cost control, off by default (ADR-019).
- `src/governance/`: Action Gate, policy engine, agent registry, audit log, off by default (ADR-020).
- `src/memory/`: `SecureMemoryStore` (ADR-020).
- `src/resilience/`: DLQ replay, graceful shutdown, readiness and startup probes (ADR-018).
- `src/shared/`: driver factory, `CompletionRouter`, orchestration helpers, spend caps (published as `kaiban-distributed/shared`).
- `src/main/`: the entry point; the gateway and worker roles (`ROLE`, ADR-013) and the `stop-all` command.
