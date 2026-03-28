# Distributed Actor Model in kaiban-distributed

## Overview

kaiban-distributed implements the **Distributed Actor Model** to run AI agents as fully isolated, independently deployable processes that communicate exclusively through message-passing. Each agent is an autonomous actor with its own mailbox (queue), lifecycle, and fault-containment boundary.

This document explains how the actor model is applied throughout the codebase, from the core `AgentActor` class to the blog-team example and the supporting infrastructure.

---

## Actor Model Fundamentals Applied Here

| Actor Model Principle | kaiban-distributed Implementation |
|----------------------|-----------------------------------|
| **Identity** | Each actor has a unique `agentId` string (e.g. `'researcher'`, `'writer'`, `'editor'`) |
| **Mailbox** | One dedicated BullMQ queue or Kafka topic per actor — `kaiban-agents-{agentId}` |
| **Message-passing only** | Actors never call each other's methods; every interaction goes through `IMessagingDriver.publish()` |
| **Isolation** | Each actor runs in its own OS process (`researcher-node.ts`, etc.) — a crash in one actor does not affect others |
| **Behaviour** | `TaskHandler` function defines what the actor does when it receives a message |
| **Supervision** | Docker Compose `restart: unless-stopped` / Kubernetes Deployment acts as the supervisor |

---

## Core Actor: `AgentActor`

**File**: [`src/application/actor/AgentActor.ts`](../../src/application/actor/AgentActor.ts)

`AgentActor` is the single actor implementation. Every agent in the system is an instance of this class.

```
AgentActor
├── id:            string          — actor identity
├── queueName:     string          — mailbox address (BullMQ queue / Kafka topic)
├── driver:        IMessagingDriver — transport abstraction (BullMQ or Kafka)
├── taskHandler?:  TaskHandler      — behaviour: what to do with each message
├── firewall?:     ISemanticFirewall — security guard (prompt-injection scan)
└── circuitBreaker?: ICircuitBreaker — fault guard (open = reject messages)
```

### Lifecycle

```
actor.start()
  └── driver.subscribe(queueName, processTask)   ← registers mailbox listener

processTask(payload)
  ├── Check agentId match (ignore messages for other actors)
  ├── isBlockedByGuards()
  │   ├── circuitBreaker.isOpen()? → publishToDlq(reason: circuit_breaker_open)
  │   └── firewall.evaluate(payload)? → publishToDlq(reason: blocked_by_semantic_firewall)
  └── executeWithRetries(payload)
      ├── attempt 1..3: taskHandler(payload)
      │   ├── success → driver.publish(COMPLETED_CHANNEL, result)
      │   └── failure → delay(100ms × attempt) → retry
      └── all retries failed → circuitBreaker.recordFailure()
                             → driver.publish(DLQ_CHANNEL, error)

actor.stop()
  └── driver.unsubscribe(queueName)
```

### Safety Mechanisms

- **64 KB data cap** (`capDataSize`): results are truncated before publishing to prevent oversized messages from overwhelming the messaging layer.
- **SHA-256 ID hashing** (`sanitizeId`): actor IDs are hashed in logs — 8-char prefix preserves debuggability while preventing PII leakage.
- **Exponential backoff**: retry delay = `100ms × attempt` (attempt 1 = 100ms, attempt 2 = 200ms, attempt 3 = 300ms).

---

## Messaging Abstraction: `IMessagingDriver`

**File**: [`src/infrastructure/messaging/interfaces.ts`](../../src/infrastructure/messaging/interfaces.ts)

```typescript
interface IMessagingDriver {
  publish(queueName: string, payload: MessagePayload): Promise<void>;
  subscribe(queueName: string, handler: (payload: MessagePayload) => Promise<void>): Promise<void>;
  unsubscribe(queueName: string): Promise<void>;
  disconnect(): Promise<void>;
}
```

Swapping the messaging backend is a single env var change:

```
MESSAGING_DRIVER=bullmq   # (default) BullMQ on Redis
MESSAGING_DRIVER=kafka    # Apache Kafka
```

Worker code is identical regardless of which driver is active. The driver factory (`examples/blog-team/driver-factory.ts`) constructs the right implementation at startup.

### BullMQ Driver
- One `Worker` per queue subscription
- Redis-backed with persistence
- DLQ = `kaiban-events-failed` queue
- ADR: [ADR-001](../decisions/ADR-001-messaging-driver-abstraction.md), [ADR-002](../decisions/ADR-002-bullmq-queue-naming.md)

### Kafka Driver
- One `Consumer Group` per queue subscription
- Automatic partition assignment — add more consumer instances and Kafka rebalances
- Two separate driver instances in `CompletionRouter` (KafkaJS limitation: cannot subscribe to new topics after `consumer.run()` starts)

---

## Actor Topology: Blog-Team Example

The blog-team demonstrates a **pipeline actor topology** — actors are chained in sequence by the orchestrator, with the orchestrator acting as a coordinator (not an actor itself).

