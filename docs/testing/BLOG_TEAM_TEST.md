# Blog Team — Complete End-to-End Test Guide

> Tests the full distributed pipeline: **Ava (Researcher) → Kai (Writer) → Morgan (Editor) → Human (HITL)**
> Includes visual verification via the live board UI and the React board in `board/`.
>
> For starting and stopping the example, and for its environment variables, [EXAMPLES.md](../../EXAMPLES.md) (Example 1) is the single home. This guide keeps the stage-by-stage expectations and the pass criteria.

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
# Start the three-agent blog pipeline (from the repo root, so that Compose reads the key from .env)
docker compose -f examples/blog-team/docker-compose.yml --env-file .env up
```

**Pass criteria:** the five services below are up and the gateway answers `/health`.

**Expected startup output:**

```
blog-team-redis-1       | Ready to accept connections tcp
blog-team-gateway-1     | {"level":30,...,"service":"kaiban-gateway","port":3000,"msg":"Gateway listening (HTTP/WebSocket/A2A)"}
blog-team-researcher-1  | {"level":30,...,"label":"[Researcher]","agent":"Ava","queue":"kaiban-agents-researcher","msg":"Agent node started"}
blog-team-writer-1      | {"level":30,...,"label":"[Writer]","agent":"Kai","queue":"kaiban-agents-writer","msg":"Agent node started"}
blog-team-editor-1      | {"level":30,...,"label":"[Editor]","agent":"Morgan","queue":"kaiban-agents-editor","msg":"Agent node started"}
```

Logs are JSON lines; set `LOG_PRETTY=true` for readable output.

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

# Agent card (A2A v0.3 — `capabilities` is an object; abilities are in `skills[]`)
curl http://localhost:3000/.well-known/agent-card.json
# Expected (v0.3): {"protocolVersion":"0.3.0","name":"kaiban-gateway",...,"capabilities":{"streaming":true,...},"skills":[{"id":"researcher","name":"Delegate to researcher",...},{"id":"writer",...},{"id":"editor",...}]}
# (one skill per id in the gateway's AGENT_IDS; the compose file sets AGENT_IDS=researcher,writer,editor)

# Agent status (A2A v0.3 — now a REST endpoint, not a JSON-RPC method)
curl http://localhost:3000/a2a/agents/researcher/status
# Expected: {"data":{"agentId":"researcher","status":"IDLE",...},...}
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
- Empty Kanban columns (TODO / DOING / AWAITING / DONE / BLOCKED)
- "Waiting for agent state..." in the Agents section

**Note:** If you're running Docker on a remote host, open with the gateway URL:
```
file:///path/to/board.html?gateway=http://YOUR_SERVER_IP:3000
```

**Option B — kaiban-board (React component, full UI):**

See [Section 7 — The React board](#7-the-react-board) for instructions.

---

## 5. Run the Full Pipeline

In a new terminal, launch the orchestrator — choose one approach:

**Option A — local** (requires Node.js + `npm ci`):
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

**Expected console flow.** The text below is a sketch; wording and decoration differ from the real output. What to check is the order of the four steps (the real output starts with `KAIBAN DISTRIBUTED — BLOG TEAM ORCHESTRATOR`, then `Gateway: OK at <url>`, `Agent: ...`, `Topic: ... | Workflow: <id>`, then `STEP 1` to `STEP 3`).

```
════════════════════════════════════════════════════════════
 KAIBAN DISTRIBUTED — BLOG TEAM ORCHESTRATOR
════════════════════════════════════════════════════════════

✓ Gateway: OK at http://localhost:3000
✓ Agent:   kaiban-gateway — [Delegate to researcher, Delegate to writer, Delegate to editor]

📋 Topic: "Large Language Models in 2025: Capabilities and Limitations"

────────────────────────────────────────────────────────────
STEP 1 — Ava (Researcher) is gathering information...
────────────────────────────────────────────────────────────
  ↳ Task queued: task-1710000001000
  ↳ Waiting up to 120s for research...
