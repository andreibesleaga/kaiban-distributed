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

**Run the orchestrator** (separate terminal):
```bash
GATEWAY_URL=http://localhost:3000 \
REDIS_URL=redis://localhost:6379 \
TOPIC="AI Agents in 2025" \
  npx ts-node examples/blog-team/orchestrator.ts
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

**Run the orchestrator with Kafka:**
```bash
GATEWAY_URL=http://localhost:3000 \
REDIS_URL=redis://localhost:6379 \
MESSAGING_DRIVER=kafka \
KAFKA_BROKERS=localhost:9092 \
TOPIC="AI Agents in 2025" \
  npx ts-node examples/blog-team/orchestrator.ts
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
