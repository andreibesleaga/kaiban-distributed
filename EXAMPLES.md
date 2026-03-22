# Examples (running the distributed blog team instructions)

> All runnable examples collected in one place. Each is self-contained.

---

## Example 1 — Blog Team Pipeline (Three-Agent Editorial)

Three KaibanJS agents collaborate to research, write, and fact-check a blog post, with a human editorial decision at the end.

```
Ava (researcher) ──> Kai (writer) ──> Morgan (editor) ──> Human (HITL)
    Node #1              Node #2           Node #3
```

### Agents

| Agent | Name | Role | Queue |
|-------|------|------|-------|
| Researcher | Ava | Finds verifiable facts with sources | `kaiban-agents-researcher` |
| Writer | Kai | Drafts Markdown blog post (500–800 words) | `kaiban-agents-writer` |
| Editor | Morgan | Structured review + PUBLISH/REVISE/REJECT | `kaiban-agents-editor` |

### Morgan's editorial review format

```
## EDITORIAL REVIEW
**Topic:** AI Agents in 2025
**Accuracy Score:** 8.5/10

### Factual Assessment
The post is mostly accurate with one unsupported claim.

### Issues Found
- "All agents require GPT-4" is unverified — Severity: HIGH

### Required Changes
- Replace with "LLM-agnostic" language

### Recommendation: REVISE

### Rationale
One HIGH-severity error must be corrected before publication.
```

### HITL terminal prompt

```
╔══════════════════════════════════════════════════════════╗
║  📝 EDITORIAL REVIEW BY MORGAN                          ║
║  Accuracy: 8.5/10  |  Recommendation: REVISE             ║
╚══════════════════════════════════════════════════════════╝

Options:
  [1] PUBLISH — Accept and publish
  [2] REVISE  — Send back to Kai with editor notes
  [3] REJECT  — Discard this post
  [4] VIEW    — View full draft before deciding
```

Outcomes on board:
- `[1] PUBLISH` → `✅ WORKFLOW COMPLETE` green banner; all tasks DONE; agents IDLE
- `[2] REVISE` → revision task appears as DOING; human confirms revised draft
- `[3] REJECT` → `⏹ WORKFLOW ENDED` grey banner; editorial task BLOCKED

### Orchestrator environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_URL` | `http://localhost:3000` | Edge Gateway URL |
| `REDIS_URL` | `redis://localhost:6379` | Redis for completion events |
| `TOPIC` | `Latest developments in AI agents` | Blog topic |
| `MESSAGING_DRIVER` | `bullmq` | `bullmq` or `kafka` — must match worker containers |
| `KAFKA_BROKERS` | `localhost:9092` | Kafka broker(s) when using Kafka |
| `RESEARCH_WAIT_MS` | `120000` | Max wait for Ava (ms) |
| `WRITE_WAIT_MS` | `240000` | Max wait for Kai and revisions (ms) |
| `EDIT_WAIT_MS` | `300000` | Max wait for Morgan (ms) |

---

### 1A — BullMQ + Redis (default)

**Prepare:**
```bash
# Stop any conflicting stacks and clean networks
docker compose -f examples/blog-team/docker-compose.yml down --remove-orphans 2>/dev/null
docker network prune --force 2>/dev/null
```

**Start services:**
```bash
docker compose \
  -f examples/blog-team/docker-compose.yml \
  --env-file .env \
  up --build
```
Services: `redis` · `gateway` (port 3000) · `researcher` · `writer` · `editor`

**Open the board:**
```
Open: examples/blog-team/viewer/board.html in your browser
→ Connects to http://localhost:3000
→ Within 15 seconds: Ava, Kai, Morgan appear as IDLE
```

**Run the orchestrator** — choose one approach:

*Option A — local (requires Node.js + project deps):*
```bash
GATEWAY_URL=http://localhost:3000 \
REDIS_URL=redis://localhost:6379 \
TOPIC="AI Agents in 2025" \
  npx ts-node examples/blog-team/orchestrator.ts
```

*Option B — fully containerised (recommended for clean environments):*
```bash
docker compose -f examples/blog-team/docker-compose.yml run --rm \
  -e TOPIC="AI Agents in 2025" orchestrator
```

Or use the wrapper script with `--docker`:
```bash
./scripts/blog-team.sh start --docker
```

