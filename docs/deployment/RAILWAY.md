# Railway Deployment Guide

> Deploy the full kaiban-distributed blog team pipeline to Railway.app — four services (gateway + researcher + writer + editor) + managed Redis.

---

## Overview

Railway.app runs each Node.js service as a separate Docker container. All services share the same GitHub repository but start with different commands. Redis is provided as a Railway plugin.

```
Railway Project
├── Service: gateway     → port 3000 (public, HTTP + Socket.io)
├── Service: researcher  → internal (BullMQ worker)
├── Service: writer      → internal (BullMQ worker)
├── Service: editor      → internal (BullMQ worker)
└── Plugin:  Redis       → internal (shared by all services)
```

---

## Prerequisites

1. [Railway account](https://railway.app) (free tier works for testing)
2. Railway CLI: `npm install -g @railway/cli` and `railway login`
3. GitHub repository with this codebase pushed to `main`
4. OpenAI API key

---

## Step 1 — Create Railway Project

```bash
# In the repo root
railway init

# Or via Railway dashboard:
# 1. Go to https://railway.app/dashboard
# 2. Click "New Project" → "Deploy from GitHub repo"
# 3. Select your kaiban-distributed repository
```

---

## Step 2 — Add Redis Plugin

In the Railway dashboard for your project:

1. Click **"+ New"** → **"Database"** → **"Add Redis"**
2. Railway provisions a managed Redis instance
3. The `REDIS_URL` environment variable is automatically set for all services in the project
   - Format: `redis://default:{password}@{host}:{port}`

Verify via Railway CLI:
```bash
railway variables | grep REDIS_URL
```

---

## Step 3 — Deploy the Gateway Service

The gateway is the main public-facing service. It handles HTTP requests and Socket.io connections.

**Via Railway CLI:**
```bash
railway up --service gateway
```

**Via dashboard:**
1. Go to your project → select the GitHub service
2. In **Settings → Start Command**, set:
   ```
   node dist/src/main/index.js
   ```
3. In **Settings → Build Command**, set:
   ```
   npm ci && npm run build
   ```
4. Set the **Port** to `3000` in **Settings → Networking**

**Environment variables for gateway service:**
```
AGENT_IDS=gateway
MESSAGING_DRIVER=bullmq
PORT=3000
SERVICE_NAME=kaiban-gateway
# REDIS_URL is set automatically by the Redis plugin
# OTEL_EXPORTER_OTLP_ENDPOINT=https://your-otel-endpoint (optional)
```

---

## Step 4 — Deploy Worker Services

Each agent worker runs as a separate Railway service using the **same Docker image** but a different start command.

### 4a. Researcher Service (Ava)

In Railway dashboard → **+ New Service** → **"GitHub Repo"** (same repo):

| Setting | Value |
|---------|-------|
| Name | `researcher` |
| Start Command | `node dist/examples/blog-team/researcher-node.js` |
| Build Command | `npm ci && npm run build` |
| Root Directory | `/` (repo root) |
| Public Networking | Disabled (internal only) |

**Environment variables:**
```
REDIS_URL=${{Redis.REDIS_URL}}    # Auto-filled by Railway
OPENAI_API_KEY=sk-...             # Your API key
```

### 4b. Writer Service (Kai)

| Setting | Value |
|---------|-------|
| Name | `writer` |
| Start Command | `node dist/examples/blog-team/writer-node.js` |
| Environment variables | Same as researcher |

### 4c. Editor Service (Morgan)

| Setting | Value |
|---------|-------|
| Name | `editor` |
| Start Command | `node dist/examples/blog-team/editor-node.js` |
| Environment variables | Same as researcher |

---

## Step 5 — Railway Configuration File

Create `railway.toml` in the repository root for repeatable deployments:

```toml
# railway.toml — kaiban-distributed deployment config

[build]
builder = "dockerfile"
dockerfilePath = "Dockerfile"

[deploy]
healthcheckPath = "/health"
healthcheckTimeout = 100
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 10
```

**Per-service overrides** — Railway reads a `railway.json` to configure multiple services from one repo. Create `railway.json`:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "services": [
    {
      "name": "gateway",
      "startCommand": "node dist/src/main/index.js",
      "healthcheckPath": "/health",
      "port": 3000
    },
    {
      "name": "researcher",
      "startCommand": "node dist/examples/blog-team/researcher-node.js"
    },
    {
      "name": "writer",
      "startCommand": "node dist/examples/blog-team/writer-node.js"
    },
    {
      "name": "editor",
      "startCommand": "node dist/examples/blog-team/editor-node.js"
    }
  ]
}
```

---

## Step 6 — Environment Variables Reference

Set these in Railway **Project → Variables** (shared across all services) or per-service:

### Shared Variables (set at project level)

| Variable | Value | Notes |
|----------|-------|-------|
| `OPENAI_API_KEY` | `sk-...` | Required for real agent execution |
| `OPENROUTER_API_KEY` | `sk-or-v1-...` | Optional: OpenRouter alternative LLM access |
| `OPENAI_BASE_URL` | `https://openrouter.ai/api/v1` | Optional: override base URL for OpenRouter/local LLMs |
| `MESSAGING_DRIVER` | `bullmq` | Use `bullmq` for Railway (Redis available) |
| `LLM_MODEL` | `gpt-4o-mini` | LLM model name (default: `gpt-4o-mini`) |
| `SERVICE_NAME` | `kaiban-distributed` | Used in telemetry |

