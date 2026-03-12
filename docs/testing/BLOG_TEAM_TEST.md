# Blog Team — Complete End-to-End Test Guide

> Tests the full distributed pipeline: **Ava (Researcher) → Kai (Writer) → Morgan (Editor) → Human (HITL)**
> Includes visual verification via the live board UI and the kaiban-board component.

---

## Prerequisites

| Tool | Minimum version | Check |
|------|-----------------|-------|
| Node.js | 22 | `node --version` |
| Docker | 24 | `docker --version` |
| Docker Compose | v2 | `docker compose version` |
| OpenAI API key | — | Must be in `.env` |

---

## 1. Environment Setup

```bash
cd /path/to/kaiban-distributed

# Copy env file and add your API key
cp .env.example .env
# Edit .env and set:
#   OPENAI_API_KEY=sk-...
#   (all other defaults are fine for local testing)

# Build the Docker image (from repo root)
npm run build            # compile TypeScript → dist/
docker compose build     # build Docker image
```

---

## 2. Start All Services

```bash
# Start the three-agent blog pipeline
cd examples/blog-team
OPENAI_API_KEY=sk-... docker compose up
```

**Expected startup output:**

```
kaiban-distributed-redis-1       | Ready to accept connections tcp
kaiban-distributed-gateway-1    | [kaiban-worker] Listening on port 3000
kaiban-distributed-gateway-1    | [kaiban-worker] Agents: gateway
kaiban-distributed-researcher-1 | [Researcher] Node started — subscribed to: kaiban-agents-researcher
kaiban-distributed-writer-1     | [Writer] Node started — subscribed to: kaiban-agents-writer
kaiban-distributed-editor-1     | [Editor] Morgan started — subscribed to: kaiban-agents-editor
```

**Verify all services are healthy:**

```bash
# From another terminal (repo root)
docker compose -f examples/blog-team/docker-compose.yml ps
```

Expected:
```
NAME                             STATUS
blog-team-redis-1                Up (healthy)
blog-team-gateway-1              Up (healthy)
blog-team-researcher-1           Up
blog-team-writer-1               Up
blog-team-editor-1               Up
```

---

## 3. Health Check Verification

```bash
# Gateway health
curl http://localhost:3000/health
# Expected: {"data":{"status":"ok","timestamp":"..."},"meta":{},"errors":[]}

# Agent card
curl http://localhost:3000/.well-known/agent-card.json
# Expected: {"name":"kaiban-gateway","version":"1.0.0","capabilities":["tasks.create","tasks.get","agent.status"],...}

# Agent status via A2A
curl -X POST http://localhost:3000/a2a/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"agent.status"}'
# Expected: {"jsonrpc":"2.0","id":1,"result":{"status":"IDLE","agentId":"kaiban-gateway"}}
```

---

## 4. Open the Live Board UI

**Option A — Standalone HTML viewer (no install needed):**

```bash
# Open in browser (macOS)
open examples/blog-team/viewer/board.html

# Or on Linux
xdg-open examples/blog-team/viewer/board.html

# Or navigate to: file:///path/to/kaiban-distributed/examples/blog-team/viewer/board.html
```

You should see the **Live Board** page with:
- `● LIVE` badge (green) — Socket.io connected
- Empty Kanban columns (TODO / DOING / DONE)
- "Waiting for agent state..." in the Agents section

**Note:** If you're running Docker on a remote host, open with the gateway URL:
```
file:///path/to/board.html?gateway=http://YOUR_SERVER_IP:3000
```

**Option B — kaiban-board (React component, full UI):**