**Monitor** (optional third terminal):
```bash
COMPOSE_FILE=examples/blog-team/docker-compose.yml ./scripts/monitor.sh
```

**What you see on the board:**
1. `RUNNING` — agents cycle IDLE → EXECUTING → IDLE as each step completes
2. Tasks flow: `DOING` → `DONE` in Kanban columns
3. Step 3: editorial task → `AWAITING_VALIDATION` — orange pulsing banner
4. After your terminal decision: `✅ WORKFLOW COMPLETE` or `⏹ WORKFLOW ENDED`

---

### 1B — Kafka (high-throughput)

**Prepare:**
```bash
docker compose -f examples/blog-team/docker-compose.kafka.yml down --remove-orphans 2>/dev/null
docker network prune --force 2>/dev/null
```

**Start services:**
```bash
docker compose \
  -f examples/blog-team/docker-compose.kafka.yml \
  --env-file .env \
  up --build
```
Services: `redis` · `zookeeper` · `kafka` · `gateway` · `researcher` · `writer` · `editor`

> Kafka takes 30–60 seconds for Zookeeper election + topic leader assignment.
> Wait until `curl http://localhost:3000/health` returns `{"status":"ok"}`.

**Verify consumer groups joined** (all 4 should appear):
```bash
docker exec blog-team-kafka-1 kafka-consumer-groups \
  --bootstrap-server localhost:9092 --list
# kaiban-group
# kaiban-group-researcher
# kaiban-group-writer
# kaiban-group-editor
```

**Run the orchestrator with Kafka** — choose one approach:

*Option A — local:*
```bash
GATEWAY_URL=http://localhost:3000 \
REDIS_URL=redis://localhost:6379 \
MESSAGING_DRIVER=kafka \
KAFKA_BROKERS=localhost:9092 \
TOPIC="AI Agents in 2025" \
  npx ts-node examples/blog-team/orchestrator.ts
```

*Option B — fully containerised:*
```bash
docker compose -f examples/blog-team/docker-compose.kafka.yml run --rm \
  -e TOPIC="AI Agents in 2025" orchestrator
```

Or use the wrapper script:
```bash
./scripts/blog-team.sh start --kafka --docker
```

**Verify a task was consumed** (after first step):
```bash
docker exec blog-team-kafka-1 kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --describe --group kaiban-group-researcher
# CURRENT-OFFSET=1  LOG-END-OFFSET=1  LAG=0  ← task consumed

docker exec blog-team-kafka-1 kafka-run-class kafka.tools.GetOffsetShell \
  --broker-list localhost:9092 --topic kaiban-events-completed --time -1
# kaiban-events-completed:0:1  ← 1 completion published
```

---

### 1C — Individual nodes without Docker (BullMQ)

Requires Redis running at `localhost:6379`:

```bash
# Terminal 1 — Ava (researcher)
REDIS_URL=redis://localhost:6379 \
OPENROUTER_API_KEY=sk-or-v1-... \
LLM_MODEL=meta-llama/llama-3.1-8b-instruct:free \
  npx ts-node examples/blog-team/researcher-node.ts

# Terminal 2 — Kai (writer)
REDIS_URL=redis://localhost:6379 \
OPENROUTER_API_KEY=sk-or-v1-... \
LLM_MODEL=meta-llama/llama-3.1-8b-instruct:free \
  npx ts-node examples/blog-team/writer-node.ts

# Terminal 3 — Morgan (editor)
REDIS_URL=redis://localhost:6379 \
OPENROUTER_API_KEY=sk-or-v1-... \
LLM_MODEL=meta-llama/llama-3.1-8b-instruct:free \
  npx ts-node examples/blog-team/editor-node.ts

# Terminal 4 — Gateway
REDIS_URL=redis://localhost:6379 \
AGENT_IDS=gateway PORT=3000 \
  node dist/src/main/index.js

# Terminal 5 — Orchestrator
GATEWAY_URL=http://localhost:3000 \
REDIS_URL=redis://localhost:6379 \
TOPIC="AI Agents in 2025" \
  npx ts-node examples/blog-team/orchestrator.ts
```

---

### 1D — Individual nodes without Docker (Kafka)

Same as 1C but add `MESSAGING_DRIVER=kafka KAFKA_BROKERS=localhost:9092` to every terminal. Start Kafka first:

```bash
docker compose up -d redis zookeeper kafka
```

