# Global Research Swarm

A production-grade **fan-out / fan-in** distributed AI agent system built on Kaiban Distributed.

```
[Fan-Out]  N × Zara (Searcher) ──→ kaiban-agents-searcher (competing consumers)
                                          │
[Fan-In]   Atlas (Writer) ←── rawSearchData[] collected from all searchers
                                          │
[Govern]   Sage (Reviewer) ←── consolidatedDraft
                                          │
[HITL]     Morgan (Editor) ←── governance verdict
                                          │
                           Human Decision: PUBLISH | REVISE | REJECT
```

## Quick Start

### Prerequisites

- Node.js 22+
- Docker + Docker Compose
- An OpenAI or OpenRouter API key

### 1. Start infrastructure

```bash
# Copy env template
cp .env.example .env
# Set OPENAI_API_KEY or OPENROUTER_API_KEY in .env

# Start Redis + Gateway + 4 Searchers + Writer + Reviewer + Editor
docker compose -f examples/global-research/docker-compose.yml --env-file .env up --build
```

### 2. Run the orchestrator

```bash
GATEWAY_URL=http://localhost:3000 \
REDIS_URL=redis://localhost:6379 \
QUERY="The Future of AI Agents" \
NUM_SEARCHERS=4 \
npx ts-node examples/global-research/orchestrator.ts
```

### 3. Open the live board

Open `examples/global-research/viewer/board.html` in your browser to watch the swarm in real time.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_URL` | `http://localhost:3000` | A2A gateway URL |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `QUERY` | `The Future of AI Agents` | Research query/topic |
| `NUM_SEARCHERS` | `4` | Number of parallel searcher tasks (fan-out width) |
| `SEARCH_WAIT_MS` | `120000` | Timeout for all searchers to complete (ms) |
| `WRITE_WAIT_MS` | `240000` | Timeout for writer aggregation (ms) |
| `REVIEW_WAIT_MS` | `180000` | Timeout for governance review (ms) |
| `EDIT_WAIT_MS` | `300000` | Timeout for editorial review (ms) |
| `MESSAGING_DRIVER` | `bullmq` | `bullmq` or `kafka` |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `OPENROUTER_API_KEY` | — | OpenRouter API key (alternative) |
| `LLM_MODEL` | `gpt-4o-mini` | LLM model identifier |
| `CHAOS_MODE` | `false` | Enable 20% crash rate on searchers |
| `SEARCHER_ID` | `searcher` | Identity for multi-instance searcher nodes |

## NODE_TYPE — Single Entry Point

Instead of running individual node scripts, use the unified entry point:

```bash
# Run a searcher node
NODE_TYPE=searcher npx ts-node examples/global-research/node.ts

# Run the writer node
NODE_TYPE=writer npx ts-node examples/global-research/node.ts

# Run the reviewer node
NODE_TYPE=reviewer npx ts-node examples/global-research/node.ts

# Run the editor node
NODE_TYPE=editor npx ts-node examples/global-research/node.ts
```

This proves **Location Transparency**: you can run searchers locally, the editor on a remote server — they collaborate via the Redis backbone.

## Scaling Searchers

```bash
# Scale to 8 searcher replicas in Docker Compose
docker compose -f examples/global-research/docker-compose.yml up --scale searcher=8

# Or set NUM_SEARCHERS in the orchestrator
NUM_SEARCHERS=8 QUERY="..." npx ts-node examples/global-research/orchestrator.ts
```

## Chaos Mode

Chaos mode simulates a 20% process crash rate on searcher nodes to demonstrate BullMQ's retry and fault tolerance:

```bash
# Enable chaos on a specific searcher
CHAOS_MODE=true SEARCHER_ID=searcher-1 npx ts-node examples/global-research/searcher-node.ts

# Enable via Docker Compose
CHAOS_MODE=true docker compose -f examples/global-research/docker-compose.yml up
```

When a searcher crashes (simulated via `process.exit(1)`), BullMQ automatically reassigns the job to another available searcher worker.

## Kafka Variant

```bash
docker compose -f examples/global-research/docker-compose.kafka.yml --env-file .env up --build
```

Then set `MESSAGING_DRIVER=kafka KAFKA_BROKERS=localhost:9092` when running the orchestrator.

## Kubernetes

```bash
# Apply all manifests
kubectl apply -f examples/global-research/infra/kubernetes/

# Scale searcher fleet
kubectl scale deployment kaiban-research-searcher --replicas=8

# The HPA will auto-scale between 2-8 replicas based on CPU
```

## Pipeline Stages

### Stage 1 — Fan-Out: Parallel Search

The orchestrator splits the query into N sub-topics (angles) and publishes N search tasks simultaneously to the `kaiban-agents-searcher` queue. All competing searcher nodes race to pick up jobs — no coordination needed.

Sub-topic angles:
1. Current state and recent breakthroughs
2. Key challenges and limitations
3. Industry applications and real-world use cases
4. Ethical implications and governance concerns
5. Future predictions and research directions
6. Economic impact and market trends
7. Technical architecture and infrastructure
8. Regulatory landscape and compliance

### Stage 2 — Fan-In: Writer Aggregation

Atlas (Writer) receives all successful search results in a single task and synthesises them into a comprehensive Markdown research report (800-1200 words). Partial failures are tolerated — if 3/4 searchers succeed, the writer proceeds with the available data.

### Stage 3 — Governance Review

Sage (Reviewer) checks the report against:
- IEEE AI 7000
- EU AI Act
- GDPR
- OWASP AI Security Top 10
- NIST AI RMF

Produces a structured compliance report with score and `APPROVED / CONDITIONAL / REJECTED` recommendation. If `REJECTED`, the workflow stops immediately.

### Stage 4 — HITL: Editorial Review

Morgan (Editor) performs a final editorial review and produces a `PUBLISH / REVISE / REJECT` recommendation.

### Stage 5 — Human-on-the-Loop Decision

The orchestrator pauses and prompts the human operator:

```
Options:
  [1] PUBLISH — accept and finalise
  [2] REVISE  — send back to writer with notes
  [3] REJECT  — discard
  [4] VIEW    — show full report
```

## ResearchContext Schema

The `ResearchContext` object is the "message" passed between actors. It is fully serializable to JSON for Redis/Kafka transport:

```typescript
interface ResearchContext {
  id: string;                    // UUID — unique per research run
  originalQuery: string;         // The user's original research question
  status: ResearchStatus;        // Lifecycle state machine
  rawSearchData: SearchResult[]; // Collected from all searchers (fan-in)
  consolidatedDraft?: string;    // Writer's synthesised report
  feedback?: ReviewFeedback;     // Reviewer's governance assessment
  editorApproval: boolean;       // Final human approval flag
  metadata: {
    totalTokens: number;         // LLM token usage (economics)
    estimatedCost: number;       // Estimated USD cost
    startTime: number;           // Unix timestamp (ms) — set when workflow starts
    endTime?: number;            // Unix timestamp (ms) — set on completion/stop
    activeNodes: string[];       // IDs of nodes that processed this context
  };
}
```

## Running Tests

```bash
# Unit tests
npm test

# E2E test for this example (requires Redis running)
npm run test:e2e -- --reporter=verbose global-research

# All E2E tests (requires running services)
npm run test:e2e
```