See [Section 7 — kaiban-board Integration](#7-kaiban-board-integration) for instructions.

---

## 5. Run the Full Pipeline

In a new terminal, launch the orchestrator — choose one approach:

**Option A — local** (requires Node.js + `npm install`):
```bash
GATEWAY_URL=http://localhost:3000 \
REDIS_URL=redis://localhost:6379 \
TOPIC="Large Language Models in 2025: Capabilities and Limitations" \
  npx ts-node examples/blog-team/orchestrator.ts
```

**Option B — fully containerised** (no local Node.js deps required):
```bash
docker compose -f examples/blog-team/docker-compose.yml run --rm \
  -e TOPIC="Large Language Models in 2025: Capabilities and Limitations" orchestrator
```

Or via the wrapper script:
```bash
TOPIC="Large Language Models in 2025: Capabilities and Limitations" \
  ./scripts/blog-team.sh start --docker
```

**Expected console flow:**

```
════════════════════════════════════════════════════════════
 KAIBAN DISTRIBUTED — BLOG TEAM ORCHESTRATOR
════════════════════════════════════════════════════════════

✓ Gateway: OK at http://localhost:3000
✓ Agent:   kaiban-gateway — [tasks.create, tasks.get, agent.status]

📋 Topic: "Large Language Models in 2025: Capabilities and Limitations"

────────────────────────────────────────────────────────────
STEP 1 — Ava (Researcher) is gathering information...
────────────────────────────────────────────────────────────
  ↳ Task queued: task-1710000001000
  ↳ Waiting up to 45s for research...
```

**On the Live Board, you should see:**
- Ava's agent status change: `IDLE → THINKING → EXECUTING`
- A new task card appear in the DOING column

---

## 6. Watch Each Stage Complete

### Stage 1 — Research Complete

**Console output:**

```
✅ RESEARCH COMPLETE
────────────────────────────────────────────────────────────
[Research summary appears here — first 600 chars]
...
────────────────────────────────────────────────────────────
```

**Live Board:** Research task moves from `DOING → DONE`. Ava's status returns to `IDLE`.

---

### Stage 2 — Writing Complete

**Console output:**

```
STEP 2 — Kai (Writer) is drafting the blog post...
  ↳ Task queued: task-1710000002000
  ↳ Waiting up to 60s for draft...

✅ DRAFT COMPLETE
────────────────────────────────────────────────────────────
# Large Language Models in 2025: Capabilities and Limitations

## Introduction
...
```

**Live Board:** Writer task in DOING → DONE. Kai returns to IDLE.

---

### Stage 3 — Editorial Review (Morgan)

**Console output:**

```
STEP 3 — Morgan (Editor) is reviewing for accuracy...
  ↳ Task queued: task-1710000003000
  ↳ Waiting up to 45s for editorial review...
```

**Live Board:** Editor task in DOING, Morgan's status shows THINKING/EXECUTING.

After Morgan finishes, the review appears in a formatted box:

```
╔══════════════════════════════════════════════════════════╗
║  📝 EDITORIAL REVIEW BY MORGAN                          ║
╠══════════════════════════════════════════════════════════╣
║  ## EDITORIAL REVIEW                                    ║
║                                                          ║
║  **Topic:** LLMs in 2025                                 ║
║  **Accuracy Score:** 8.5/10                             ║
║                                                          ║
║  ### Factual Assessment                                  ║
║  Post is largely accurate with some minor issues.       ║
║                                                          ║
║  ### Issues Found                                        ║
║  - GPT-4 release date needs verification — Severity: LOW║
║                                                          ║
║  ### Recommendation: PUBLISH                             ║
╚══════════════════════════════════════════════════════════╝

  Accuracy Score:  8.5/10
  Recommendation:  PUBLISH
```

---

### Stage 4 — HITL Decision

**Console output:**

```
════════════════════════════════════════════════════════════
 HUMAN REVIEW REQUIRED (HITL)
════════════════════════════════════════════════════════════

🟢 Editor recommends PUBLISH (Accuracy: 8.5/10)

Options:
  [1] PUBLISH — Accept the post as-is and publish
  [2] REVISE  — Send back to writer with editor notes
  [3] REJECT  — Discard this post entirely
  [4] VIEW    — View full blog draft before deciding

Your decision [1/2/3/4]:
```

**Test each decision path:**

#### Path A — PUBLISH (type `1`)

```
╔══════════════════════════════════════════════════════════╗
║  🚀 PUBLISHED — FINAL BLOG POST                          ║
╠══════════════════════════════════════════════════════════╣
║  # Large Language Models in 2025                        ║
║  ...                                                     ║
╚══════════════════════════════════════════════════════════╝

✅ Blog post published. Accuracy score: 8.5/10
```

#### Path B — REVISE (type `2`)

```
🔄 Sending back to writer with editorial notes...
  ↳ Revision task queued: task-1710000004000
  ↳ Waiting up to 60s for revised draft...
[Revised draft appears]
Publish the revised draft? [y/n]:
```

#### Path C — REJECT (type `3`)

```
🗑  Post rejected and discarded.
Reason from editorial review:
[Morgan's rationale appears]
```

#### Path D — VIEW then decide (type `4`, then `1`)

```
─── FULL BLOG DRAFT ──────────────────────────────────────
[Full markdown blog post printed]
───────────────────────────────────────────────────────────

Your decision [1/2/3/4]: 1
```

---

## 7. kaiban-board Integration

[kaiban-board](https://github.com/kaiban-ai/kaiban-board) is a React component that shows a full Kanban UI. To use it with the distributed backend:

### 7a. Run kaiban-board locally

```bash
cd /path/to/kaiban-board

# Install dependencies
npm install

# Copy env file
cp .env.example .env.local
# Add: VITE_OPENAI_API_KEY=sk-...

# Start dev server (port 5173)
npm run dev
```

Open `http://localhost:5173` in your browser — the kaiban-board UI appears.

### 7b. Use KaibanTeamBridge for distributed state in kaiban-board

Create a new kaiban-board team definition that uses the distributed workers:

```javascript
// In kaiban-board's code editor, paste this team definition:
const { Agent, Task, Team } = require('kaibanjs');

// These must match your running worker nodes
const ava = new Agent({
  name: 'Ava',
  role: 'News Researcher',
  goal: 'Research and summarize information on given topics',
  background: 'Expert researcher with deep knowledge of AI topics',
});

const kai = new Agent({
  name: 'Kai',
  role: 'Content Creator',
  goal: 'Create engaging blog posts based on research',
  background: 'Skilled technical writer',
});

const morgan = new Agent({
  name: 'Morgan',
  role: 'Editorial Fact-Checker',
  goal: 'Verify accuracy and recommend PUBLISH/REVISE/REJECT',
  background: 'Senior editor with 15 years of experience',
});

const researchTask = new Task({
  title: 'Research Phase',
  description: 'Research the latest developments on: {topic}',
  expectedOutput: 'Detailed research summary with key facts',
  agent: ava,
});

const writeTask = new Task({
  title: 'Writing Phase',
  description: 'Write a blog post about: {topic}',
  expectedOutput: 'Markdown blog post 500-800 words',
  agent: kai,
  dependencies: [researchTask],
});

const editTask = new Task({
  title: 'Editorial Review',
  description: 'Review the blog post for accuracy',
  expectedOutput: 'Structured editorial review with PUBLISH/REVISE/REJECT recommendation',
  agent: morgan,
  dependencies: [writeTask],
});

const blogTeam = new Team({
  name: 'Distributed Blog Team',
  agents: [ava, kai, morgan],
  tasks: [researchTask, writeTask, editTask],
  env: { OPENAI_API_KEY: 'your-key-here' },
});

// Start the workflow
blogTeam.start({ topic: 'AI agents in 2025' });
```

This runs a **local** KaibanJS team. For connecting it to the distributed workers:

### 7c. Bridge kaiban-board to distributed backend

```typescript
// In a Node.js bridge script (examples/blog-team/kaiban-board-bridge.ts):
import { Agent, Task } from 'kaibanjs';
import { BullMQDriver } from '../../src/infrastructure/messaging/bullmq-driver';
import { KaibanTeamBridge } from '../../src/infrastructure/kaibanjs/kaiban-team-bridge';

const REDIS_URL = 'redis://localhost:6379';
const redisUrl = new URL(REDIS_URL);

const ava = new Agent({ name: 'Ava', role: 'News Researcher', goal: '...', background: '...' });
const kai = new Agent({ name: 'Kai', role: 'Content Creator', goal: '...', background: '...' });
const morgan = new Agent({ name: 'Morgan', role: 'Editorial Fact-Checker', goal: '...', background: '...' });

const driver = new BullMQDriver({
  connection: { host: redisUrl.hostname, port: 6379 },
});

// KaibanTeamBridge attaches DistributedStateMiddleware to the Team's Zustand store.
// Every state change from distributed workers propagates via Redis Pub/Sub
// → SocketGateway → socket.io → Live Board.
const bridge = new KaibanTeamBridge({
  name: 'Distributed Blog Team',
  agents: [ava, kai, morgan],
  tasks: [],  // tasks are dispatched via A2A, not local execution
}, driver, 'kaiban-state-events');

const team = bridge.getTeam();

// Subscribe to state changes for logging
bridge.subscribeToChanges((changes) => {
  console.log('[Bridge] State update:', JSON.stringify(changes).slice(0, 200));
}, ['teamWorkflowStatus', 'workflowResult']);

// Pass `team` to kaiban-board:
// <KaibanBoard teams={[{ title: 'Blog Team', code: teamDefinitionCode }]} />
```

### 7d. Live board captures all state

Once the bridge is running:
1. The Live Board (`board.html`) shows real-time Kanban updates via Socket.io
2. kaiban-board shows the team structure and task definitions
3. Both UIs update in real-time as distributed workers process tasks

---

## 8. Automated Test Verification

Run the full automated test suite to verify all flows:

```bash
# Unit tests (113 tests, 100% coverage)
npm run test:coverage

# BullMQ E2E (requires Docker)
npm run test:e2e

# Kafka E2E (requires Docker + Kafka stack)
npm run test:e2e:kafka
```

Expected output:

```
Test Files  14 passed (14)
Tests       113 passed (113)
All files   | 100% | 100% | 100% | 100% |

# E2E BullMQ: 7/7 passing
# E2E Kafka:  2/2 passing
```

---

## 9. Common Issues

| Problem | Cause | Fix |
|---------|-------|-----|
| `board.html` shows "Error" badge | Socket.io CORS or gateway not running | Verify `docker compose up` shows gateway healthy; check `GATEWAY_URL` param |
| Orchestrator times out | LLM API key missing/invalid or rate limit | Check `OPENAI_API_KEY` in `.env`; increase `RESEARCH_WAIT_MS` env var |
| Redis connection error | Redis not running | Run `docker compose up -d redis` |
| `Queue name cannot contain ':'` | Old queue name format | This is fixed — all queue names use dashes. Run `npm run build` and restart. |
| Agent stuck in THINKING | LLM max iterations reached | Check `maxIterations` in `team-config.ts`; check OpenAI API status |
| Morgan always REJECTs | Agent prompt tuning | Adjust `editorConfig.goal` in `team-config.ts` |

---

## 10. Performance Benchmarks

With `gpt-4o-mini` (faster, cheaper):

| Stage | Expected Duration |
|-------|------------------|
| Research (Ava) | 15–45 seconds |
| Writing (Kai) | 20–60 seconds |
| Editorial review (Morgan) | 15–45 seconds |
| Full pipeline | 50–150 seconds |
| HITL decision | Human-dependent |

With `gpt-4o` (higher quality):

| Stage | Expected Duration |
|-------|------------------|
| Research | 30–90 seconds |
| Writing | 45–120 seconds |
| Editorial | 30–60 seconds |
| Full pipeline | 2–5 minutes |

Set the model in agent configs via `llmConfig`:
```typescript
export const researcherConfig: KaibanAgentConfig = {
  name: 'Ava',
  // ...
  llmConfig: { provider: 'openai', model: 'gpt-4o-mini' },
};
```