```bash
# Example for researcher:
REDIS_URL=redis://localhost:6379 \
MESSAGING_DRIVER=kafka KAFKA_BROKERS=localhost:9092 \
OPENROUTER_API_KEY=sk-or-v1-... \
  npx ts-node examples/blog-team/researcher-node.ts
```

---

### 1E — Kubernetes

A complete set of raw Kubernetes manifests is located in `examples/blog-team/infra/kubernetes/`.

**Deploy:**
```bash
# Apply ConfigMap & Secrets (edit secrets in file first)
kubectl apply -f examples/blog-team/infra/kubernetes/configmap.yaml

# Apply remaining components
kubectl apply -f examples/blog-team/infra/kubernetes/redis.yaml
kubectl apply -f examples/blog-team/infra/kubernetes/gateway.yaml
kubectl apply -f examples/blog-team/infra/kubernetes/agents.yaml
```

**Access the board:**
If running on Docker Desktop / Minikube:
```bash
kubectl port-forward svc/kaiban-gateway 3000:3000
```
Then open `examples/blog-team/viewer/board.html`.

---

### 1F — Helm

Helm provides a parameterized alternative located in `examples/blog-team/infra/helm/`.

**Deploy:**
```bash
helm install blog-team examples/blog-team/infra/helm \
  --set secrets.OPENAI_API_KEY="sk-..." \
  --set secrets.OPENROUTER_API_KEY="sk-or-v1-..."
```

**Scale agents on the fly:**
```bash
helm upgrade blog-team examples/blog-team/infra/helm \
  --set agents.writer.replicas=3
```

---

### 1G — Railway.app

Deploying `kaiban-distributed` directly using Railway is fully supported using the provided configuration template at `examples/blog-team/infra/railway/railway.toml`. Since Railway utilizes a "one service per repository" by default, deploy the Actor Model incrementally:

1. Create a Railway Project and spin up a **Redis** plugin instance.
2. Link the `kaiban-distributed` repository.
3. Add **4 separate services** all pointing to the same repository.
4. Under the **Deploy -> Custom Start Command** settings, override each service:
   - **Gateway:** `node dist/src/main/index.js`
   - **Researcher:** `node dist/examples/blog-team/researcher-node.js`
   - **Writer:** `node dist/examples/blog-team/writer-node.js`
   - **Editor:** `node dist/examples/blog-team/editor-node.js`
5. Map **Variables** using `${{Redis.REDIS_URL}}` and supply your `OPENAI_API_KEY`.
6. Expose the domain of the **Gateway** service and direct the viewer to it.

---

### Teardown

```bash
# BullMQ stack
docker compose -f examples/blog-team/docker-compose.yml --env-file .env down

# Kafka stack
docker compose -f examples/blog-team/docker-compose.kafka.yml --env-file .env down

# Clean stale networks (when switching between stacks)
docker network prune --force
```

---

## Example 2 — Horizontal Scaling

Scale any worker horizontally — BullMQ auto-distributes tasks across all instances:

```bash
# 5 writer nodes competing for jobs from kaiban-agents-writer
docker compose \
  -f examples/blog-team/docker-compose.yml \
  --env-file .env \
  up --build --scale writer=5
```

All 5 instances subscribe to `kaiban-agents-writer`. Each job is processed exactly once (BullMQ competing consumers).

---

## Example 3 — Single Docker Container (minimal)

```bash
docker build -t kaiban-distributed:latest .

docker run -p 3000:3000 \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  -e AGENT_IDS=researcher,writer,editor \
  -e OPENROUTER_API_KEY=sk-or-v1-... \
  -e LLM_MODEL=meta-llama/llama-3.1-8b-instruct:free \
  kaiban-distributed:latest
```

Submit tasks:
```bash
curl -X POST http://localhost:3000/a2a/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tasks.create","params":{"agentId":"researcher","instruction":"Research AI agent trends 2025","expectedOutput":"A 200-word summary"}}'
```

---

## Example 4 — Test Suites

```bash
# Unit tests (no Docker, all mocked)
npm test
# → 128 tests, 15 files, 100% coverage

# BullMQ E2E (Docker auto-starts Redis)
npm run test:e2e
# → 7 tests: task execution, fault tolerance, state sync, A2A protocol

# Kafka E2E (requires Kafka — starts automatically)
npm run test:e2e:kafka
# → 2 tests: publish-subscribe round-trip, unsubscribe

# All quality gates at once
npm run lint && npm run typecheck && npm run test:coverage
```

