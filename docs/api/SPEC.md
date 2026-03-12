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

> **Note on `THINKING`:** `AgentStatePublisher` directly emits `IDLE`, `EXECUTING`, and `ERROR`. The `THINKING` status appears when KaibanJS internally transitions between reasoning steps — it is forwarded to the board via `DistributedStateMiddleware` (Zustand state interception), not via `AgentStatePublisher.wrapHandler()`.

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

### Agent Card

```
GET /.well-known/agent-card.json
```

```typescript
interface AgentCard {
  name: string;
  version: string;
  description: string;
  capabilities: string[];       // e.g. ['tasks.create', 'tasks.get', 'agent.status']
  endpoints: { rpc: string };   // e.g. '/a2a/rpc'
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
  method: 'agent.status' | 'tasks.create' | 'tasks.get';
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

**Supported methods:**

| Method | Request `params` | Returns |
|--------|-----------------|---------|
| `agent.status` | `{}` | `{ status: 'IDLE', agentId: string }` ¹ |
| `tasks.create` | `{ agentId, instruction, expectedOutput, inputs?, context? }` | `{ taskId, status: 'QUEUED', agentId }` |
| `tasks.get` | `{ taskId }` | `{ taskId, status: TaskStatus }` |

¹ `agent.status` always returns the static value `'IDLE'`. Live agent state is broadcast via Socket.io `state:update` events (see §6).

`tasks.create` publishes to `kaiban-agents-{agentId}` queue when `IMessagingDriver` is wired (see `src/infrastructure/federation/a2a-connector.ts`).

> **Note:** The `tasks.create` response uses `status: 'QUEUED'` as an API-level acknowledgment that the task has been accepted and enqueued. This is distinct from the domain `TaskStatus` type (`'TODO' | 'DOING' | 'AWAITING_VALIDATION' | 'DONE' | 'BLOCKED'`). Once a worker claims the task, its domain status transitions to `'DOING'`.

---

## 4. KaibanJS Integration

### Agent Task Handler

```typescript
// src/infrastructure/kaibanjs/kaiban-agent-bridge.ts
function createKaibanTaskHandler(
  agentConfig: KaibanAgentConfig,    // IAgentParams from kaibanjs
  driver: IMessagingDriver,
): (payload: MessagePayload) => Promise<unknown>
// Returns the LLM finalAnswer, included in kaiban-events-completed data.result
```

### Team State Bridge

```typescript
// src/infrastructure/kaibanjs/kaiban-team-bridge.ts
class KaibanTeamBridge {
  constructor(config: KaibanTeamConfig, driver: IMessagingDriver, stateChannel?: string)
  getTeam(): Team
  start(inputs?: Record<string, unknown>): Promise<WorkflowResult>
  subscribeToChanges(listener, properties?): () => void
}
```

---

## 5. HTTP API (Edge Gateway)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Returns `{ data: { status: 'ok', timestamp } }` |
| `GET` | `/.well-known/agent-card.json` | None | Agent capabilities |
| `POST` | `/a2a/rpc` | None | JSON-RPC 2.0 (requires `Content-Type: application/json`) |

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
    result?: string;             // capped at 800 chars
  }>;

  // Workflow lifecycle (set exclusively by the orchestrator — never by workers)
  teamWorkflowStatus?: 'RUNNING' | 'FINISHED' | 'STOPPED';
}
```

> **Source of deltas:** `AgentStatePublisher` emits `IDLE → EXECUTING → IDLE/ERROR` agent transitions with matching task `DOING → DONE/BLOCKED` updates. The orchestrator emits `teamWorkflowStatus` changes and `AWAITING_VALIDATION` task states. `DistributedStateMiddleware` forwards KaibanJS internal state (including `THINKING`) as additional deltas.

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