```

**Pass criteria:** the console prints `STEP 1` and the Live Board shows Ava working.

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

**Pass criteria:** a research summary is printed and the research card is in DONE.

---

### Stage 2 — Writing Complete

**Console output:**

```
STEP 2 — Kai (Writer) is drafting the blog post...
  ↳ Task queued: task-1710000002000
  ↳ Waiting up to 240s for draft...

✅ DRAFT COMPLETE
────────────────────────────────────────────────────────────
# Large Language Models in 2025: Capabilities and Limitations

## Introduction
...
```

**Live Board:** Writer task in DOING → DONE. Kai returns to IDLE.

**Pass criteria:** a Markdown draft is printed and the writer card is in DONE.

---

### Stage 3 — Editorial Review (Morgan)

**Console output:**

```
STEP 3 — Morgan (Editor) is reviewing for accuracy...
  ↳ Task queued: task-1710000003000
  ↳ Waiting up to 300s for editorial review...
```

**Live Board:** Editor task in DOING, Morgan's status shows THINKING/EXECUTING.

**Pass criteria:** the console prints an `Accuracy Score:` and a `Recommendation:` of PUBLISH, REVISE or REJECT.

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

The decision can also be given on the React board (PUBLISH / REVISE / REJECT buttons, section 7); the first valid decision wins.

**Pass criteria:** each path below ends the run as described, and the board shows the matching final state (REJECT shows the task as stopped in the Blocked column).

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
  ↳ Waiting up to 240s for revised draft...
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

## 7. The React board

This repository ships its own React board in `board/` (it is not the external kaiban-board project).

```bash
cd board && npm ci && VITE_BOARD_TOKEN=<token, if the gateway sets BOARD_JWT_SECRET> npm run dev
```

Open http://localhost:5173. The task cards, the HITL buttons (PUBLISH / REVISE / REJECT) and, with `CONTROL_PLANE_ENABLED=true`, the STOP ALL button appear. See [EXAMPLES.md](../../EXAMPLES.md), Example 7, and [board/README.md](../../board/README.md).

**Pass criteria:** the board connects to the gateway and shows the same task cards as the standalone viewer.

---

## 8. Automated Test Verification

Run the full automated test suite to verify all flows:

```bash
# Unit tests (100% coverage required; the current count is in the README testing table)
npm run test:coverage

# BullMQ E2E (requires Docker)
npm run test:e2e

# Kafka E2E (requires Docker + Kafka stack)
npm run test:e2e:kafka
```

Expected output:

```
Test Files  <n> passed (<n>)
Tests       <n> passed (<n>)
All files   | 100% | 100% | 100% | 100% |

# E2E BullMQ and Kafka: all passing (counts in the README testing table)
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

---

## 11. STOP ALL (control plane)

Start the stack with `CONTROL_PLANE_ENABLED=true` and `BOARD_JWT_SECRET` set (and `CHANNEL_SIGNING_SECRET` in production), as described in [EXAMPLES.md](../../EXAMPLES.md), section 1H. Start a run, then press STOP ALL on the React board or the viewer while Ava or Kai is working.

**Pass criteria:** the running model call ends at once, the board shows a stop banner with the node acknowledgements and the tasks as stopped, and the orchestrator publishes `STOPPED` and exits with code 2. A new run afterwards completes.

## 12. Resume after a restart

`WORKFLOW_ID` defaults to a value derived from the topic, so a restart with the same topic resumes from the last finished stage instead of paying for it again (`.env.example`, `examples/blog-team/orchestrator.ts`). Set `WORKFLOW_ID` to a new value to force a fresh run.

**Pass criteria:** stop the orchestrator after stage 1, start it again with the same `TOPIC`; stage 1 is not run again.

## 13. Teardown

`./scripts/blog-team.sh start` stops the stack when the orchestrator exits. A stack started by hand with `docker compose ... up` stays up until `docker compose -f examples/blog-team/docker-compose.yml down`.