---

## Example 5 — Monitor All Streams

```bash
# Start blog-team BullMQ stack first
docker compose -f examples/blog-team/docker-compose.yml --env-file .env up -d

# Then open the terminal monitor
COMPOSE_FILE=examples/blog-team/docker-compose.yml ./scripts/monitor.sh
```

Shows in real-time (colour-coded):
- Workflow status transitions
- All 3 agent status changes (IDLE/EXECUTING/DONE/ERROR)
- Task Kanban movements
- BullMQ queue depths (every 5s)
- All container logs with error highlighting

---

## Example 5 — Fan-Out / Fan-In: Parallel Agent Workflow

Multiple specialized agents execute **concurrently** (fan-out), their results are
**aggregated automatically** (fan-in), and an **auto-approver** validates the
combined outcome — no human in the loop.

```
Orchestrator
     │  publish N sub-tasks to shared queue (fan-out)
     ▼
[Agent-0] [Agent-1] [Agent-2] [Agent-N]   ← competing consumers / multi-node
     │        │        │        │
     └────────┴────────┴────────┘
              publish to kaiban-events-completed (fan-in)
                           │
                    Aggregator collects
                           │
                   Auto-Approver validates
                           │
               kaiban-fanin-approved → ✅ / ❌
```

### Minimal implementation sketch

```typescript
import { BullMQDriver } from 'kaiban-distributed';
import { AgentActor } from 'kaiban-distributed';

const REDIS = { connection: { host: 'localhost', port: 6379 } };
const QUEUE  = 'research-fan-out';
const AGENT  = 'researcher';

// 1. Fan-out: spawn N workers — all share the same queue (competing consumers)
for (let i = 0; i < 4; i++) {
  const driver = new BullMQDriver(REDIS);
  const actor  = new AgentActor(AGENT, driver, QUEUE, async (payload) => {
    const result = await myLLM.call(payload.data.instruction);
    return result;  // published to kaiban-events-completed automatically
  });
  await actor.start();
}

// 2. Fan-in: collect completions
const completions = new Set<string>();
const collector = new BullMQDriver(REDIS);
await collector.subscribe('kaiban-events-completed', async (p) => {
  completions.add(p.taskId);
});

// 3. Publish tasks (fan-out)
const taskIds = ['task-a', 'task-b', 'task-c', 'task-d'];
for (const taskId of taskIds) {
  await collector.publish(QUEUE, { taskId, agentId: AGENT, timestamp: Date.now(), data: { instruction: `research ${taskId}` } });
}

// 4. Wait for all completions (fan-in gate)
while (completions.size < taskIds.length) {
  await new Promise(r => setTimeout(r, 200));
}

// 5. Auto-approve (no HITL)
const approved = completions.size === taskIds.length;
await collector.publish('kaiban-fanin-approved', {
  taskId: 'workflow-1',
  agentId: 'approver',
  timestamp: Date.now(),
  data: { status: approved ? 'approved' : 'rejected', count: completions.size },
});
```

### Key properties

| Property | Behaviour |
|---|---|
| **Distribution** | BullMQ competing-consumer pattern — each job claimed by exactly one worker |
| **Horizontal scale** | Add more `AgentActor` instances (same queue) for more throughput |
| **Retry / DLQ** | Each actor retries up to 3× before publishing to `kaiban-events-failed` |
| **Exactly-once fan-in** | Aggregator uses a `Set<taskId>` — duplicates are idempotently ignored |
| **No HITL required** | Auto-approver validates success ratio against a configurable threshold |

### Reference E2E tests

See [`tests/e2e/fan-out-fan-in.test.ts`](./tests/e2e/fan-out-fan-in.test.ts) for
full end-to-end scenarios covering:

1. **Golden Path** — 4 agents, all succeed, approver passes
2. **Scaled 8-node** — 8 agents (horizontal fan-out)
3. **Partial Failure + Retry** — 1 flaky agent recovers, workflow approves
4. **Total Failure** — all retries exhausted → DLQ, approver rejects
5. **Late-joining agent** — BullMQ delivers persisted jobs to late consumer
6. **Duplicate task IDs** — aggregator counts each taskId exactly once
7. **Approver threshold** — strict vs lenient ratio comparison

---