### Auto-Provisioned (Railway sets these)

| Variable | Source | Notes |
|----------|--------|-------|
| `REDIS_URL` | Redis plugin | Set automatically when Redis plugin is added |
| `RAILWAY_ENVIRONMENT` | Railway | `production`, `staging`, `development` |
| `RAILWAY_PUBLIC_DOMAIN` | Railway | Your app's public URL |

### Gateway-Only Variables

| Variable | Value | Notes |
|----------|-------|-------|
| `AGENT_IDS` | `gateway` | The gateway service itself doesn't run agents |
| `PORT` | `3000` | Gateway HTTP port |

### Worker-Only Variables

| Variable | Value | Notes |
|----------|-------|-------|
| `AGENT_IDS` | _(not required for workers using example scripts)_ | Worker scripts use hardcoded agent IDs |

### Optional Observability

| Variable | Value | Notes |
|----------|-------|-------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `https://api.honeycomb.io/v1/traces` | Any OTLP endpoint |

---

## Step 7 — Expose the Gateway

In Railway dashboard → Gateway service → **Networking → Generate Domain**:

```
https://kaiban-gateway-production-xxxx.up.railway.app
```

This is your public `GATEWAY_URL`. The Socket.io endpoint is the same URL.

---

## Step 8 — Run the Orchestrator Against Railway

```bash
# Set your Railway gateway URL
export GATEWAY_URL=https://kaiban-gateway-production-xxxx.up.railway.app
export TOPIC="The Future of AI Agents"

npx ts-node examples/blog-team/orchestrator.ts
```

---

## Step 9 — View the Live Board

Open the board viewer with the Railway gateway URL:

```
file:///path/to/examples/blog-team/viewer/board.html?gateway=https://kaiban-gateway-production-xxxx.up.railway.app
```

Or host the `board.html` file on any static hosting (Netlify, Vercel, Railway static) and pass `?gateway=YOUR_URL`.

---

## Step 10 — Scale Workers

Railway makes it easy to scale workers horizontally:

```bash
# Scale to 3 writer nodes (all subscribe to the same BullMQ queue)
railway scale writer --instances=3
```

Or in the dashboard: **Writer service → Settings → Instances → 3**.

All writer instances share the same `kaiban-agents-writer` BullMQ queue — BullMQ automatically distributes tasks across available workers.

---

## Dockerfile for Railway

Railway uses our existing `Dockerfile` at the repo root:

```dockerfile
# Stage 1: Build TypeScript
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src/ ./src/
COPY examples/ ./examples/        # ← Important: include examples for worker scripts
RUN npm run build

# Stage 2: Production runtime
FROM node:22-alpine AS runner
WORKDIR /app
RUN addgroup -S kaiban && adduser -S kaiban -G kaiban
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
USER kaiban
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/src/main/index.js"]
```

> **Note:** The Dockerfile already copies `examples/` in the builder stage, so `dist/examples/blog-team/researcher-node.js` etc. are available for worker services. The build output lands under `dist/src/` (for `src/`) and `dist/examples/` (for `examples/`).

---

## Complete `railway.toml`

```toml
# railway.toml

[build]
builder = "dockerfile"
dockerfilePath = "Dockerfile"

[deploy]
healthcheckPath = "/health"
healthcheckTimeout = 100
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 10

# Default start command (gateway)
startCommand = "node dist/src/main/index.js"
```

---

## Deployment Architecture on Railway

```
Railway Project: kaiban-distributed
│
├── 🔴 Redis Plugin (managed)
│   └── REDIS_URL → shared across all services
│
├── 🌐 gateway (public, port 3000)
│   ├── HTTP: /health, /.well-known/agent-card.json, /a2a/rpc
│   ├── WebSocket: Socket.io (state:update events)
│   └── CMD: node dist/src/main/index.js
│
├── 🤖 researcher (internal, Ava)
│   ├── Subscribes: kaiban-agents-researcher (BullMQ)
│   └── CMD: node dist/examples/blog-team/researcher-node.js
│
├── ✍️  writer (internal, Kai)
│   ├── Subscribes: kaiban-agents-writer (BullMQ)
│   └── CMD: node dist/examples/blog-team/writer-node.js
│
└── 📝 editor (internal, Morgan)
    ├── Subscribes: kaiban-agents-editor (BullMQ)
    └── CMD: node dist/examples/blog-team/editor-node.js
```

---

## Cost Estimate (Railway pricing, approximate)

| Resource | Plan | Monthly cost |
|----------|------|-------------|
| Gateway service | Hobby ($5/mo) | ~$5 |
| Researcher worker | Hobby ($5/mo) | ~$5 |
| Writer worker | Hobby ($5/mo) | ~$5 |
| Editor worker | Hobby ($5/mo) | ~$5 |
| Redis plugin | Managed ($10/mo) | ~$10 |
| **Total** | | **~$30/month** |

For development/testing, Railway's **free tier** provides $5 credit/month which is enough to test the pipeline.

---

## Troubleshooting

### Service keeps restarting

```bash
railway logs --service researcher
```

Common causes:
- `REDIS_URL` not set → add Redis plugin
- `OPENAI_API_KEY` missing → add to project variables
- `AGENT_IDS` not set for gateway → add `AGENT_IDS=gateway`

### Socket.io connection fails from browser

Railway domains use HTTPS. Ensure your Socket.io client uses `wss://` (automatic when using `https://` URL):

```javascript
const socket = io('https://kaiban-gateway-production-xxxx.up.railway.app', {
  transports: ['websocket', 'polling'],
});
```

The `board.html` viewer handles this automatically.

### Workers not picking up tasks

1. Verify Redis plugin is running: `railway status`
2. Check that queue names match exactly (`kaiban-agents-researcher`, no colons)
3. Verify `REDIS_URL` is the same for gateway and all workers (Railway injects this automatically from the Redis plugin)

---

## Quick Deploy Checklist

- [ ] Repository pushed to GitHub
- [ ] Railway project created (`railway init`)
- [ ] Redis plugin added
- [ ] Gateway service deployed (port 3000, `/health` returns 200)
- [ ] `OPENAI_API_KEY` set in Railway project variables
- [ ] Researcher service deployed
- [ ] Writer service deployed
- [ ] Editor service deployed
- [ ] Public domain generated for gateway
- [ ] Live board opens with `● LIVE` status
- [ ] Orchestrator run against Railway URL succeeds end-to-end