```
┌─────────────────────────────────────────────────────────────────┐
│  Orchestrator (coordinator — not an actor)                      │
│  examples/blog-team/orchestrator.ts                             │
│                                                                 │
│  1. publish(researcherQueue, {taskId, agentId:'researcher',...}) │
│  2. await CompletionRouter.wait(researchTaskId)                 │
│  3. publish(writerQueue, {taskId, agentId:'writer', context:…}) │
│  4. await CompletionRouter.wait(writeTaskId)                    │
│  5. publish(editorQueue, {taskId, agentId:'editor', context:…}) │
│  6. await CompletionRouter.wait(editTaskId)                     │
│  7. waitForHITLDecision(editTaskId, rl, redis)  ← human input  │
└──────┬───────────────────┬──────────────────────┬──────────────┘
       │                   │                      │
       ▼ queue             ▼ queue                ▼ queue
┌──────────────┐  ┌────────────────┐  ┌───────────────────────┐
│ AgentActor   │  │ AgentActor     │  │ AgentActor            │
│ researcher   │  │ writer         │  │ editor                │
│ (Ava)        │  │ (Kai)          │  │ (Morgan)              │
│              │  │                │  │                       │
│ process:     │  │ process:       │  │ process:              │
│ researcher-  │  │ writer-        │  │ editor-               │
│ node.ts      │  │ node.ts        │  │ node.ts               │
└──────┬───────┘  └────────┬───────┘  └────────────┬──────────┘
       │                   │                        │
       └───────────────────┴────────────────────────┘
                           │ publish(COMPLETED_CHANNEL, result)
                           ▼
                  ┌─────────────────┐
                  │ CompletionRouter │
                  │ (orchestrator)  │
                  └─────────────────┘
```

Each actor process is started independently:
```bash
# Three separate processes — isolated actors
npx ts-node examples/blog-team/researcher-node.ts
npx ts-node examples/blog-team/writer-node.ts
npx ts-node examples/blog-team/editor-node.ts
```

In Docker, each runs in its own container with `restart: unless-stopped` supervision.

---

## Message Payload

**File**: [`src/infrastructure/messaging/interfaces.ts`](../../src/infrastructure/messaging/interfaces.ts)

```typescript
interface MessagePayload {
  taskId:        string;                     // unique task ID — correlation key
  agentId:       string;                     // target actor identity
  data:          Record<string, unknown>;    // task parameters (instruction, context, inputs)
  timestamp:     number;                     // Unix ms — for ordering and timeouts
  traceHeaders?: Record<string, string>;     // W3C TraceContext — distributed tracing
}
```

The `agentId` field enforces actor addressing: each actor checks `payload.agentId !== this.id` and silently discards messages not addressed to it. A wildcard `'*'` allows broadcast messages.

---

## W3C TraceContext Propagation

`traceHeaders` carries W3C `traceparent` / `tracestate` headers injected at the publish point and extracted at the subscribe point. This enables distributed traces to span actor hops without coupling actors to each other.

ADR: [ADR-005](../decisions/ADR-005-trace-context-propagation.md)

---

## State Publishing: Observability Side-Channel

State publishing is **not** actor-to-actor messaging — it is a separate observability channel that flows from workers → Redis Pub/Sub → SocketGateway → board UI.

```
AgentActor.executeWithRetries()
  └── TaskHandler (wrapped by AgentStatePublisher.wrapHandler())
      ├── publish EXECUTING state → kaiban-state-events (Redis Pub/Sub)
      ├── call LLM via KaibanJS
      └── publish DONE / ERROR state → kaiban-state-events

OrchestratorStatePublisher (orchestrator)
  ├── workflowStarted()  → RUNNING + agents + inputs
  ├── taskQueued()       → task in TODO column
  ├── awaitingHITL()     → AWAITING_VALIDATION
  ├── workflowFinished() → FINISHED + all agents IDLE
  └── workflowStopped()  → STOPPED

                          ▼ Redis Pub/Sub: kaiban-state-events

                  ┌───────────────────┐
                  │   SocketGateway   │
                  │ accumulates state │
                  │ snapshot (Map by  │
                  │ agentId/taskId)   │
                  └────────┬──────────┘
                           │ Socket.io state:update
                           ▼
                    Board UI (any client)
```

**Key separation of concerns**:
- `AgentStatePublisher` (per actor): agent status + task DOING/DONE/ERROR
- `OrchestratorStatePublisher` (coordinator only): `teamWorkflowStatus` lifecycle
- Workers **never** set `teamWorkflowStatus` — only the orchestrator controls this. Prevents 15s heartbeats from overriding FINISHED/STOPPED states.

---

## Fault Containment

```
Process crash (e.g. writer-node.ts OOM):
  ├── researcher continues processing its queue
  ├── editor continues processing its queue
  ├── writer queue accumulates messages (BullMQ persists them in Redis)
  └── Docker restarts writer-node.ts → worker resumes consuming from queue
      └── Inflight message: BullMQ re-queues after lock timeout
```

**Within an actor**:
- Any exception from `taskHandler` → retry up to 3×
- All retries failed → `circuitBreaker.recordFailure()` + DLQ publish
- Circuit breaker open (5 failures) → subsequent messages routed to DLQ immediately

