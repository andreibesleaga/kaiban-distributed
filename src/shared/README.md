# `src/shared` — Reusable Orchestration Utilities

Public API shared between the examples in this repository, and published as the
`kaiban-distributed/shared` entry point of the npm package.
Import from the barrel (inside this repository; package users import from `kaiban-distributed/shared`):

```typescript
import {
  createLogger,
  getDriverType,
  createDriver,
  buildSecurityDeps,
  getBoolEnv,
  buildLLMConfig,
  parseHandlerResult,
  parseRecommendation,
  parseScore,
  normaliseEditorialText,
  CompletionRouter,
  createRpcClient,
  waitForHITLDecision,
  OrchestratorStatePublisher,
  WorkflowOrchestrator,
  dispatchToAgent,
  startAgentNode,
} from "../../src/shared";
```

---

## Modules

### `logger.ts` — Tagged console wrapper

```typescript
const log = createLogger("MyTag");
log.info("started"); // [MyTag] started
log.warn("slow");
log.error("boom", err);
log.separator(); // ─────────────────────── (60 chars)
log.header("Phase 1"); // \n=== Phase 1 ===\n═══…
```

---

### `driver-factory.ts` — BullMQ / Kafka / AMQP driver

```typescript
const driverType = getDriverType(); // 'bullmq' | 'kafka' | 'amqp' (amqp is an unimplemented seam)
const driver = createDriver("-suffix"); // IMessagingDriver
```

Creates a BullMQ or Kafka `IMessagingDriver` depending on `MESSAGING_DRIVER` env var (`amqp` is accepted by the configuration but is an unimplemented seam, ADR-016).
Pass a group-ID suffix to isolate consumer groups across orchestrator instances.

---

### `build-security-deps.ts` — Security middleware factory

```typescript
const { actorDeps, tokenProvider } = buildSecurityDeps();
// actorDeps: AgentActorDeps   (semantic firewall, circuit breaker)
// tokenProvider?: ITokenProvider  (JIT tokens when JIT_TOKENS_ENABLED=true)
```

Reads: `SEMANTIC_FIREWALL_ENABLED`, `CIRCUIT_BREAKER_ENABLED`, `CIRCUIT_BREAKER_THRESHOLD`,
`CIRCUIT_BREAKER_WINDOW_MS`, `JIT_TOKENS_ENABLED`.

---

### `build-llm-config.ts` — LLM provider config

```typescript
const llmConfig = buildLLMConfig();
// Returns KaibanAgentConfig['llmConfig'] | undefined
// Priority: OPENROUTER_API_KEY → OPENAI_API_KEY → undefined (uses Kaiban default)
```

---

### `parse-handler-result.ts` — Agent output parsers

```typescript
const { answer, inputTokens, outputTokens, estimatedCost } =
  parseHandlerResult(raw);

const rec = parseRecommendation(text); // 'PUBLISH' | 'REVISE' | 'REJECT' | 'APPROVED' | ...
const score = parseScore(text, "Accuracy"); // e.g. "8.5/10" or "N/A"
const score = parseScore(text, "Compliance"); // same regex, different label context
const md = normaliseEditorialText(raw); // JSON editor output → Markdown
```

---

### `completion-router.ts` — Fan-in task completion

```typescript
const router = new CompletionRouter(completedDriver, failedDriver?);

const result   = await router.wait(taskId, 120_000, 'writing');
const results  = await router.waitAll(taskIds, 120_000, 'search-fan-in', signal?);
// results: Array<{ taskId, result?: string, error?: string }>
```

Subscribes to `kaiban-events-completed` and `kaiban-events-failed`.
`waitAll` aggregates a fan-out: a failed task gets `.error` and the call does not throw. If you pass a fourth argument, an `AbortSignal`, aborting it rejects the call (STOP ALL uses this).

---

### `rpc-client.ts` — JSON-RPC 2.0 A2A client

```typescript
const client = createRpcClient(GATEWAY_URL);
client.setToken(issueA2AToken('my-orchestrator')); // optional bearer auth
// A2A v0.3: the gateway answers message/send, message/stream, tasks/get, tasks/cancel
const result = await client.call('message/send', {
  message: {
    kind: 'message', role: 'user', messageId: 'm1',
    parts: [{ kind: 'text', text: 'Write the article' }],
    metadata: { agentId: 'writer' },
  },
});
```

`call` posts any method name; the v1 `tasks.create` method no longer exists (ADR-015). Orchestrators
that run their own workers dispatch with `dispatchToAgent` instead (below).

---

### `hitl.ts` — Human-in-the-loop decision gate

```typescript
const decision = await waitForHITLDecision({
  taskId,
  rl,          // readline.Interface | null  (null → board-only)
  redisUrl,
  onView?: () => { /* show draft when user types [4] */ },
  signal?: AbortSignal,  // STOP ALL ends the wait: the promise rejects with the signal's reason
});
// decision: 'PUBLISH' | 'REVISE' | 'REJECT'
```

