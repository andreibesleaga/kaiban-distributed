# Technical Specifications (SPEC.md)

> **Note:** This document reflects the actual implementation. See `docs/decisions/ADR-001` for the rationale behind the `IMessagingDriver` generalization from the original domain-specific interface names.

---

## 1. Domain Models

### Agent State Schema

```typescript
// src/domain/entities/DistributedAgentState.ts
type AgentStatus = 'IDLE' | 'THINKING' | 'EXECUTING' | 'ERROR';

interface DistributedAgentState {
  agentId: string;
  status: AgentStatus;
  currentTaskId: string | null;
  memory: Record<string, unknown>;
  version: string;                   // ETag for optimistic concurrency
}
```

> **Note on `THINKING`:** `AgentStatePublisher.wrapHandler()` emits the full per-task status sequence directly — `EXECUTING` (task starting) → `THINKING` (LLM call in progress) → `IDLE` (done) or `ERROR` (`src/adapters/state/agent-state-publisher.ts`). The deprecated `DistributedStateMiddleware` (Zustand state interception) is an alternative bridge for the in-process `KaibanTeamBridge` path; on the distributed worker path `THINKING` comes from `wrapHandler()`, not the middleware.

### Task Workflow Schema

```typescript
// src/domain/entities/DistributedTask.ts
type TaskStatus = 'TODO' | 'DOING' | 'AWAITING_VALIDATION' | 'DONE' | 'BLOCKED';

interface TaskLog {
  timestamp: number;                 // Unix ms (number, not string)
  level: string;
  message: string;
  traceId: string;
}

interface TaskPayload {
  instruction: string;
  expectedOutput: string;
  context: string[];                 // Array of context strings
}

interface DistributedTask {
  taskId: string;
  assignedToAgentId: string | null;
  status: TaskStatus;
  payload: TaskPayload;
  result: unknown | null;
  logs: TaskLog[];
}
```

---

## 2. Messaging Abstraction Layer (MAL) Interface

```typescript
// src/infrastructure/messaging/interfaces.ts

interface MessagePayload {
  taskId: string;
  agentId: string;
  data: Record<string, unknown>;
  timestamp: number;
  traceHeaders?: Record<string, string>;   // W3C traceparent/tracestate (ADR-005)
}

interface IMessagingDriver {
  publish(queueName: string, payload: MessagePayload): Promise<void>;
  subscribe(
    queueName: string,
    handler: (payload: MessagePayload) => Promise<void>,
  ): Promise<void>;
  unsubscribe(queueName: string): Promise<void>;
  disconnect(): Promise<void>;
}
```

**Implementations:**
| Class | Backend | Config |
|-------|---------|--------|
| `BullMQDriver` | Redis / BullMQ v5 | `REDIS_URL`, `MESSAGING_DRIVER=bullmq` |
| `KafkaDriver` | Apache Kafka | `KAFKA_BROKERS`, `MESSAGING_DRIVER=kafka` |

**Queue naming convention:** dashes only — BullMQ v5 rejects colons (see ADR-002).

---

## 3. Federation: A2A Protocol Standard Endpoints

> **A2A v0.3 (ADR-015).** As of the v2.0 migration the A2A surface is served by the
> official `@a2a-js/sdk` (v0.3.x) — it is now a real, wire-conformant A2A v0.3 server.
> The legacy custom methods (`tasks.create` / `tasks.get` / `agent.status`) and the flat
> `{ capabilities: string[], endpoints: { rpc } }` card shape were **removed** (the custom
> `A2AConnector` is gone). The shapes below reflect the v0.3 implementation.

### Agent Card (v0.3)

```
GET /.well-known/agent-card.json
```

```typescript
// @a2a-js/sdk AgentCard (v0.3) — built by src/infrastructure/federation/a2a-agent-card.ts
interface AgentCard {
  protocolVersion: string;            // '0.3.0'
  name: string;
  description: string;
  url: string;                        // JSON-RPC URL, e.g. '<baseUrl>/a2a/rpc'
  version: string;
  preferredTransport: 'JSONRPC';
  additionalInterfaces: Array<{ transport: string; url: string }>;  // JSONRPC + HTTP+JSON + GRPC
  capabilities: {                     // ← an OBJECT in v0.3 (was a string[] in the old card)
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  defaultInputModes: string[];        // ['text/plain', 'application/json']
  defaultOutputModes: string[];
  skills: Array<{ id: string; name: string; description?: string; tags?: string[] }>;  // one skill per agent id
  securitySchemes?: Record<string, unknown>;  // env-gated JWT bearer scheme
  security?: Array<Record<string, string[]>>;
  provider?: { organization: string; url: string };
}
```

### JSON-RPC 2.0 Endpoint

```
POST /a2a/rpc
Content-Type: application/json
```

**Request:**
```typescript
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: 'message/send' | 'message/stream' | 'tasks/get' | 'tasks/cancel';
  params?: Record<string, unknown>;
}
```

**Response:**
```typescript
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}
```

**Supported methods (A2A v0.3, served by `@a2a-js/sdk`):**

| Method | Purpose | Notes |
|--------|---------|-------|
| `message/send` | Dispatch a task and await its terminal result | Target agent in `message.metadata.agentId`; optional `instruction`/`expectedOutput`/`context`/`inputs` in `metadata` (or plain text parts). Input caps (`A2A_INPUT_CAPS`, 64 KB) enforced; oversized/wrong-typed input → `-32602`. |
| `message/stream` | Same as `message/send` but streams lifecycle events over SSE | `submitted → working → completed/failed/canceled` |
| `tasks/get` | Fetch a persisted task by id | Real data from the Redis-backed `RedisTaskStore` (survives restart / scaled pool) |
| `tasks/cancel` | Cancel an in-flight task | Aborts the in-flight `CompletionRouter.wait` and emits a terminal `canceled` |

