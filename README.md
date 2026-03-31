# Kaiban Distributed - Multi-Agent AI System

#### Implementation of Distributed Actor Model for AI swarms using TypeScript, Redis/Kafka, OpenTelemetry.


> Distributed horizontally-scalable Actor-Model Multi-Agent System Runtime, using Kanban style visualization for workflows.
>
> Run multiple AI agents teams with independently deployed Node.js processes, real-time visibility and multi-agent orchestration via Redis/Kafka pub/sub, A2A, and MCP.
>
> For running the examples see [EXAMPLES.md](EXAMPLES.md). For technical documentation, check the files in [docs/](docs/).
>
> *(System based on [KaibanJS](https://kaibanjs.com). For integrating KaibanJS, follow documents in [docs/KAIBANJS_INTEGRATION.md](docs/KAIBANJS_INTEGRATION.md)).*
>

- The very first project in the world to combine Enterprise Messaging (Kafka/Redis), Actor-Model Isolation, AI Multi-Agent Orchestration, and Kanban Visualization, into a JavaScript ecosystem, for agents and humans.

- While most frameworks treat agents as scripts, Kaiban Distributed treats them as Stateful Actors. By using async Node.js, each agent operates in its own space, communicating via a pluggable Messaging Abstraction Layer (Kafka or BullMQ/Redis), horizontally scaling AI workforce.

- The systems allows creation of Teams of Agents for various Tasks, Systems Integrations, and Data handling/analytics, with scalable AI workflows, from local usage to customizable Enterprise Grade Systems.

- Integrates with existing KaibanJS agents, external agentic systems, or any service that can publish via A2A / MCP / Redis / Kafka — connecting them into actor-model team flows or peer-to-peer coordination.


[![Tests](https://img.shields.io/badge/tests-442%20passing-brightgreen)](#testing)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](#testing)
[![Security](https://img.shields.io/badge/security-audit%20complete-brightgreen)](#security--compliance)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](tsconfig.json)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green)](package.json)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

---

## Summary

```bash
# 1. Clone and install
git clone https://github.com/andreibesleaga/kaiban-distributed
cd kaiban-distributed && npm install

# 2. Configure
cp .env.example .env
# Edit .env — add OPENROUTER_API_KEY or OPENAI_API_KEY + AGENT_IDS

# 3. Start the full blog-team demo (Docker Compose, workers, gateway, orchestrator, monitor)
./scripts/blog-team.sh start

# or the Global Research Distributed Team
./scripts/global-research.sh start
# use flags for chaos (20% searcher crash rate) and number of parallel instances
# ./scripts/blog-team.sh start --chaos --searchers 6

# → Script prints board URLs when the gateway is ready. Open one in a separate terminal/tab.

# 4. Open the board (choose one, in a separate terminal)
cd board && npm install && npm run dev   # React board → http://localhost:5173
#  — OR —
# Open examples/blog-team/viewer/board.html in your browser (zero setup)

# 5. Stop everything cleanly when done
./scripts/blog-team.sh stop
# ./scripts/global-research.sh stop
```

To wire your own agent into a distributed worker node:

```typescript
import { BullMQDriver } from './src/infrastructure/messaging/bullmq-driver';
import { AgentActor } from './src/application/actor/AgentActor';
import { createKaibanTaskHandler } from './src/infrastructure/kaibanjs/kaiban-agent-bridge';
import { AgentStatePublisher } from './src/adapters/state/agent-state-publisher';

const driver = new BullMQDriver({ connection: { host: 'localhost', port: 6379 } });

const statePublisher = new AgentStatePublisher('redis://localhost:6379', {
  agentId: 'my-agent', name: 'Ada', role: 'Analyst',
});

const handler = statePublisher.wrapHandler(
  createKaibanTaskHandler({
    name: 'Ada', role: 'Analyst',
    goal: 'Analyse datasets and produce structured summaries',
    background: 'Expert in data analysis and statistics',
    llmConfig: { provider: 'openai', model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY },
  }, driver)
);

const actor = new AgentActor('my-agent', driver, 'kaiban-agents-my-agent', handler);
await actor.start();
statePublisher.publishIdle();  // board shows agent as IDLE within 15s
```

---

## Running example - blog-team
(Blog team of: researcher, writer, editor - nodes distributed locally over docker services with Redis/Kafka messaging between them and their processes tasks status and results)
![(running example gif)](docs/images/blogTeam.gif)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Board Viewers (browser)                                             │
│  A. board/  — React + Vite app  (npm run dev → :5173)                │
│     Interactive HITL: Approve / Revise / Reject buttons              │
│     socket.emit('hitl:decision') ───────────────────────────────┐    │
│  B. examples/blog-team/viewer/board.html  (zero-setup)          │    │
│  Socket.io client ──────────────────────────────────────────────┼────┘
└─────────────────────────────────────────────────────────────────│────┘
                                                                  │ ws
┌─────────────────────────────────────────────────────────────────▼────┐
│  Edge Gateway  (port 3000)                                           │
│  GatewayApp:   GET /health · GET /.well-known/agent-card.json        │
│                POST /a2a/rpc  (JSON-RPC 2.0 → routes to queue)       │
│  SocketGateway: subscribes Redis kaiban-state-events → Socket.io     │
│                 listens 'hitl:decision' → publishes kaiban-hitl-     │
│                 decisions (Redis) → orchestrator picks up decision   │
└──────────────────────────────────────────────────────────────────────┘
         │ BullMQ / Kafka task queues        │ Redis Pub/Sub
         │ kaiban-agents-{agentId}           │ kaiban-state-events
┌────────▼──────────┐  ┌────────▼────────┐  ┌────────▼───────────────┐
│ Worker: researcher│  │ Worker: writer  │  │ Worker: editor         │
│  AgentActor       │  │  AgentActor     │  │  AgentActor            │
│  KaibanAgentBridge│  │  KaibanBridge   │  │  KaibanBridge          │
│  → Agent.workOn() │  │  → Agent.work() │  │  → Agent.work()        │
│  AgentState       │  │  AgentState     │  │  AgentState            │
│  Publisher        │  │  Publisher      │  │  Publisher             │
│  (ioredis pub/sub)│  │  (ioredis)      │  │  (ioredis)             │
└───────────────────┘  └─────────────────┘  └────────────────────────┘
         │                      │                        │
         └──────────────────────┴────────────────────────┘
                                │
                    ┌───────────▼────────────┐
                    │  Redis 7 (always)      │
                    │  BullMQ queues +       │
                    │  kaiban-state-events   │
                    └────────────────────────┘

  Optional: Kafka (MESSAGING_DRIVER=kafka)
┌─────────────────────────────────────────────────────────────────────┐
│  Zookeeper + Kafka — high-throughput alternative to BullMQ          │
│  KafkaDriver implements IMessagingDriver (swap via env var)         │
│  State broadcast still uses Redis Pub/Sub (SocketGateway)           │
└─────────────────────────────────────────────────────────────────────┘
```


### High-Level Distributed Topology Example

```mermaid
graph TD
    UI[Kanban Board UI<br>Browser] -- WebSockets --> Gateway[Edge Gateway APP<br>Port 3000]
    Gateway -- Pub/Sub (Socket.io) --> RedisPubSub[(Redis Pub/Sub<br>State Stream)]
    Gateway -- HTTP POST --> A2A[A2A Connector]
    
    A2A --> Queue[(Message Queue<br>BullMQ / Kafka)]
    
    Queue --> |Tasks| AgentA[Node 1: Researcher Actor]
    Queue --> |Tasks| AgentB[Node 2: Writer Actor]
    Queue --> |Tasks| AgentC[Node 3: Editor Actor]
    
    AgentA -- State Updates --> RedisPubSub
    AgentB -- State Updates --> RedisPubSub
    AgentC -- State Updates --> RedisPubSub
    
    AgentA <--> LLM[LLM APIs<br>OpenAI/Anthropic]
    AgentB <--> MCP[MCP Servers<br>Search/Database]
```

### Complete Architectural Schema (Digitalized from Sketch)

```mermaid
flowchart TD
    classDef plain fill:none,stroke:none,color:inherit,font-style:italic;
    classDef solidBox fill:none,stroke:#333,stroke-width:2px;

    %% Row 1
    subgraph TopLevel [" "]
        direction LR
        TL["DISTRIBUTED AGENTIC"]:::plain
        Kanban["VISUALIZE TASKS, STREAMS:<br/> KANBAN STYLE BOARD<br/>(TODO, DOING, DONE, BLOCKED, AWAITING_VALIDATION)"]:::solidBox
        TR["WRAPPER ON KAIBANJS + OTHERS(DIFY, MCP, ETC.)<br/>ACTOR MODEL, ENTERPRISE GRADE MESSAGING + QUEUEING"]:::plain
        TL ~~~ Kanban ~~~ TR
    end
    style TopLevel fill:none,stroke:none;

    %% Row 2
    subgraph MidLevel [" "]
        direction LR
        MsgLayer["MESSAGE LAYER<br/>ASYNC. STREAMING MSG. / REALTIME (KAFKA, REDIS, ETC)"]:::solidBox
        MAL["MAL + DRIVERS / INTERFACES<br/>(MESSAGING AGENT LAYER)"]:::plain
        MsgLayer ~~~ MAL
    end
    style MidLevel fill:none,stroke:none;

    Kanban <--> MsgLayer

    %% Row 3
    subgraph AgentLevel [" "]
        direction LR
        ActorModelText["DISTRIBUTED INFRA: AI NODE AGENTS<br/>EACH AGENT ACTOR MODEL<br/>EDGE, IOT, LOCAL, KUBERNETES, ETC."]:::plain
        N1(("AGENT NODE<br/>optional V. SCALING"))
        N2(("AGENT<br/>NODE"))
        N3(("AGENT<br/>NODE"))
        N4(("AGENT NODE"))
        DistInfraText["TEAM WORKFLOW: RUNNING → FINISHED / STOPPED"]:::plain

        ActorModelText ~~~ N1
        N1 -- "optional H. SCALING" --- N2
        N2 ~~~ N3
        N3 -- "optional H. SCALING" --- N4
        N4 ~~~ DistInfraText
    end
    style AgentLevel fill:none,stroke:none;

    MsgLayer <--> N1
    MsgLayer <--> N2
    MsgLayer <--> N3
    MsgLayer <--> N4

    %% Row 4
    subgraph BottomLevel [" "]
        direction LR
        OtherSystemsText["OTHER SYSTEMS COMPONENTS<br/>INTERACTING VIA A2A, MCP, MESSAGING"]:::plain
        Dify["WORKFLOWS: ◯ ➞ ◻️ ➞ ◇ ➞ ◻️ [RES/OK]<br/>GRAPHIC AI PROGRAMMING"]:::solidBox
        OtherSystemsBox["OTHER SYSTEMS: CONNECTORS TO M.A.L<br/>CUSTOMIZED TO ORG/PROJECT"]:::solidBox

        OtherSystemsText ~~~ Dify ~~~ OtherSystemsBox
    end
    style BottomLevel fill:none,stroke:none;

    N1 -. "I/O - A2A" .-> Dify
    N2 -. "MCP I/O" .-> Dify
    N4 -->|"I/O: A2A, MCP MESSAGING"| OtherSystemsBox
```

### Task State Machine (The Worker Lifecycle)

```mermaid
stateDiagram-v2
    [*] --> TODO : task.create
    note right of TODO
        API response: status='QUEUED'
    end note
    TODO --> DOING : Worker Claims Task

    DOING --> DONE : Inference Success
    DOING --> TODO : Retry (max 3×, exp. backoff)
    DOING --> BLOCKED : Max Retries Exceeded (→ kaiban-events-failed)

    DOING --> AWAITING_VALIDATION : HITL Required
    AWAITING_VALIDATION --> DOING : Human Approved

    DONE --> [*]
    BLOCKED --> [*]
```

---


### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `AgentActor` | `src/application/actor/` | Actor: subscribes to queue, processes tasks with retry (3×) + DLQ, optional firewall + circuit breaker; outbound message data capped at 64 KB |
| `KaibanAgentBridge` | `src/infrastructure/kaibanjs/` | Wraps KaibanJS agent in a per-task `Team`; calls `team.start()`; returns token-tracked `KaibanHandlerResult`; optional JIT token provider |
| `KaibanTeamBridge` | `src/infrastructure/kaibanjs/` | Wraps KaibanJS `Team` with distributed state sync |
| `AgentStatePublisher` | `src/adapters/state/` | Publishes IDLE/EXECUTING/DONE/ERROR to Redis Pub/Sub; 15s heartbeat |
| `BullMQDriver` | `src/infrastructure/messaging/` | Redis-backed job queue (default); optional TLS; no colon queue names |
| `KafkaDriver` | `src/infrastructure/messaging/` | Kafka-backed messaging; optional SSL/mTLS; unique consumer group per worker role |
| `DistributedStateMiddleware` | `src/adapters/state/` | Intercepts Zustand store `setState()` and publishes deltas to messaging layer |
| `GatewayApp` | `src/adapters/gateway/` | Express HTTP: `/health`, `/.well-known/agent-card.json`, `/a2a/rpc` |
| `SocketGateway` | `src/adapters/gateway/` | Socket.io server + Redis pub/sub subscriber; broadcasts `state:update` to board |
| `A2AConnector` | `src/infrastructure/federation/` | JSON-RPC 2.0; `tasks.create` publishes to messaging layer |
| `MCPFederationClient` | `src/infrastructure/federation/` | Connects to any MCP tool server via stdio transport |
| `HeuristicFirewall` | `src/infrastructure/security/` | Regex-based prompt injection detection (ASI01); opt-in via `SEMANTIC_FIREWALL_ENABLED` |
| `EnvTokenProvider` | `src/infrastructure/security/` | JIT token abstraction (ASI03); reads API keys from env vars; opt-in via `JIT_TOKENS_ENABLED` |
| `SlidingWindowBreaker` | `src/infrastructure/security/` | Sliding-window circuit breaker (ASI10); opt-in via `CIRCUIT_BREAKER_ENABLED` |
| `OrchestratorStatePublisher` | `examples/blog-team/orchestrator.ts` | Owns workflow lifecycle (RUNNING→FINISHED/STOPPED/AWAITING) |
| `CompletionRouter` | `examples/blog-team/orchestrator.ts` | Single BullMQ/Kafka subscriber dispatching completion events by `taskId` |

---

## Prerequisites

- **Node.js** ≥ 22
- **Docker** + **Docker Compose** (for Redis, Kafka, and multi-node demo)
- **LLM API key** — OpenAI (`OPENAI_API_KEY`), OpenRouter (`OPENROUTER_API_KEY`), other compatible APIs

---

## Quick Start

### 1. Install

```bash
git clone https://github.com/andreibesleaga/kaiban-distributed
cd kaiban-distributed
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` — choose your LLM provider:

```bash
# Standard OpenAI
OPENAI_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini

# OpenRouter (https://openrouter.ai/keys)
OPENROUTER_API_KEY=sk-or-v1-...
LLM_MODEL=meta-llama/llama-3.1-8b-instruct:free   # free tier

# Required — which agents this node serves
AGENT_IDS=researcher,writer,editor
```

### 3. Start infrastructure

```bash
docker compose up -d redis
```

### 4. Build and run gateway

```bash
npm run build
AGENT_IDS=gateway PORT=3000 node dist/src/main/index.js
```

### 5. Verify

```bash
curl http://localhost:3000/health
# → {"data":{"status":"ok","timestamp":"..."}}

curl http://localhost:3000/.well-known/agent-card.json
# → {"name":"kaiban-worker","version":"1.0.0","capabilities":[...]}
```

---

## React Board (`board/`)

The `board/` subdirectory is a **standalone React + Vite + TypeScript** dashboard that visualises distributed agent activity in real time via **Socket.io**.

| Feature | Detail |
|---|---|
| **Tech stack** | React 18 · Vite · TypeScript · Tailwind CSS · Zustand · Socket.io client |
| **Gateway URL** | `http://localhost:3000` (override with `?gateway=<url>` query param or `VITE_GATEWAY_URL`) |
| **State source** | `SocketGateway` backend subscribes to Redis `kaiban-state-events` and fans out `state:update` events to all connected boards |
| **Agent Grid** | Live status badges per agent — IDLE / THINKING / EXECUTING (pulse) / ERROR |
| **Kanban Board** | 5-column task view: TODO · DOING · REVIEW · DONE · BLOCKED |
| **HITL controls** | Approve / Revise / Reject buttons when a task is `AWAITING_VALIDATION`; emits `hitl:decision` back through the socket |
| **Economics panel** | Aggregate token count, cost, and duration; reverse-chronological event log (capped at 200 entries) |

**Start the board (dev):**

```bash
cd board
cp .env.example .env      # optional: set VITE_GATEWAY_URL
npm install
npm run dev               # → http://localhost:5173
```

**Production build** outputs static files to `board/dist/` — deploy anywhere (nginx, CDN, etc.).

![(React Board running example)](docs/images/ReactBoard2.png)

---

## Individual Node Pattern

Mirrors the [kaibanjs-node-demo](https://github.com/kaibanjs/kaibanjs-node-demo) pattern — each agent runs as an independent process:

```typescript
// my-agent-node.ts
import 'dotenv/config';
import { BullMQDriver } from './src/infrastructure/messaging/bullmq-driver';
import { AgentActor } from './src/application/actor/AgentActor';
import { createKaibanTaskHandler } from './src/infrastructure/kaibanjs/kaiban-agent-bridge';
import { AgentStatePublisher } from './src/adapters/state/agent-state-publisher';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const redisUrl = new URL(REDIS_URL);

const driver = new BullMQDriver({
  connection: { host: redisUrl.hostname, port: parseInt(redisUrl.port || '6379', 10) },
});

const statePublisher = new AgentStatePublisher(REDIS_URL, {
  agentId: 'researcher', name: 'Ava', role: 'News Researcher',
});

const handler = statePublisher.wrapHandler(
  createKaibanTaskHandler({
    name: 'Ava',
    role: 'News Researcher',
    goal: 'Find and summarize the latest news on a given topic',
    background: 'Expert data analyst with deep research experience',
    llmConfig: {
      provider: 'openai',
      model: process.env['LLM_MODEL'] ?? 'gpt-4o-mini',
      apiKey: process.env['OPENAI_API_KEY'],
    },
  }, driver)
);

const actor = new AgentActor('researcher', driver, 'kaiban-agents-researcher', handler);
await actor.start();
statePublisher.publishIdle();  // board shows Ava as IDLE within 15s
console.log('[Researcher] Ava started');

process.on('SIGTERM', async () => {
  await actor.stop();
  await driver.disconnect();
  await statePublisher.disconnect();
});
```

```bash
# Terminal 1 — researcher
OPENAI_API_KEY=sk-... node dist/examples/blog-team/researcher-node.js

# Terminal 2 — writer
OPENAI_API_KEY=sk-... node dist/examples/blog-team/writer-node.js

# Terminal 3 — send a task via A2A
curl -X POST http://localhost:3000/a2a/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tasks.create","params":{"agentId":"researcher","instruction":"Research the latest AI agent frameworks in 2025","expectedOutput":"A concise summary"}}'
```

---

## Integrating with kaiban-board

[kaiban-board](https://github.com/kaibanjs/kaiban-board) is a React component that visualises KaibanJS team execution as a live Kanban board.

### How state flows to the board

```
Worker nodes (each):
  AgentStatePublisher.publishIdle()     → Redis PUBLISH kaiban-state-events { agents: [IDLE] }
  AgentStatePublisher.wrapHandler()     → EXECUTING → DONE/ERROR → Redis PUBLISH
  15-second heartbeat                   → re-publishes current agent status
  (heartbeat NEVER sets teamWorkflowStatus — only the orchestrator does)

Orchestrator:
  workflowStarted()     → { teamWorkflowStatus: 'RUNNING', agents: all IDLE }
  awaitingHITL(...)     → { tasks: [AWAITING_VALIDATION] }
  workflowFinished(...) → { teamWorkflowStatus: 'FINISHED', all tasks: DONE }
  workflowStopped(...)  → { teamWorkflowStatus: 'STOPPED', tasks: BLOCKED }

SocketGateway:
  subscribes Redis kaiban-state-events → emits Socket.io 'state:update' to board
```

### Board state lifecycle

`teamWorkflowStatus` values (set by the orchestrator only):

| `teamWorkflowStatus` | Board banner | Badge |
|---|---|---|
| `RUNNING` | none | 🔵 blue |
| `FINISHED` | ✅ **WORKFLOW COMPLETE** (green glow) | 🟢 green |
| `STOPPED` | ⏹ **WORKFLOW ENDED** (grey) | ⚫ grey |

> The ⏸ **HUMAN DECISION REQUIRED** (orange pulse) banner is shown when any task has status `AWAITING_VALIDATION` — this is triggered by task state, not by `teamWorkflowStatus`.

Task card states:
- `TODO` — 📋 pending (initial state)
- `DOING` — 🔵 blue left border + pulse dot
- `DONE` — 🟢 green
- `AWAITING_VALIDATION` — 🟠 orange pulsing glow + `⏸ HUMAN DECISION` badge + HITL banner
- `BLOCKED` — 🔴 red glow + `⛔ ERROR` badge + red error banner with message

### Option A: Static HTML viewer (zero setup)

Open [`examples/blog-team/viewer/board.html`](examples/blog-team/viewer/board.html) directly in a browser.
Auto-connects to `http://localhost:3000`. All three agents (Ava, Kai, Morgan) appear as IDLE within 15 seconds.

Event stream shows typed, colour-coded entries:
- `WORKFLOW` badge — workflow status transitions
- `AGENT` badge — IDLE → EXECUTING → IDLE per agent
- `TASK` badge — task status with result preview

### Option B: Custom Socket.io client

```javascript
import { io } from 'socket.io-client';
const socket = io('http://localhost:3000');
const agentMap = new Map();
const taskMap  = new Map();

socket.on('state:update', (delta) => {
  // IMPORTANT: merge by ID — each worker publishes only its own slice
  if (delta.agents) {
    for (const a of delta.agents)
      agentMap.set(a.agentId, { ...agentMap.get(a.agentId), ...a });
  }
  if (delta.tasks) {
    for (const t of delta.tasks)
      taskMap.set(t.taskId, { ...taskMap.get(t.taskId), ...t });
  }
});
```

### Option C: React board app (modern UI, interactive HITL)

The `board/` directory is a standalone React + Vite + TypeScript app that connects
to the same Socket.io gateway and adds interactive Human-in-the-Loop controls:

```bash
cd board
cp .env.example .env        # optional: set VITE_GATEWAY_URL
npm install
npm run dev                  # → http://localhost:5173
```

Or pass the gateway URL at runtime without rebuilding:

```
http://localhost:5173?gateway=http://my-gateway.example.com:3000
```

**Gateway URL resolution** (priority order):
1. `?gateway=<url>` query param (runtime, no rebuild needed)
2. `VITE_GATEWAY_URL` build-time env var (`.env` file)
3. `http://localhost:3000` fallback

**Layout** (top → bottom):
- **Header** — logo, topic, gateway URL chip, workflow status pill, connection badge
- **WorkflowBanner** — conditional banner: HITL Approve/Revise/Reject buttons (when any task is `AWAITING_VALIDATION`), FINISHED, STOPPED, or ERRORED states
- **AgentGrid** — responsive 2–4 column grid with live status badges (IDLE / THINKING / EXECUTING + pulse / ERROR)
- **KanbanBoard** — 5-column board: TODO · DOING · REVIEW · DONE · BLOCKED
- **EconomicsPanel + EventLog** — tokens, cost, duration; reverse-chronological event stream (capped at 200)

**HITL decision flow:**

```
Board clicks [Approve]
  → socket.emit('hitl:decision', { taskId, decision: 'PUBLISH' })
  → SocketGateway: publishes to Redis kaiban-hitl-decisions
  → Orchestrator's waitForHITLDecision() races Redis vs terminal input
  → First to respond wins → workflow continues
```

Both the board and the terminal prompt remain functional simultaneously — first response wins.

**Production build:**

```bash
cd board && npm run build    # → board/dist/ (static files, serve anywhere)
```

### Option D: KaibanTeamBridge (local Team + distributed workers)

```typescript
import { Agent, Task } from 'kaibanjs';
import { BullMQDriver } from './src/infrastructure/messaging/bullmq-driver';
import { KaibanTeamBridge } from './src/infrastructure/kaibanjs/kaiban-team-bridge';

const ava = new Agent({ name: 'Ava', role: 'Researcher', goal: '...', background: '...' });
const kai = new Agent({ name: 'Kai', role: 'Writer',     goal: '...', background: '...' });

const driver = new BullMQDriver({ connection: { host: 'localhost', port: 6379 } });

const bridge = new KaibanTeamBridge({
  name: 'Blog Team',
  agents: [ava, kai],
  tasks: [
    new Task({ description: 'Research {topic}', expectedOutput: 'Summary', agent: ava }),
    new Task({ description: 'Write blog',       expectedOutput: 'Blog post', agent: kai }),
  ],
}, driver);

const result = await bridge.start({ topic: 'AI agents 2025' });
// State propagates: Redis Pub/Sub → SocketGateway → Socket.io → board
```

---

## A2A Protocol (Agent-to-Agent)

The Edge Gateway implements the [A2A protocol](https://google-deepmind.github.io/a2a/) for interoperability with other AI systems.

### Agent Card

```bash
curl http://localhost:3000/.well-known/agent-card.json
```

```json
{
  "name": "kaiban-worker",
  "version": "1.0.0",
  "description": "Kaiban distributed agent worker node",
  "capabilities": ["tasks.create", "tasks.get", "agent.status"],
  "endpoints": { "rpc": "/a2a/rpc" }
}
```

### RPC Methods

| Method | Params | Returns |
|--------|--------|---------|
| `tasks.create` | `{ agentId, instruction, expectedOutput, inputs?, context? }` | `{ taskId, status: 'QUEUED', agentId }` |
| `tasks.get` | `{ taskId }` | `{ taskId, status }` |
| `agent.status` | — | `{ status: 'IDLE', agentId }` |

```bash
curl -X POST http://localhost:3000/a2a/rpc \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0", "id": 1,
    "method": "tasks.create",
    "params": {
      "agentId": "researcher",
      "instruction": "Research quantum computing breakthroughs in 2025",
      "expectedOutput": "A 300-word technical summary",
      "inputs": { "topic": "quantum computing" }
    }
  }'
```

---

## MCP Integration

Attach any [Model Context Protocol](https://modelcontextprotocol.io) tool server to your agents:

```typescript
import { MCPFederationClient } from './src/infrastructure/federation/mcp-client';

const mcp = new MCPFederationClient('npx', ['-y', '@modelcontextprotocol/server-brave-search']);
await mcp.connect();
const tools = await mcp.listTools();
const result = await mcp.callTool('brave_web_search', { query: 'AI agents 2025' });
await mcp.disconnect();
```

MCP servers for Redis and Kafka enable AI agents to intercept and query live data streams:

| Server | Purpose |
|--------|---------|
| [`mcp-redis`](https://github.com/redis/mcp-redis) | Query `kaiban-state-events` pub/sub, streams (`XREAD`), vector search |
| Confluent MCP | Flink SQL queries over live Kafka topics (Confluent Cloud) |
| [`tuannvm/kafka-mcp-server`](https://github.com/tuannvm/kafka-mcp-server) | Consume Kafka messages at specific offsets (self-hosted) |

```json
// claude_desktop_config.json
{
  "redis": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-redis", "--url", "redis://localhost:6379"]
  }
}
```

---

## Messaging Drivers

### BullMQ (Default — Redis)

Best for: development, small-to-medium scale, reliable delivery, job history.

```bash
MESSAGING_DRIVER=bullmq
REDIS_URL=redis://localhost:6379
```

> **Important:** BullMQ v5 rejects queue names containing colons. All internal channels use dashes:
> `kaiban-agents-researcher`, `kaiban-events-completed`, `kaiban-events-failed`, `kaiban-state-events`

### Kafka (High-Throughput)

Best for: large scale, event streaming, message replay, multi-datacenter.

```bash
MESSAGING_DRIVER=kafka
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=kaiban-worker
KAFKA_GROUP_ID=kaiban-group
```

**Kafka consumer group isolation** — unique group suffix per component:

| Component | Consumer Group |
|-----------|---------------|
| researcher worker | `kaiban-group-researcher` |
| writer worker | `kaiban-group-writer` |
| editor worker | `kaiban-group-editor` |
| orchestrator (completed events) | `kaiban-group-orchestrator-completed` |
| orchestrator (failed/DLQ events) | `kaiban-group-orchestrator-failed` |

> Task queues use Kafka topics. State broadcast (`kaiban-state-events`) always uses Redis Pub/Sub — `SocketGateway` reads directly from Redis regardless of `MESSAGING_DRIVER`.

### Driver factory (for custom node code)

```typescript
// examples/blog-team/driver-factory.ts
import { createDriver, getDriverType } from './driver-factory';
const driver = createDriver('researcher');   // BullMQ or Kafka based on MESSAGING_DRIVER env
```

### Switching at runtime

Set `MESSAGING_DRIVER=kafka` (or `bullmq`) — the `IMessagingDriver` interface is the abstraction. Worker code is identical for both drivers.

---

## API Reference

### HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | `{ data: { status: 'ok', timestamp } }` |
| `GET` | `/.well-known/agent-card.json` | A2A agent capabilities |
| `POST` | `/a2a/rpc` | JSON-RPC 2.0: `tasks.create`, `tasks.get`, `agent.status` |

All responses: `{ data, meta, errors }` envelope.

### Socket.io Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `state:update` | server → client | `StateDelta` (PII-sanitized) |
| `hitl:decision` | client → server | `{ taskId: string, decision: 'PUBLISH' \| 'REVISE' \| 'REJECT' }` |

### Internal Channel Names

| Channel | Driver | Purpose |
|---------|--------|---------|
| `kaiban-agents-{agentId}` | BullMQ / Kafka | Task inbox per agent |
| `kaiban-events-completed` | BullMQ / Kafka | Successful task results |
| `kaiban-events-failed` | BullMQ / Kafka | DLQ after 3 retry failures |
| `kaiban-state-events` | Redis Pub/Sub | Agent/workflow state → board |
| `kaiban-hitl-decisions` | Redis Pub/Sub | Board HITL decisions → orchestrator |

---

## Configuration Reference

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `AGENT_IDS` | — | **Yes** | Comma-separated agent IDs this node serves |
| `REDIS_URL` | `redis://localhost:6379` | No | Redis connection URL |
| `MESSAGING_DRIVER` | `bullmq` | No | `bullmq` or `kafka` |
| `KAFKA_BROKERS` | `localhost:9092` | Kafka only | Comma-separated broker addresses |
| `KAFKA_CLIENT_ID` | `kaiban-worker` | No | Kafka client identifier |
| `KAFKA_GROUP_ID` | `kaiban-group` | No | Kafka consumer group base ID |
| `PORT` | `3000` | No | HTTP + WebSocket port |
| `SERVICE_NAME` | `kaiban-worker` | No | Name in telemetry and agent card |
| `OPENAI_API_KEY` | — | For agents | Standard OpenAI API key |
| `OPENROUTER_API_KEY` | — | For agents | OpenRouter key (auto-configures base URL) |
| `OPENAI_BASE_URL` | — | Optional | Custom OpenAI-compatible endpoint |
| `LLM_MODEL` | `gpt-4o-mini` | No | Model (for OpenRouter: `meta-llama/llama-3.1-8b-instruct:free`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | No | OpenTelemetry OTLP endpoint (else console) |

#### Board app (`board/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_GATEWAY_URL` | `http://localhost:3000` | Gateway WebSocket URL (build-time; overridable via `?gateway=` query param at runtime) |

#### Security (all opt-in, disabled by default)

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_TLS_CA` / `REDIS_TLS_CERT` / `REDIS_TLS_KEY` | — | Paths to Redis mTLS certificates |
| `KAFKA_SSL_CA` / `KAFKA_SSL_CERT` / `KAFKA_SSL_KEY` | — | Paths to Kafka mTLS certificates |
| `TLS_REJECT_UNAUTHORIZED` | `true` | Set `false` for self-signed certs in staging |
| `SEMANTIC_FIREWALL_ENABLED` | `false` | Enable heuristic prompt injection firewall |
| `SEMANTIC_FIREWALL_LLM_URL` | — | Optional local LLM endpoint for deep analysis |
| `JIT_TOKENS_ENABLED` | `false` | Enable JIT token provider for LLM API keys |
| `CIRCUIT_BREAKER_ENABLED` | `false` | Enable sliding-window circuit breaker |
| `CIRCUIT_BREAKER_THRESHOLD` | `10` | Failures before breaker trips |
| `CIRCUIT_BREAKER_WINDOW_MS` | `60000` | Sliding window duration (ms) |

---

## Security & Compliance

Security audits have been performed against the **OWASP Top 10 for Agentic AI (2026)** and **OWASP Top 10 for LLM Applications (2025)**.

For a complete reference of every security feature, configuration option, and deployment checklist see **[SECURITY_FEATURES.md](docs/security/SECURITY_FEATURES.md)**.

### Security Features

| Feature | Component | OWASP | Activation |
|---------|-----------|-------|------------|
| **Board Viewer JWT** | `board-auth.ts` + `SocketGateway` | CRIT-01 | `BOARD_JWT_SECRET` |
| **A2A Bearer Token Auth** | `a2a-auth.ts` + `GatewayApp` | CRIT-02 | `A2A_JWT_SECRET` |
| **Redis Channel Signing** | `channel-signing.ts` | HIGH-01 | `CHANNEL_SIGNING_SECRET` |
| **CORS Allowlist** | `SocketGateway` | HIGH-03 | `SOCKET_CORS_ORIGINS` (required in production) |
| **Token Expiry Enforcement** | `SocketGateway` | LOW-01 | automatic when `BOARD_JWT_SECRET` set |
| **Semantic Firewall** | `HeuristicFirewall` | ASI01 | `SEMANTIC_FIREWALL_ENABLED=true` |
| **mTLS** | `KafkaDriver` / `BullMQDriver` | ASI07 | `REDIS_TLS_*` / `KAFKA_SSL_*` |
| **JIT Token Provider** | `EnvTokenProvider` | ASI03 | `JIT_TOKENS_ENABLED=true` |
| **Circuit Breaker** | `SlidingWindowBreaker` | ASI10 | `CIRCUIT_BREAKER_ENABLED=true` |
| **W3C Traceparent Validation** | `BullMQDriver` | MED-06 | always-on |
| **HTTP Hardening** | `GatewayApp` (Helmet, rate limit, CSP, HSTS) | MED-04/05 | always-on |
| **WebSocket Hardening** | `SocketGateway` (buffer limit, ping, HITL validation) | — | always-on |
| **agentId Input Validation** | `A2AConnector` | HIGH-04 | always-on |

Authentication and signing features are **env-var gated**: when the relevant secret is not set, the system behaves exactly as before (backwards-compatible). When set, full enforcement is active.

### Compliance Controls

| Control | Implementation |
|---------|----------------|
| **GDPR — PII in logs** | Agent IDs SHA-256 hashed (8-char prefix) via `sanitizeId()` |
| **GDPR — State deltas** | `sanitizeDelta()` strips: `email`, `name`, `phone`, `ip`, `password`, `token`, `secret`, `ssn`, `dob` |
| **GDPR — Data minimisation** | `result` capped at 800 chars in state events; outbound data capped at 64 KB in `AgentActor` |
| **SOC2 — Non-root container** | Dockerfile: `USER kaiban` |
| **SOC2 — Secrets** | All secrets via env vars; `.env` gitignored; `.env.example` has no real values |
| **ISO 27001 — Encryption** | mTLS for Redis/Kafka; HTTPS for LLM APIs; `scripts/generate-dev-certs.sh` for staging |
| **Observability** | OpenTelemetry; W3C `traceparent` across BullMQ/Kafka hops; `recordAnomalyEvent()` OTLP spans |
| **Known CVE** | `kaibanjs ≥ 0.3.0` — 6 moderate CVEs via `@langchain/community` transitives; unfixable without breaking downgrade |

---

## Development

### Commands

```bash
npm run build          # tsc → dist/src/ and dist/examples/
npm run dev            # node dist/src/main/index.js (build first)
npm run test           # 358 unit tests (no external deps)
npm run test:coverage  # 100% coverage — all metrics
npm run test:e2e       # BullMQ E2E (Docker Redis auto-started)
npm run test:e2e:kafka # Kafka E2E (Docker Kafka + Zookeeper required)
npm run lint           # ESLint + complexity ≤10 — 0 errors target
npm run typecheck      # tsc --noEmit — strict mode
npm run format         # prettier --write
npm run lint:arch      # madge --circular src/ — no circular imports
```

### Testing

| Suite | Command | Count | Infrastructure |
|-------|---------|-------|----------------|
| Unit | `npm test` | 442 tests, 44 files | None (all mocked) |
| BullMQ E2E | `npm run test:e2e` | 15 tests, 4 files | Docker Redis (auto-managed by globalSetup) |
| Kafka E2E | `npm run test:e2e:kafka` | 3 tests, 2 files | Docker Kafka + Zookeeper |

### Coverage

| Metric | Result |
|--------|--------|
| Statements | **100%** |
| Branches | **100%** |
| Functions | **100%** |
| Lines | **100%** |

### Project Structure

```
kaiban-distributed/
├── src/
│   ├── domain/
│   │   ├── entities/          # DistributedTask, DistributedAgentState (with type guards)
│   │   ├── errors/            # DomainError, TaskNotFoundError, MessagingError, ...
│   │   ├── result.ts          # Result<T,E> — ok(), err(), isOk(), isErr()
│   │   └── security/          # Domain interfaces for security components
│   │       ├── semantic-firewall.ts  # ISemanticFirewall — evaluates payloads for injection
│   │       ├── token-provider.ts     # ITokenProvider — JIT token abstraction
│   │       └── circuit-breaker.ts    # ICircuitBreaker — success/failure tracking
│   ├── application/
│   │   └── actor/
│   │       └── AgentActor.ts  # Core: retry×3 + exp backoff, DLQ, firewall, circuit breaker
│   ├── adapters/
│   │   ├── gateway/
│   │   │   ├── GatewayApp.ts       # Express: /health, agent-card, /a2a/rpc, 404
│   │   │   └── SocketGateway.ts    # Socket.io + Redis pub/sub → board
│   │   └── state/
│   │       ├── distributedMiddleware.ts    # Intercepts Zustand setState → messaging
│   │       └── agent-state-publisher.ts   # Direct Redis pub/sub; 15s heartbeat; lifecycle
│   ├── infrastructure/
│   │   ├── messaging/
│   │   │   ├── interfaces.ts       # IMessagingDriver (publish, subscribe, unsubscribe, disconnect)
│   │   │   ├── channels.ts         # Canonical channel names (STATE, COMPLETED, DLQ)
│   │   │   ├── bullmq-driver.ts    # BullMQ Worker + Queue; optional TLS; no colons in queue names
│   │   │   └── kafka-driver.ts     # KafkaJS producer + consumer; optional SSL/mTLS
│   │   ├── federation/
│   │   │   ├── a2a-connector.ts    # JSON-RPC 2.0; tasks.create routes to messaging layer
│   │   │   └── mcp-client.ts       # MCPFederationClient via stdio transport
│   │   ├── kaibanjs/
│   │   │   ├── kaiban-agent-bridge.ts  # createKaibanTaskHandler; JIT tokens; error detection
│   │   │   └── kaiban-team-bridge.ts   # KaibanTeamBridge with DistributedStateMiddleware
│   │   ├── security/              # Security infrastructure implementations
│   │   │   ├── heuristic-firewall.ts    # Regex prompt injection detection (10+ patterns)
│   │   │   ├── env-token-provider.ts    # Env-var backed JIT token provider
│   │   │   └── sliding-window-breaker.ts # Configurable sliding-window circuit breaker
│   │   └── telemetry/
│   │       ├── telemetry.ts        # initTelemetry(); recordAnomalyEvent(); OTLP or console
│   │       └── TraceContext.ts     # injectTraceContext / extractTraceContext (W3C)
│   └── main/
│       ├── index.ts    # Composition root: wires all layers + security deps, starts HTTP + actors
│       └── config.ts   # loadConfig(); TLS config; security feature flags
├── tests/
│   ├── unit/           # 358 unit tests — mirrors src/ structure, 100% coverage
│   └── e2e/
│       ├── distributed-execution.test.ts      # BullMQ: execution, fault tolerance, state sync
│       ├── fan-out-fan-in.test.ts             # Parallel fan-out/fan-in workflow (7 scenarios)
│       ├── horizontal-scaling-bullmq.test.ts  # Competing consumers, exact-once delivery
│       ├── horizontal-scaling-kafka.test.ts   # Kafka consumer groups scaling
│       ├── a2a-protocol.test.ts               # HTTP gateway + A2A
│       ├── kafka-driver.test.ts               # Kafka pub/sub round-trip
│       └── setup/
│           ├── globalSetup.ts             # Docker Redis auto-start; resilient to existing Redis
│           └── kafkaSetup.ts              # Docker Kafka + Zookeeper + Redis auto-start
├── examples/
│   └── global-research/                   # Multi-agent distributed researchers pipeline example
│   └── blog-team/                         # Three-agent editorial pipeline
│       ├── team-config.ts                 # Agent configs (Ava, Kai, Morgan) + LLM factory
│       ├── driver-factory.ts              # createDriver(suffix) — BullMQ or Kafka from env
│       ├── researcher-node.ts             # Ava worker entry point
│       ├── writer-node.ts                 # Kai worker entry point
│       ├── editor-node.ts                 # Morgan worker entry point
│       ├── orchestrator.ts                # Event-driven pipeline + HITL terminal
│       ├── build-security-deps.ts         # Shared security setup (firewall, breaker, tokens)
│       ├── docker-compose.yml             # BullMQ: redis + gateway + 3 workers
│       ├── docker-compose.kafka.yml       # Kafka: zookeeper + kafka + redis + gateway + 3 workers
│       └── viewer/
│           ├── board.html                 # Live Kanban board — open in browser, no build
│           ├── board.js                   # Socket.io client + state rendering logic
│           └── board.css                  # Board styling
├── scripts/
│   ├── blog-team.sh                       # Start/stop orchestration wrapper (all modes)
│   ├── monitor.sh                         # Real-time terminal dashboard (all streams)
│   └── generate-dev-certs.sh              # Self-signed CA + server/client certs for mTLS
├── board/                                 # React + Vite + TypeScript board app (standalone)
│   ├── src/
│   │   ├── main.tsx / App.tsx             # Entry point + root layout
│   │   ├── types/board.ts                 # StateDelta, AgentDelta, TaskDelta, BoardState
│   │   ├── store/boardStore.ts            # Zustand: applyDelta, setConnectionStatus, addLog
│   │   ├── socket/socketClient.ts         # Socket.io singleton + sendHitlDecision()
│   │   └── components/                    # layout/ · workflow/ · agents/ · kanban/ · economics/ · log/
│   ├── package.json                       # React 18, Vite 6, Tailwind, socket.io-client, zustand
│   └── .env.example                       # VITE_GATEWAY_URL=http://localhost:3000
├── docker-compose.yml                     # Full root stack (Redis + Kafka + single worker)
├── Dockerfile                             # Multi-stage: builder (npm ci + tsc) → runner (non-root)
└── .env.example                           # All env vars documented with examples
```

> **Distributed Actor Model documentation**: see [`docs/architecture/ACTOR_MODEL.md`](docs/architecture/ACTOR_MODEL.md) for a full explanation of how actor isolation, mailboxes, message-passing, fault containment, and horizontal scaling are implemented.

### Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| BullMQ as default | Lower ops overhead for dev; Kafka requires Zookeeper |
| No colons in BullMQ queue names | BullMQ v5 rejects colons; all internal names use dashes |
| `IMessagingDriver` abstraction | Swap BullMQ ↔ Kafka via `MESSAGING_DRIVER`; worker code unchanged |
| Workers never set `teamWorkflowStatus` | Only orchestrator owns workflow lifecycle; prevents heartbeats overriding FINISHED |
| `AgentStatePublisher` uses ioredis directly | SocketGateway reads Redis pub/sub; BullMQ queues are separate concerns |
| 15-second heartbeat in `AgentStatePublisher` | Redis pub/sub is fire-and-forget; late-connecting boards see state within 15s |
| Two KafkaDriver instances in `CompletionRouter` | KafkaJS `consumer.run()` cannot subscribe to new topics after start |
| `Team` per task in agent bridge | `Team.start()` initializes LLM automatically from `env`; `WorkflowResult.stats` provides token counts without internal hacks |
| KaibanJS ERRORED status throws | `team.start()` returns `{ status: 'ERRORED' }`; bridge throws so AgentActor retries (3×), then DLQs |
| `forceFinalAnswer: true` on editor | Free 8B models reach max iterations without structured output |
| SHA-256 hash prefix for agent IDs | 8-char prefix preserves debuggability while preventing PII leakage |
| 64 KB cap on published message data | `AgentActor` truncates `result` before publishing to prevent oversized frames from overloading messaging layer |
| `globalSetup` catches Redis port conflict | E2E tests are resilient when Redis is already running from another compose stack |
| `healthcheck: disable: true` on workers | Workers are not HTTP servers; Dockerfile HEALTHCHECK checks port 3000 which is gateway-only |
| React board uses custom Socket.io client, not `kaiban-board` npm package | `kaiban-board@0.4.3` requires a KaibanJS `Team` instance; the distributed board consumes `state:update` events directly |
| Board HITL races readline vs Redis | `waitForHITLDecision()` in orchestrator resolves from whichever arrives first — terminal or board click; both remain usable simultaneously |
| `?gateway=` query param for runtime URL override | Allows the same static build to connect to any gateway without rebuilding |

---

## Managing the Example & Real-Time Monitor

### Unified Start/Stop Script

The easiest way to run the full `blog-team` example is using the orchestration script. It handles Docker Compose, the API Gateway, worker nodes, the orchestrator, and the terminal monitor. When the gateway is ready it prints board URLs — open one in a separate terminal or browser tab.

```bash
# BullMQ/Redis — local orchestrator (default)
./scripts/blog-team.sh start
./scripts/blog-team.sh stop

# Kafka — local orchestrator
./scripts/blog-team.sh start --kafka
./scripts/blog-team.sh stop --kafka

# BullMQ/Redis — fully containerised (orchestrator runs in Docker, HITL via attached terminal)
./scripts/blog-team.sh start --docker
./scripts/blog-team.sh stop --docker

# Kafka — fully containerised (flags are order-independent)
./scripts/blog-team.sh start --kafka --docker
./scripts/blog-team.sh stop --kafka --docker
```

> **`--docker` mode** runs every component — including the orchestrator — as a Docker container. The orchestrator service (`docker compose run --rm orchestrator`) attaches your terminal for interactive HITL decisions [1/2/3/4]. Inside Docker it connects to gateway/Redis/Kafka via service-name hostnames. Without `--docker`, the orchestrator runs locally via `npx ts-node` (requires Node.js + project deps installed).

### Opening a Board UI

The script prints board URLs when the gateway is ready. Open **one or more** in a separate terminal or browser tab — they are all synchronized from the backend stream at all times:

**A) React Board** — interactive HITL Approve / Revise / Reject, modern Kanban UI (requires Node.js):

```bash
# In a separate terminal, from the kaiban-distributed root:
cd board && npm install && npm run dev
# → http://localhost:5173

# Point to a non-default gateway at runtime (no rebuild needed):
# http://localhost:5173?gateway=http://my-gateway:3000
```

**B) Static HTML viewer** — zero setup, open directly in any browser:

```
examples/blog-team/viewer/board.html
# Auto-connects to http://localhost:3000
```

> Multiple boards (React + HTML viewer + additional tabs) can all be open simultaneously and will all reflect the same live state. Each board receives a full state snapshot on connect and every incremental delta in real-time. HITL decisions can be sent from any connected board — the orchestrator accepts the first response.

### Standalone Real-Time Monitor

If you started components manually, you can run the terminal monitor on its own. It automatically detects the `MESSAGING_DRIVER` (BullMQ/Redis or Kafka).

```bash
./scripts/monitor.sh

# With options:
REDIS_URL=redis://localhost:6379 \
COMPOSE_FILE=examples/blog-team/docker-compose.yml \
MESSAGING_DRIVER=bullmq \
LOG_TAIL=200 QUEUE_POLL_SEC=3 \
  ./scripts/monitor.sh
```

| Stream | Description |
|--------|-------------|
| `[workflow]` | Status transitions: RUNNING → FINISHED / STOPPED |
| `[agents]` | IDLE · EXECUTING (green) · THINKING (blue) · ERROR (red) |
| `[tasks]` | DOING · DONE (green) · BLOCKED (red) · AWAITING_VALIDATION (yellow) |
| `[logs]` researcher/writer/editor/gateway | Per-container process logs |
| `[queue]` | BullMQ queue depths polled every 5s |
| `[!ERR]` | All errors across all containers (red highlight) |

### Common Issues

| Error | Cause | Fix |
|-------|-------|-----|
| `401 User not found` | Invalid OpenRouter API key | Get valid key at https://openrouter.ai/keys |
| `404 MODEL_NOT_FOUND` / data policy | Free model requires privacy opt-in | Enable https://openrouter.ai/settings/privacy or use paid model |
| `No endpoints found matching your data policy` | Free tier data-sharing required | Enable https://openrouter.ai/settings/privacy |
| `LLM instance is not initialized` | KaibanJS `llmInstance` not bootstrapped | No longer occurs — `Team` initialises the LLM automatically from the `env` map |
| `Queue name cannot contain :` | Colon in BullMQ queue name | Fixed — all internal queues use dashes |
| `Agent failed: Max retries exceeded` | LLM API error | Check API key and model name |
| `Task incomplete: max iterations` | Small model can't produce structured output | Fixed — `forceFinalAnswer: true` on editor; increase `maxIterations` |
| `network not found` on docker compose up | Stale network from previous compose stack | `docker compose down --remove-orphans && docker network prune --force` |
| Worker shows `unhealthy` | Dockerfile HEALTHCHECK pings port 3000; workers aren't HTTP servers | Fixed — `healthcheck: disable: true` in worker services |
| Kafka: orchestrator timeout on writing/revision | Second `subscribe()` after `consumer.run()` silently dropped | Fixed — TWO KafkaDriver instances with distinct consumer groups |
| `Timeout waiting for research` | Task failed (DLQ) but orchestrator not notified | Fixed — `CompletionRouter` subscribes to both completed AND failed |
| BullMQ E2E: port 6379 already in use | Another compose stack has Redis | Fixed — `globalSetup` catches and skips; or stop other stack first |
| `No OTEL endpoint` warning on startup | `OTEL_EXPORTER_OTLP_ENDPOINT` not set — using verbose ConsoleSpanExporter | Expected in dev; set `OTEL_EXPORTER_OTLP_ENDPOINT` for production |

---

## Project Context

Built with help from [**GABBE Agentic Engineering Kit**](https://github.com/andreibesleaga/GABBE), following the SDD/TDD lifecycle:

| Phase | Deliverable | Status |
|-------|-------------|--------|
| S01 | PRD.md — requirements | ✅ |
| S02 | PLAN.md — C4 architecture diagrams | ✅ |
| S03 | SPEC.md — domain models, API schemas | ✅ |
| S04 | Task decomposition | ✅ |
| S05 | Core implementation (6 modules) | ✅ |
| S06 | Unit test suite — 100% coverage | ✅ |
| S07 | KaibanJS integration, blog-team pipeline, Kafka, README | ✅ |
| S08 | Security remediation — mTLS, semantic firewall, JIT tokens, circuit breakers | ✅ |


---

## License

GPL-3.0 ©2026 [Andrei Besleaga](https://github.com/andreibesleaga)