This ensures a single failing LLM call does not crash the actor or lose the task.

---

## HITL: Human as Actor

The Human-in-the-Loop decision is modelled as an external actor input that races two channels:

```
AWAITING_VALIDATION state published → board shows banner with buttons

Two channels race in waitForHITLDecision():
  ├── Terminal readline: [1] PUBLISH  [2] REVISE  [3] REJECT  [4] VIEW
  └── Redis Pub/Sub:    'kaiban-hitl-decisions' ← board sends hitl:decision via Socket.io

First channel to deliver a valid decision wins → orchestrator continues
```

ADR: [ADR-004](../decisions/ADR-004-hitl-editorial-review.md)

---

## Security Guards (Actor-Level)

Security is applied at the actor boundary — before `taskHandler` is invoked:

| Guard | File | When Active |
|-------|------|-------------|
| `HeuristicFirewall` | `src/domain/security/` | `SEMANTIC_FIREWALL_ENABLED=true` |
| `SlidingWindowBreaker` | `src/domain/security/` | `CIRCUIT_BREAKER_ENABLED=true` |
| `EnvTokenProvider` | `src/infrastructure/security/` | `SECURE_TOKEN_PROVIDER=true` |

`sanitizeDelta()` in `DistributedStateMiddleware` scrubs PII (email, name, phone, IP, password, token, secret, SSN, DOB) from state deltas before they reach the board.

---

## Horizontal Scaling

The actor model scales horizontally without any code changes:

**BullMQ** — competing consumers:
```bash
# Start 3 writer actors — BullMQ distributes queue items round-robin
npx ts-node examples/blog-team/writer-node.ts &
npx ts-node examples/blog-team/writer-node.ts &
npx ts-node examples/blog-team/writer-node.ts &
```

**Kafka** — Consumer Group auto-rebalance:
```bash
# Each writer-node joins the same Consumer Group
# Kafka assigns partitions automatically as instances join/leave
MESSAGING_DRIVER=kafka npx ts-node examples/blog-team/writer-node.ts &
MESSAGING_DRIVER=kafka npx ts-node examples/blog-team/writer-node.ts &
```

**Kubernetes**: Each actor type is a separate `Deployment`. Scale replicas independently:
```yaml
# scale writer independently of researcher/editor
kubectl scale deployment kaiban-writer --replicas=3
```

See the E2E horizontal scaling tests:
- [`tests/e2e/horizontal-scaling-bullmq.test.ts`](../../tests/e2e/horizontal-scaling-bullmq.test.ts)
- [`tests/e2e/horizontal-scaling-kafka.test.ts`](../../tests/e2e/horizontal-scaling-kafka.test.ts)

---

## Channel Names

**File**: [`src/infrastructure/messaging/channels.ts`](../../src/infrastructure/messaging/channels.ts)

| Channel | Transport | Purpose |
|---------|-----------|---------|
| `kaiban-agents-{agentId}` | BullMQ queue / Kafka topic | Actor mailbox — task messages |
| `kaiban-events-completed` | BullMQ queue / Kafka topic | Completion results → CompletionRouter |
| `kaiban-events-failed` | BullMQ queue / Kafka topic | DLQ — failed after 3 retries |
| `kaiban-state-events` | Redis Pub/Sub | Observability — actor state → board |
| `kaiban-hitl-decisions` | Redis Pub/Sub | HITL — board decision → orchestrator |

---

## KaibanJS Bridge

**File**: [`src/infrastructure/kaibanjs/kaiban-agent-bridge.ts`](../../src/infrastructure/kaibanjs/kaiban-agent-bridge.ts)

`createKaibanTaskHandler` wraps a KaibanJS `Agent` + `Team` in a `TaskHandler`. This makes any KaibanJS agent slot into the actor model without modification:

```
AgentActor receives MessagePayload
  └── TaskHandler = createKaibanTaskHandler(agentConfig, driver, tokenProvider)
      ├── Creates a fresh Team per task (stateless execution)
      ├── team.start({ task: payload.data.instruction })
      ├── status ERRORED → throw (triggers AgentActor retry)
      └── returns result string (token counts available from WorkflowResult.stats)
```

ADR: [ADR-003](../decisions/ADR-003-kaiban-team-bridge-pattern.md)

---

## Architecture Decision Records

The following ADRs document design decisions related to the Actor Model implementation:

- [ADR-001](../decisions/ADR-001-messaging-driver-abstraction.md) — Messaging driver abstraction (BullMQ ↔ Kafka)
- [ADR-002](../decisions/ADR-002-bullmq-queue-naming.md) — Queue naming conventions
- [ADR-003](../decisions/ADR-003-kaiban-team-bridge-pattern.md) — KaibanJS Team-per-task bridge pattern
- [ADR-004](../decisions/ADR-004-hitl-editorial-review.md) — HITL editorial review and decision racing
- [ADR-005](../decisions/ADR-005-trace-context-propagation.md) — W3C TraceContext propagation across actor hops