Listens in parallel on:

- **Terminal** via `readline` — `[1] PUBLISH  [2] REVISE  [3] REJECT  [4] VIEW` (VIEW is terminal-only; the board cannot send it)
- **Board** via Redis `kaiban-hitl-decisions` channel (SocketGateway publishes here)

First source to deliver a valid decision wins; the other is cleaned up.

---

### `orchestrator-state-publisher.ts` — Base state broadcaster

```typescript
class MyStatePublisher extends OrchestratorStatePublisher {
  workflowStarted(topic: string): void {
    this.publish({ teamWorkflowStatus: "RUNNING", inputs: { topic } });
  }
}

const pub = new MyStatePublisher(REDIS_URL);
pub.taskQueued(taskId, "Write article", "writer");
pub.taskDone(taskId, "writer");
pub.taskFailed(taskId, "writer", "Write article", err.message);
pub.publishMetadata({ totalTokens: 1200, estimatedCost: 0.0042 });
await pub.disconnect();
```

`publish(delta)` is fire-and-forget — signs the delta with `wrapSigned()` and publishes
to `kaiban-state-events`. The Redis connection is exposed as `protected this.redis` for
subclasses that need direct Redis access.

---

### `agent-node.ts` — Single-function node bootstrap

Reduces every agent node process to ~10 lines:

```typescript
import "dotenv/config";
import { startAgentNode } from "../../src/shared";
import { writerConfig, WRITER_QUEUE } from "./team-config";

startAgentNode({
  agentId: process.env["AGENT_ID"] ?? "writer",
  queue: WRITER_QUEUE,
  agentConfig: writerConfig,
  displayName: "Atlas",
  role: "Research Synthesiser",
  label: "[Writer]",
}).catch((err: unknown) => {
  console.error("[Writer] Startup failed:", err);
  process.exit(1);
});
```

Internally: `createDriver` → `buildSecurityDeps` → `AgentStatePublisher` → `wrapHandler` → `AgentActor.start()` → `publishIdle()` → SIGTERM handler.

---

### `emergency-stop.ts` — STOP ALL for nodes and orchestrators

Off unless `CONTROL_PLANE_ENABLED=true` (ADR-025). An orchestrator gets an abort signal that fires on the first STOP ALL issued after it started, and passes it to `WorkflowOrchestrator` (`stopSignal`), `waitForHITLDecision` (`signal`) and `CompletionRouter.waitAll` (`signal`):

```typescript
const stop = controlPlaneEnabled() ? await createEmergencyStopSignal(REDIS_URL) : null;
const orch = new WorkflowOrchestrator({
  workflowId, router, store, ...(stop ? { stopSignal: stop.signal } : {}),
});
// the abort reason is an EmergencyStopError; call stop?.close() on exit
```

Worker nodes use `attachEmergencyStop` (done for you by `startAgentNode`). `createStopAllCommand` builds a command; issuing one from code is `issueStopAll` in the root `kaiban-distributed` entry, and `npm run stop-all` is the command line. The working example is `examples/blog-team/orchestrator.ts`.

---

### Other modules

Each file's header comment has the details.

| Module | What it does | Exported from the barrel |
| --- | --- | --- |
| `orchestrator.ts` | `WorkflowOrchestrator`: single-active workflow runner over `CompletionRouter`, with Redis checkpoint and resume and `taskId` dedup (ADR-018); not highly available | yes |
| `emergency-stop.ts` | attach a node or orchestrator to the `kaiban-control` channel (ADR-025); off unless `CONTROL_PLANE_ENABLED=true`; exports `controlPlaneEnabled`, `createStopAllCommand`, `attachEmergencyStop`, `createEmergencyStopSignal`, `EmergencyStopError` | yes |
| `dispatch.ts` | `dispatchToAgent(driver, agentId, { instruction, expectedOutput?, context?, inputs? })`: publishes to `kaiban-agents-{id}` and returns the `taskId` to await | yes |
| `budget.ts` | Parses the four spend caps (`MAX_WORKFLOW_COST_USD`, `MAX_WORKFLOW_TOKENS`, `MAX_TOKEN_BUDGET`, `MAX_TASK_TOKEN_BUDGET`); `BudgetExceededError` | yes |
| `admission-gate.ts` | `buildAdmissionGate` / `buildWorkerAdmissionGate`: the governance Action Gate as the actor's pre-execution check (ADR-021) | no (root `kaiban-distributed` entry) |
| `structured-logger.ts` | JSON logger (pino) for workers and infrastructure; `LOG_LEVEL`, `LOG_PRETTY=true` | no |
| `process-drain.ts` | One drain per worker process: the first SIGTERM or SIGINT drains every agent node, flushes telemetry, then exits once | no (internal) |
| `redis-connection.ts` | the helper behind every Redis client (URL with user, password, database and `rediss://`; `REDIS_TLS_*`) | no (internal) |
| `timeout-env.ts` | parses the timeout environment variables | no (internal) |
