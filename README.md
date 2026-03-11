# kaiban-distributed - Multi Agentic Distributed AI System

> Distributed, horizontally-scalable Actor-Model runtime, based on [KaibanJS](https://kaibanjs.com)
>
> Run multiple AI Agents Teams, across multiple deployed Node.js (short-lived and scalable) processes, with real-time task board visibility, and multi agentic orchestrator coordination via Redis/Kafka pub/sub streaming, A2A and MCP accessible.
>
> The system can integrate current kaiban agents, other new agents, or any existing deployed agentic systems and agents (by making them publish messages via A2A, MCP, Redis Kafka), and integrating them in actor model teams flows, or corresponding with each other.
>

[![Tests](https://img.shields.io/badge/tests-123%20passing-brightgreen)](#testing)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](#testing)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](tsconfig.json)
[![License](https://img.shields.io/badge/license-GPL-blue)](LICENSE)

---

## Summary — How to Use in Another Project

```bash
# 1. Clone and install
git clone https://github.com/andreibesleaga/kaiban-distributed
cd kaiban-distributed && npm install

# 2. Configure (copy .env.example, add OPENAI_API_KEY + AGENT_IDS)
cp .env.example .env

# 3. Run the full distributed blog-team demo
cd examples/blog-team
docker compose up

# 4. Submit a task via the A2A protocol
curl -X POST http://localhost:3000/a2a/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tasks.create","params":{"agentId":"researcher","instruction":"Research AI agents","inputs":{"topic":"AI"}}}'

# 5. Connect kaiban-board to http://localhost:3000 (Socket.io) to see the live Kanban
```

To use as a library in your own project:

```typescript
import { createKaibanTaskHandler } from 'kaiban-distributed/src/infrastructure/kaibanjs/kaiban-agent-bridge';
import { KaibanTeamBridge } from 'kaiban-distributed/src/infrastructure/kaibanjs/kaiban-team-bridge';
import { BullMQDriver } from 'kaiban-distributed/src/infrastructure/messaging/bullmq-driver';
import { AgentActor } from 'kaiban-distributed/src/application/actor/AgentActor';
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                    kaiban-board (React/Next.js)                      │
│  Kanban board ← Socket.io client → ws://gateway:3000                 │
└─────────────────────────────────────┬────────────────────────────────┘
                                       │ WebSocket (state:update events)
┌─────────────────────────────────────▼────────────────────────────────┐
│              Edge Gateway  (port 3000)                               │
│  GatewayApp  — /health · /.well-known/agent-card.json · /a2a/rpc     │
│  SocketGateway — Redis Pub/Sub → Socket.io broadcast                 │
│  A2AConnector — JSON-RPC 2.0 · tasks.create routes to BullMQ         │
└────────────┬─────────────────────────────────────────────────────────┘
             │ Redis Pub/Sub (kaiban-state-events)
             │ BullMQ queues (kaiban-agents-{id})
┌────────────▼─────────────────────────────────────────────────────────┐
│                          Redis 7                                     │
│  BullMQ queues · kaiban-state-events pub/sub channel                 │
└──────────┬──────────────────────────────┬────────────────────────────┘
           │                              │
┌──────────▼──────────────┐  ┌───────────▼────────────────────────────┐
│   Worker Node #1        │  │   Worker Node #2  (scale horizontally) │
│  AgentActor[researcher] │  │  AgentActor[writer]                    │
│  KaibanAgentBridge      │  │  KaibanAgentBridge                     │
│  → Agent.workOnTask()   │  │  → Agent.workOnTask()                  │
│  (real LLM execution)   │  │  (real LLM execution)                  │
│  DistributedState       │  │  DistributedState                      │
│  Middleware → pub/sub   │  │  Middleware → pub/sub                  │
└─────────────────────────┘  └────────────────────────────────────────┘

           Optional: Kafka (MESSAGING_DRIVER=kafka)
┌──────────────────────────────────────────────────────────────────────┐
│  Kafka + Zookeeper  — high-throughput alternative to BullMQ          │
│  KafkaDriver implements IMessagingDriver (swap via env var)          │
└──────────────────────────────────────────────────────────────────────┘
```

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `AgentActor` | `src/application/actor/` | Actor that subscribes to a queue, processes tasks with retry + DLQ |
| `KaibanAgentBridge` | `src/infrastructure/kaibanjs/` | Wraps KaibanJS `Agent` in an `AgentActor`-compatible handler |
| `KaibanTeamBridge` | `src/infrastructure/kaibanjs/` | Wraps KaibanJS `Team` with distributed state sync |
| `BullMQDriver` | `src/infrastructure/messaging/` | Redis-backed job queue (default) |
| `KafkaDriver` | `src/infrastructure/messaging/` | Kafka-backed messaging (high-throughput) |
| `DistributedStateMiddleware` | `src/adapters/state/` | Intercepts Zustand store, publishes deltas to Redis |
| `GatewayApp` | `src/adapters/gateway/` | Express HTTP server with A2A + health endpoints |
| `SocketGateway` | `src/adapters/gateway/` | Socket.io + Redis adapter for real-time board |
| `A2AConnector` | `src/infrastructure/federation/` | JSON-RPC 2.0 server + routes `tasks.create` to BullMQ |
| `MCPFederationClient` | `src/infrastructure/federation/` | Connects to MCP tool servers |

---

## Prerequisites

- **Node.js** ≥ 22
- **Docker** + **Docker Compose** (for Redis, Kafka, multi-node demo)
- **OpenAI API key** (or compatible LLM/OpenRouter) for real KaibanJS agent execution

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
# Edit .env:
#   OPENAI_API_KEY=sk-...
#   AGENT_IDS=researcher,writer
#   REDIS_URL=redis://localhost:6379
```

### 3. Start Redis

```bash
docker compose up -d redis
```

### 4. Build and run

```bash
npm run build
AGENT_IDS=researcher,writer node dist/main/index.js
```

### 5. Verify

```bash
curl http://localhost:3000/health
# {"data":{"status":"ok","timestamp":"..."},"meta":{},"errors":[]}

curl http://localhost:3000/.well-known/agent-card.json
# {"name":"kaiban-worker","version":"1.0.0",...}
```

---

## Individual Node Pattern

Mirrors the [kaibanjs-node-demo](https://github.com/kaibanjs/kaibanjs-node-demo) pattern — run each agent as an independent process:

```typescript
// researcher-node.ts
import 'dotenv/config';
import { BullMQDriver } from './src/infrastructure/messaging/bullmq-driver';
import { AgentActor } from './src/application/actor/AgentActor';
import { createKaibanTaskHandler } from './src/infrastructure/kaibanjs/kaiban-agent-bridge';

const driver = new BullMQDriver({
  connection: { host: 'localhost', port: 6379 },
});

// Define your KaibanJS agent config
const handler = createKaibanTaskHandler({
  name: 'Ava',
  role: 'News Researcher',
  goal: 'Find and summarize the latest news on a given topic',
  background: 'Expert data analyst with deep research experience',
  // tools: [new TavilySearchResults({ maxResults: 3 })]  // add tools here
}, driver);

// Wrap in AgentActor (handles retry, DLQ, PII sanitization)
const actor = new AgentActor('researcher', driver, 'kaiban-agents-researcher', handler);
await actor.start();
console.log('Researcher node started — listening for tasks...');
```

```bash
# Terminal 1 — researcher node
OPENAI_API_KEY=sk-... node researcher-node.js

# Terminal 2 — writer node (same pattern with writer config)
OPENAI_API_KEY=sk-... node writer-node.js

# Terminal 3 — send a task via A2A
curl -X POST http://localhost:3000/a2a/rpc \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tasks.create",
    "params": {
      "agentId": "researcher",
      "instruction": "Research the latest AI agent frameworks in 2025",
      "expectedOutput": "A concise summary with key findings",
      "inputs": { "topic": "AI agents 2025" }
    }
  }'
```

See the full example: [`examples/blog-team/`](examples/blog-team/)

---

## Distributed Multi-Node Setup — Three-Agent Blog Pipeline

The [`examples/blog-team/docker-compose.yml`](examples/blog-team/docker-compose.yml) runs a complete multi-node editorial pipeline:

```
Ava (researcher) ──> Kai (writer) ──> Morgan (editor) ──> Human (HITL)
     Node #1              Node #2            Node #3
```

Each agent runs as an independent Docker container subscribed to its own BullMQ queue or Kafka streaming topic. Results flow automatically from one stage to the next via the `kaiban-events-completed` channel.

### Agents

| Agent | Role | Queues | Output |
|-------|------|--------|--------|
| **Ava** | News Researcher | `kaiban-agents-researcher` | Factual research summary with sources |
| **Kai** | Content Creator | `kaiban-agents-writer` | Markdown blog post (500–800 words) |
| **Morgan** | Editorial Fact-Checker | `kaiban-agents-editor` | Structured review + PUBLISH/REVISE/REJECT |

### Run the full pipeline

```bash
# Build the image from repo root
docker compose build

# Start all services: redis + gateway + researcher + writer + editor
cd examples/blog-team
OPENAI_API_KEY=sk-... docker compose up

# In a separate terminal, run the orchestrator
GATEWAY_URL=http://localhost:3000 \
TOPIC="AI Multi-Agent Systems in 2025" \
  npx ts-node examples/blog-team/orchestrator.ts
```

### What the orchestrator does

The [`examples/blog-team/orchestrator.ts`](examples/blog-team/orchestrator.ts) drives the full event-driven chain:

1. **Verifies** the gateway is healthy and reads the agent card
2. **Subscribes** to `kaiban-events-completed` (BullMQ) for event-driven chaining
3. **Step 1 — Research:** Submits research task to Ava; waits for real LLM output
4. **Step 2 — Write:** Passes research to Kai; waits for blog draft
5. **Step 3 — Edit:** Submits draft + research to Morgan; waits for editorial review
6. **Step 4 — HITL Decision:** Displays the full editorial review and prompts the human

### The Editorial Review (Morgan)

Morgan outputs a structured review in a fixed format:

```
## EDITORIAL REVIEW

**Topic:** AI Multi-Agent Systems in 2025
**Accuracy Score:** 8.5/10

### Factual Assessment
The post accurately describes the core concepts with minor unsupported claims.

### Issues Found
- Claim that "all agents use GPT-4" is unverified — Severity: HIGH
- Missing context on open-source alternatives — Severity: MEDIUM

### Required Changes
- Replace unverified GPT-4 claim with "LLM-agnostic" language
- Add one sentence on open-source agent frameworks

### Recommendation: REVISE

### Rationale
The post is mostly accurate but one HIGH-severity factual error must be
corrected before publication to maintain editorial standards.
```

### Human-in-the-Loop (HITL) Decision

After Morgan's review, the orchestrator **pauses** and presents the human with:

```
╔══════════════════════════════════════════════════════════╗
║  📝 EDITORIAL REVIEW BY MORGAN                          ║
║  Accuracy: 8.5/10  |  Recommendation: REVISE             ║
╚══════════════════════════════════════════════════════════╝

HUMAN REVIEW REQUIRED (HITL)
Options:
  [1] PUBLISH — Accept the post as-is and publish
  [2] REVISE  — Send back to writer with editor notes
  [3] REJECT  — Discard this post entirely
  [4] VIEW    — View full blog draft before deciding
```

**Decision outcomes:**
- **PUBLISH** → Final blog post printed to stdout; marked as done
- **REVISE** → Draft + editor notes sent back to Kai; revised draft returned; human confirms publish
- **REJECT** → Rejection rationale displayed; workflow ends

### Environment variables for the orchestrator

| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_URL` | `http://localhost:3000` | Edge Gateway URL |
| `REDIS_URL` | `redis://localhost:6379` | Redis for completion events |
| `TOPIC` | `Latest developments in AI agents` | Blog topic |
| `RESEARCH_WAIT_MS` | `120000` | Max wait for research (ms) |
| `WRITE_WAIT_MS` | `240000` | Max wait for writing/revision (ms) |
| `EDIT_WAIT_MS` | `300000` | Max wait for editorial review (ms) |
| `MESSAGING_DRIVER` | `bullmq` | `bullmq` or `kafka` — must match the workers |
| `KAFKA_BROKERS` | `localhost:9092` | Kafka brokers (when `MESSAGING_DRIVER=kafka`) |

---

## Integrating with kaiban-board

[kaiban-board](https://github.com/kaibanjs/kaiban-board) is a React component that visualises KaibanJS team execution as a live Kanban board.

### How state flows to kaiban-board

```
KaibanTeamBridge
  └── DistributedStateMiddleware.attach(team.getStore())
       └── on every Zustand setState() → publish to Redis Pub/Sub

SocketGateway (running in Edge Gateway)
  └── subscribes to Redis 'kaiban-state-events'
       └── broadcasts 'state:update' events via Socket.io
```

kaiban-board connects to the Socket.io server at the gateway URL and receives `state:update` events with Zustand state deltas.

> **Important — State merging:** Each worker node publishes only its own agent slice. Your board client must **merge by agentId/taskId** (not replace):
> ```javascript
> socket.on('state:update', (delta) => {
>   if (delta.agents) {
>     for (const a of delta.agents) agentMap.set(a.agentId, { ...agentMap.get(a.agentId), ...a });
>   }
>   if (delta.tasks) {
>     for (const t of delta.tasks) taskMap.set(t.taskId, { ...taskMap.get(t.taskId), ...t });
>   }
> });
> ```
>
> The bundled viewer at [`examples/blog-team/viewer/board.html`](examples/blog-team/viewer/board.html) already implements this correctly — open it directly in a browser, no build step needed.

### Option A: Connect kaiban-board via Socket.io client (recommended)

In your kaiban-board React app, add a Socket.io listener:

```tsx
import { io } from 'socket.io-client';
import { useEffect } from 'react';

const socket = io('http://localhost:3000');   // kaiban-distributed gateway

socket.on('state:update', (delta) => {
  // delta contains Zustand store fields: teamWorkflowStatus, tasks, agents, workflowLogs, etc.
  console.log('Distributed state update:', delta);
  // Update your local store or dispatch to React state
});
```

### Option B: Use KaibanTeamBridge for a local Team with distributed workers

Create a local KaibanJS Team that delegates execution to distributed workers:

```typescript
import { Agent, Task } from 'kaibanjs';
import { BullMQDriver } from 'kaiban-distributed/src/infrastructure/messaging/bullmq-driver';
import { KaibanTeamBridge } from 'kaiban-distributed/src/infrastructure/kaibanjs/kaiban-team-bridge';

// Create agents (same configs as your worker nodes)
const ava = new Agent({ name: 'Ava', role: 'Researcher', goal: '...', background: '...' });
const kai = new Agent({ name: 'Kai', role: 'Writer', goal: '...', background: '...' });

const researchTask = new Task({ description: 'Research {topic}', expectedOutput: 'Summary', agent: ava });
const writeTask = new Task({ description: 'Write blog about {topic}', expectedOutput: 'Blog post', agent: kai });

const driver = new BullMQDriver({ connection: { host: 'localhost', port: 6379 } });

const bridge = new KaibanTeamBridge({
  name: 'Blog Team',
  agents: [ava, kai],
  tasks: [researchTask, writeTask],
}, driver);

// Pass the underlying team to kaiban-board
const team = bridge.getTeam();

// Subscribe to distributed state changes
bridge.subscribeToChanges((changes) => {
  console.log('Team state changed:', changes);
}, ['teamWorkflowStatus', 'workflowResult']);

// Start — state changes propagate to Redis → Socket.io → kaiban-board
const result = await bridge.start({ topic: 'AI agents' });
```

---

## A2A Protocol (Agent-to-Agent)

The Edge Gateway implements the [A2A protocol](https://google-deepmind.github.io/a2a/) for interoperability with other AI systems.

### Agent Card

```
GET /.well-known/agent-card.json
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

| Method | Description | Example params |
|--------|-------------|----------------|
| `agent.status` | Query agent status | `{}` |
| `tasks.create` | Create and queue a task | `{ agentId, instruction, expectedOutput, inputs }` |
| `tasks.get` | Get task status | `{ taskId }` |

```bash
# Create a task (routes to kaiban-agents-{agentId} BullMQ queue)
curl -X POST http://localhost:3000/a2a/rpc \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tasks.create",
    "params": {
      "agentId": "researcher",
      "instruction": "Research quantum computing breakthroughs in 2025",
      "expectedOutput": "A 300-word technical summary",
      "inputs": { "topic": "quantum computing" }
    }
  }'
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "taskId": "task-1710000000000",
    "status": "QUEUED",
    "agentId": "researcher"
  }
}
```

---

## MCP Integration

For integration via MCP, directly with the streaming of tasks and agents communications, there are several **Model Context Protocol (MCP)** servers available for both Kafka and Redis that allow you to intercept, monitor, and query live data streams:

## 1. Redis MCP

The official **Redis MCP Server** (`mcp-redis`) is the standard choice here. It allows an AI agent to interact with Redis as if it were a native part of its memory.

* **Capabilities:** * **Streams:** Full support for `XADD`, `XREAD`, and `XRANGE`. You can tell the AI to "watch the 'orders' stream for the next 10 messages" or "query the last hour of events."
* **Pub/Sub:** Intercept real-time messages on specific channels.
* **Querying:** Beyond simple key-value lookups, it supports JSON path querying and vector search if your Redis instance has those modules.

* **Where to find it:** [Redis GitHub (mcp-redis)](https://github.com/redis/mcp-redis).

## 2. Kafka MCP

For Kafka, you have a few powerful options depending on whether you are using a managed service or a self-hosted cluster.

### Official & Managed Options

* **Confluent MCP Server:** Specifically designed for Confluent Cloud. It’s the most "query-heavy" option because it integrates with **Flink SQL**, allowing you to run actual SQL queries against a live Kafka stream (e.g., `SELECT * FROM orders WHERE total > 100`).
* **Google Cloud Kafka MCP:** If you use Google’s Managed Service for Apache Kafka, they provide a remote MCP server that handles cluster management and message consumption out of the box.

### Community & Open Source

* **kafka-mcp (shivamxtech):** A lightweight Python-based server that lets you produce/consume messages and list topics using natural language.
* **tuannvm/kafka-mcp-server:** A robust Go-based implementation. It includes "Resources" (like cluster health reports) and "Tools" (to consume messages from specific offsets). This is excellent for **intercepting** a stream to see what's happening right now.

## How "Intercept and Query" Works in MCP

When you use these servers with a client (like Claude Desktop or Cursor), the workflow typically looks like this:

| Action | Example Natural Language Prompt |
| --- | --- |
| **Intercept** | "Monitor the `payments` topic and tell me if you see any transactions over $5,000." |
| **Query (Kafka)** | "Sample 10 messages from `user-logs` and summarize the most frequent error codes." |
| **Query (Redis)** | "Get all entries from the `sensor_data` stream between 9:00 AM and 10:00 AM today." |

## Getting Started

If you want to try this immediately, the **Redis MCP** is the easiest to set up locally:

1. **Install the Redis MCP Server:**
```bash
npx @modelcontextprotocol/server-redis

```

2. **Add to your MCP Config:**
In your `claude_desktop_config.json` (or equivalent), add:
```json
"redis": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-redis", "--url", "redis://localhost:6379"]
}

```

3. **Use programatically via MCP libraries in code**

Attach [Model Context Protocol](https://modelcontextprotocol.io) tool servers, or clients, to your agents:

```typescript
import { MCPFederationClient } from './src/infrastructure/federation/mcp-client';

const mcpClient = new MCPFederationClient('npx', ['-y', '@modelcontextprotocol/server-brave-search']);
await mcpClient.connect();

const tools = await mcpClient.listTools();
console.log('Available tools:', tools);

const result = await mcpClient.callTool('brave_web_search', { query: 'AI agents 2025' });
await mcpClient.disconnect();
```

---

## Messaging Drivers

### BullMQ (Default — Redis)

Best for: Development, small-to-medium scale, reliable delivery.

```bash
MESSAGING_DRIVER=bullmq
REDIS_URL=redis://localhost:6379
```

Features: Automatic retries, job priorities, delayed jobs, job history.

### Kafka (High-Throughput)

Best for: Large scale, event streaming, message replay, multi-datacenter.

```bash
MESSAGING_DRIVER=kafka
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=kaiban-worker
KAFKA_GROUP_ID=kaiban-group
```

```bash
# Start Kafka stack
docker compose up -d redis zookeeper kafka

# Run with Kafka driver
MESSAGING_DRIVER=kafka KAFKA_BROKERS=localhost:9092 AGENT_IDS=researcher node dist/main/index.js
```

### Switching drivers at runtime

The `MESSAGING_DRIVER` env var selects the driver on startup. The `IMessagingDriver` interface is the abstraction — both BullMQDriver and KafkaDriver implement it, so your agent code is identical regardless of driver.

---

## Real-Time State — Socket.io Events

Connect a Socket.io client to `ws://gateway:3000` to receive live agent state:

| Event | Payload | Description |
|-------|---------|-------------|
| `state:update` | `Record<string, unknown>` | Zustand state delta (PII-sanitized) |

State delta fields:

```typescript
{
  teamWorkflowStatus: 'INITIAL' | 'RUNNING' | 'FINISHED' | 'ERRORED' | 'BLOCKED' | 'STOPPED',
  workflowResult: string | null,
  tasks: Array<{ id, title, status: 'TODO' | 'DOING' | 'DONE' | 'BLOCKED' | 'AWAITING_VALIDATION' }>,
  agents: Array<{ id, name, status: 'IDLE' | 'THINKING' | 'EXECUTING' | 'ERROR' }>,
  workflowLogs: Array<{ logType, timestamp, message, ... }>,
}
```

---

## API Reference

### HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check — returns `{ data: { status: 'ok', timestamp } }` |
| `GET` | `/.well-known/agent-card.json` | A2A agent capabilities |
| `POST` | `/a2a/rpc` | JSON-RPC 2.0 task creation and agent queries |

All responses use the envelope: `{ data, meta, errors }`.

### Docker Image

```dockerfile
# Multi-stage build: builder (npm ci + tsc) → runner (non-root, dist/ only)
docker build -t kaiban-distributed:latest .

# Single worker
docker run -p 3000:3000 \
  -e REDIS_URL=redis://redis:6379 \
  -e AGENT_IDS=researcher,writer \
  -e OPENAI_API_KEY=sk-... \
  kaiban-distributed:latest

# Scale writer nodes horizontally
docker compose up --scale writer=3
```

---

## Configuration Reference

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `AGENT_IDS` | — | **Yes** | Comma-separated agent IDs this node serves (e.g. `researcher,writer`) |
| `REDIS_URL` | `redis://localhost:6379` | No | Redis connection URL |
| `MESSAGING_DRIVER` | `bullmq` | No | `bullmq` or `kafka` |
| `KAFKA_BROKERS` | `localhost:9092` | Kafka only | Comma-separated broker addresses |
| `KAFKA_CLIENT_ID` | `kaiban-worker` | No | Kafka client identifier |
| `KAFKA_GROUP_ID` | `kaiban-group` | No | Kafka consumer group ID |
| `PORT` | `3000` | No | HTTP server port |
| `SERVICE_NAME` | `kaiban-worker` | No | Service name for telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | No | OpenTelemetry OTLP endpoint URL |
| `OPENAI_API_KEY` | — | For real agents | Standard OpenAI API key |
| `OPENROUTER_API_KEY` | — | For real agents | OpenRouter key (auto-sets base URL + uses `openai` provider) |
| `OPENAI_BASE_URL` | — | Optional | Custom OpenAI-compatible endpoint (e.g. `https://openrouter.ai/api/v1`) |
| `LLM_MODEL` | `gpt-4o-mini` | No | Model name; for OpenRouter use `openai/gpt-4o-mini` or `meta-llama/llama-3.1-8b-instruct:free` |

---

## Docker Deployment

### Full Stack (Redis + Kafka + Worker)

```bash
docker compose up -d
```

Services:
- **redis** — Redis 7 Alpine, port 6379
- **zookeeper** — Confluent Zookeeper 7.6.0, port 2181
- **kafka** — Confluent Kafka 7.6.0, port 9092
- **kaiban-worker** — Built from Dockerfile, port 3000

### Multi-Node Blog Team Demo — BullMQ (default)

```bash
# Start 5-service blog pipeline (Redis + gateway + researcher + writer + editor)
docker compose \
  -f examples/blog-team/docker-compose.yml \
  --env-file .env \
  up --build

# Run orchestrator (separate terminal)
GATEWAY_URL=http://localhost:3000 REDIS_URL=redis://localhost:6379 \
TOPIC="AI Agents in 2025" \
  npx ts-node examples/blog-team/orchestrator.ts
```

### Multi-Node Blog Team Demo — Kafka

```bash
# Start Kafka-based pipeline (Zookeeper + Kafka + Redis + gateway + researcher + writer + editor)
docker compose \
  -f examples/blog-team/docker-compose.kafka.yml \
  --env-file .env \
  up --build

# Run orchestrator using Kafka as the messaging layer
GATEWAY_URL=http://localhost:3000 \
REDIS_URL=redis://localhost:6379 \
MESSAGING_DRIVER=kafka \
KAFKA_BROKERS=localhost:9092 \
TOPIC="AI Agents in 2025" \
  npx ts-node examples/blog-team/orchestrator.ts
```

> **Architecture note (Kafka):** Task queues use Kafka topics (`kaiban-agents-*`, `kaiban-events-*`). State broadcast (`kaiban-state-events`) still uses Redis Pub/Sub because `SocketGateway` reads from it directly. Each worker/orchestrator component gets a unique Kafka consumer group suffix to prevent message routing conflicts.

Services: redis + zookeeper + kafka + gateway + researcher (Ava) + writer (Kai) + editor (Morgan).

### Production Scaling

```yaml
# Scale to 5 writer nodes (all subscribe to the same BullMQ queue — auto load-balanced)
docker compose up --scale writer=5
```

---

## Security & Compliance

| Control | Implementation |
|---------|----------------|
| **GDPR — PII in logs** | Agent IDs SHA-256 hashed in all log output via `sanitizeId()` |
| **GDPR — State deltas** | PII keys (`email`, `name`, `phone`, `ip`, `password`, `token`, `secret`) stripped by `sanitizeDelta()` before publishing |
| **SOC2 — Non-root container** | Dockerfile runs as `USER kaiban` (non-root) |
| **SOC2 — Secrets** | All secrets via env vars; `.env` gitignored; `.env.example` has no real values |
| **ISO 27001 — Encryption** | TLS 1.3+ in transit when using Redis TLS or Kafka with SSL |
| **Observability** | OpenTelemetry auto-instrumentation for all HTTP, Redis, and BullMQ spans |
| **Dependency audit** | `npm audit` run in CI; known issue: kaibanjs ≥ 0.3.0 transitive CVEs (langchain), unfixable without framework downgrade |

---

## Development

### Commands

```bash
npm run build          # tsc → dist/
npm run dev            # Run from dist/ (build first)
npm run test           # 106 unit tests
npm run test:coverage  # 100% coverage report
npm run test:e2e       # E2E tests (requires Docker + Redis)
npm run test:e2e:kafka # Kafka E2E tests (requires Docker + Kafka)
npm run lint           # ESLint (0 errors target)
npm run typecheck      # tsc --noEmit (strict)
npm run format         # Prettier
```

### Project Structure

```
kaiban-distributed/
├── src/
│   ├── domain/                        # Business entities (no framework deps)
│   │   ├── entities/                  # DistributedTask, DistributedAgentState
│   │   ├── errors/                    # DomainError hierarchy
│   │   └── result.ts                  # Result<T,E> type
│   ├── application/
│   │   └── actor/AgentActor.ts        # Core actor: retry, DLQ, PII sanitization
│   ├── adapters/
│   │   ├── gateway/                   # GatewayApp (Express), SocketGateway
│   │   └── state/                     # DistributedStateMiddleware (Zustand)
│   ├── infrastructure/
│   │   ├── messaging/                 # BullMQDriver, KafkaDriver, interfaces
│   │   ├── federation/                # A2AConnector, MCPFederationClient
│   │   ├── kaibanjs/                  # KaibanAgentBridge, KaibanTeamBridge
│   │   └── telemetry/                 # OTel setup, TraceContext
│   └── main/                          # Composition root, config
├── tests/
│   ├── unit/                          # 106 unit tests (100% coverage)
│   └── e2e/                           # E2E: BullMQ/Redis + Kafka
├── examples/
│   └── blog-team/                     # Multi-node demo (Ava + Kai agents)
│       ├── team-config.ts             # Agent configs
│       ├── researcher-node.ts         # Researcher worker entry point
│       ├── writer-node.ts             # Writer worker entry point
│       ├── orchestrator.ts            # Task submission + monitoring
│       └── docker-compose.yml         # Multi-node deployment
├── agents/                            # GABBE kit (guides, skills, memory)
├── docker-compose.yml                 # Full stack (Redis + Kafka)
├── Dockerfile                         # Multi-stage, non-root
└── .env.example                       # All env vars documented
```

### Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| BullMQ as default over Kafka | Lower ops overhead for development and small deployments |
| No colons in BullMQ queue names | BullMQ v5 rejects colons; dashes used instead (`kaiban-agents-{id}`) |
| `IMessagingDriver` abstraction | Swap BullMQ ↔ Kafka via env var without changing agent code |
| PII denylist (not allowlist) | KaibanJS Zustand schema not fully controlled; denylist safer for GDPR |
| SHA-256 hash prefix for agent IDs in logs | Preserves debuggability (8-char prefix) while preventing PII leakage |
| `AgentActor.stop()` calls `unsubscribe()` not `disconnect()` | Shared driver pattern — only detach self, not tear down the whole connection |
| `A2AConnector` accepts optional `IMessagingDriver` | Testable without messaging infra; gateway wires it at startup |

---

## Testing

```bash
# Unit tests (no external deps)
npm test
# 106 tests across 14 suites, 100% coverage

# BullMQ E2E (requires Redis)
npm run test:e2e
# 7 tests: distributed execution, fault tolerance, state sync, A2A protocol

# Kafka E2E (requires Kafka + Zookeeper)
npm run test:e2e:kafka
# 2 tests: publish-subscribe round-trip, unsubscribe behaviour
```

### Coverage

| Metric | Result |
|--------|--------|
| Statements | 100% |
| Branches | 100% |
| Functions | 100% |
| Lines | 100% |


---

## Real-Time Monitor & Debugging

A single command to stream all system activity in your terminal:

```bash
./scripts/monitor.sh
```

What it shows (all in real-time, colour-coded by source):

| Stream | Colour | Description |
|--------|--------|-------------|
| `[workflow]` | Cyan | Workflow status transitions (INITIAL → RUNNING → FINISHED) |
| `[agents  ]` | Cyan | Agent statuses: **IDLE** (dim), **EXECUTING** (bold green), **THINKING** (bold blue), **ERROR** (bold red) |
| `[tasks   ]` | Cyan | Task statuses: **DOING** (bold blue), **DONE** (bold green), **BLOCKED** (bold red), **AWAITING_VALIDATION** (bold yellow) |
| `[logs]` researcher | Blue | Ava's process logs: task received, LLM calls, retries, completions |
| `[logs]` writer | Green | Kai's process logs |
| `[logs]` editor | Magenta | Morgan's editorial review output |
| `[logs]` gateway | Yellow | HTTP requests, A2A calls, Socket.io connections |
| `[bull:event]` | Magenta | BullMQ internal events: job activated / completed / failed |
| `[queue]` | Yellow | BullMQ queue depths polled every 5s (waiting / active / failed) |
| `[!ERR]` | Red | Any error, exception, or BLOCKED state across all containers |

**Configuration:**

```bash
REDIS_URL=redis://localhost:6379 \
COMPOSE_FILE=examples/blog-team/docker-compose.yml \
LOG_TAIL=200 \
QUEUE_POLL_SEC=3 \
  ./scripts/monitor.sh
```

**Requirements:** `docker` (and `docker compose`). `redis-cli` auto-detected — uses `docker exec` inside the Redis container if the native binary is not in `$PATH`.

### Debugging LLM issues

The monitor highlights all lines containing `LLM`, `executeThinking`, `finalAnswer`, `tokens`, or `model` in **bold** so you can spot LLM call behaviour without scrolling. Error lines (`KaibanJS execution error`, `401`, `404 MODEL_NOT_FOUND`) appear in red immediately.

**Common issues:**

| Error | Cause | Fix |
|-------|-------|-----|
| `401 User not found` | Invalid OpenRouter API key | Get a valid key at https://openrouter.ai/keys |
| `404 MODEL_NOT_FOUND` | Model name wrong or needs data policy | Use `meta-llama/llama-3.1-8b-instruct:free` or enable https://openrouter.ai/settings/privacy |
| `LLM instance not initialized` | Agent not initialized before workOnTask | Already fixed — `initializeAgentLLM()` bootstraps without a Team |
| `Queue name cannot contain :` | Colon in BullMQ queue name | Already fixed — all internal queues use dashes |
| `Timeout waiting for research` | Task failed (DLQ) and orchestrator not notified | Already fixed — `CompletionRouter` subscribes to both `kaiban-events-completed` AND `kaiban-events-failed` |
| Kafka: revision/edit tasks not received | Second `subscribe()` call after `consumer.run()` fails in KafkaJS | Fixed — orchestrator creates TWO separate KafkaDriver instances (different consumer groups) for completed vs failed queues |

---

## Project Context

Built with [**GABBE Agentic Engineering Kit**](https://github.com/andreibesleaga/GABBE) following the SDD/TDD lifecycle:

- **S01** — Requirements (PRD.md)
- **S02** — Architecture (PLAN.md with C4 diagrams)
- **S03** — Specification (SPEC.md with domain models)
- **S04** — Decomposition (TASKS.md)
- **S05** — Implementation (6 core modules)
- **S06** — Testing (unit test suite)
- **S07** — Integration + KaibanJS wiring + README (current)

---

## License

GPL.v3 ©[andreibesleaga](https://github.com/andreibesleaga)