Live agent status is **not** a JSON-RPC method — it is `GET /a2a/agents/:agentId/status`
(real last-known status from `AgentStatusTracker`, which reads `kaiban-state-events` over
Redis Pub/Sub). Live agent state is also broadcast via Socket.io `state:update` (see §6).

`message/send` validates the input then publishes a `MessagePayload` to the
`kaiban-agents-{agentId}` mailbox (via `KaibanAgentExecutor`, see
`src/infrastructure/federation/a2a-executor.ts`) and resolves the result via
`CompletionRouter`. The A2A `taskId` is the dedup key end-to-end (invariant I3).

> **Internal dispatch path.** Internal orchestration (an orchestrator → its workers) does
> **not** go through A2A — it uses the actor-mailbox primitive
> `dispatchToAgent(driver, agentId, { instruction, expectedOutput?, context?, inputs? })`
> (`src/shared/dispatch.ts`), which returns a `taskId` to await via `CompletionRouter.wait`.
> A2A is the **external** federation surface; `dispatchToAgent` is the in-process one.

---

## 4. KaibanJS Integration

### Agent Task Handler

```typescript
// src/infrastructure/kaibanjs/kaiban-agent-bridge.ts
function createKaibanTaskHandler(
  agentConfig: KaibanAgentConfig,    // IAgentParams from kaibanjs
  _driver: IMessagingDriver,
  tokenProvider?: ITokenProvider,   // optional JIT token provider
): TaskHandler   // (payload: MessagePayload, signal?: AbortSignal) => Promise<unknown>
// Resolves to a KaibanHandlerResult:
//   { answer: string; inputTokens: number; outputTokens: number; estimatedCost: number }
// `answer` is the LLM result (JSON-stringified if non-string), included in
// kaiban-events-completed data.result; the token/cost fields drive the economics panel.
```

### Team State Bridge

```typescript
// src/infrastructure/kaibanjs/kaiban-team-bridge.ts
// @deprecated — for single-task execution prefer createKaibanTaskHandler
class KaibanTeamBridge {
  constructor(config: KaibanTeamConfig, middleware?: IStateMiddleware)
  getTeam(): Team
  start(inputs?: Record<string, unknown>): Promise<{ status: string; result: unknown; stats: unknown }>
  subscribeToChanges(listener, properties?): () => void
}
```

---

## 5. HTTP API (Edge Gateway)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Returns `{ data: { status: 'ok', timestamp } }` |
| `GET` | `/.well-known/agent-card.json` | None | Agent capabilities |
| `POST` | `/a2a/rpc` | None (JWT verified when A2A_JWT_SECRET is set) | JSON-RPC 2.0 (requires `Content-Type: application/json`) |

All responses use the envelope: `{ data, meta, errors }`.
Error responses: `{ data: null, errors: [{ message }] }`.

---

## 6. Real-Time State — Socket.io

**Server:** Edge Gateway binds Socket.io to the HTTP server with Redis adapter for multi-node scaling.

**Event emitted to clients:**
```
socket.emit('state:update', delta: Record<string, unknown>)
```

**Delta payload shape** (partial — only changed fields are included per publish):
```typescript
interface StateDelta {
  // Agent state (from AgentStatePublisher or distributedMiddleware)
  agents?: Array<{
    agentId: string;
    name: string;
    role: string;
    status: AgentStatus;         // 'IDLE' | 'THINKING' | 'EXECUTING' | 'ERROR'
    currentTaskId: string | null;
  }>;

  // Task state (from AgentStatePublisher or distributedMiddleware)
  tasks?: Array<{
    taskId: string;
    title: string;
    status: TaskStatus;          // 'TODO' | 'DOING' | 'AWAITING_VALIDATION' | 'DONE' | 'BLOCKED'
    assignedToAgentId: string;
    result?: string;             // capped at 20,000 UTF-8 bytes (≈20 KB), truncated on a codepoint boundary
  }>;

  // Workflow lifecycle (set exclusively by the orchestrator — never by workers)
  teamWorkflowStatus?: 'RUNNING' | 'FINISHED' | 'STOPPED' | 'ERRORED';
}
```

> **Source of deltas:** `AgentStatePublisher.wrapHandler()` emits `EXECUTING → THINKING → IDLE/ERROR` agent transitions with matching task `DOING → DONE/BLOCKED` updates. The orchestrator emits `teamWorkflowStatus` changes and `AWAITING_VALIDATION` task states. The deprecated `DistributedStateMiddleware` forwards KaibanJS internal state for the in-process `KaibanTeamBridge` path.

PII keys (`email`, `name`, `phone`, `ip`, `password`, `token`, `secret`, `ssn`, `dob`) are stripped before publishing (see `DistributedStateMiddleware.sanitizeDelta`).

---

## 7. Acceptance Criteria (from tests/e2e/acceptance-criteria.md)

| Feature | Test | Status |
|---------|------|--------|
| Distributed Task Execution | `tests/e2e/distributed-execution.test.ts` Scenario 1 | ✅ |
| Fault Tolerance (retry + DLQ) | `tests/e2e/distributed-execution.test.ts` Scenario 2 | ✅ |
| UI State Synchronization | `tests/e2e/distributed-execution.test.ts` Scenario 3 | ✅ |
| A2A Protocol endpoints | `tests/e2e/a2a-protocol.test.ts` | ✅ |
| Kafka publish/subscribe | `tests/e2e/kafka-driver.test.ts` | ✅ |
