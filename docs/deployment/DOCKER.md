# Local Docker Compose Deployment

> Run the full kaiban-distributed blog team pipeline locally using Docker Compose — no cloud account needed.

Two compose files are provided under `examples/blog-team/`:

| File | Messaging | Use case |
|------|-----------|----------|
| `docker-compose.yml` | BullMQ (Redis) | Default, fastest local setup |
| `docker-compose.kafka.yml` | Kafka | Kafka driver end-to-end testing |

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) or Docker Engine + Compose plugin v2
- `docker compose version` ≥ 2.0
- An `.env` file at the **repo root** with your API keys (see below)

---

## Environment File

Create `.env` in the repo root (it is gitignored):

```bash
# Required for agent LLM calls
OPENAI_API_KEY=sk-...

# Optional alternatives
OPENROUTER_API_KEY=sk-or-v1-...
OPENAI_BASE_URL=https://openrouter.ai/api/v1   # omit to use OpenAI default
LLM_MODEL=gpt-4o-mini                           # default if unset

# Optional topic for the blog pipeline
TOPIC=The Future of AI Agents

# Optional wait times (milliseconds) — defaults shown
RESEARCH_WAIT_MS=120000
WRITE_WAIT_MS=240000
EDIT_WAIT_MS=300000
```

---

## BullMQ Stack (Default)

**Services started:** `redis`, `gateway`, `researcher`, `writer`, `editor`

### Start

```bash
docker compose -f examples/blog-team/docker-compose.yml --env-file .env up -d --build
```

### Run the Orchestrator (local TypeScript)

```bash
GATEWAY_URL=http://localhost:3000 REDIS_URL=redis://localhost:6379 \
TOPIC="The Future of AI Agents" \
npx ts-node examples/blog-team/orchestrator.ts
```

### Run the Orchestrator (fully containerised)

```bash
docker compose -f examples/blog-team/docker-compose.yml run --rm orchestrator
```

> The orchestrator container uses `stdin_open: true` + `tty: true` for Human-in-the-Loop (HITL) readline prompts.

### View the Live Board

Open in your browser:

```
file:///path/to/examples/blog-team/viewer/board.html?gateway=http://localhost:3000
```

### Stop

```bash
docker compose -f examples/blog-team/docker-compose.yml down
```

---

## Kafka Stack

**Services started:** `redis`, `zookeeper`, `kafka`, `gateway`, `researcher`, `writer`, `editor`

### Start

```bash
docker compose -f examples/blog-team/docker-compose.kafka.yml --env-file .env up -d --build
```

Kafka takes ~30–60 s to become healthy. Watch with:

```bash
docker compose -f examples/blog-team/docker-compose.kafka.yml logs -f kafka
```

### Run the Orchestrator (local TypeScript)

```bash
GATEWAY_URL=http://localhost:3000 REDIS_URL=redis://localhost:6379 \
MESSAGING_DRIVER=kafka KAFKA_BROKERS=localhost:9092 \
TOPIC="The Future of AI Agents" \
npx ts-node examples/blog-team/orchestrator.ts
```

### Run the Orchestrator (fully containerised)

```bash
docker compose -f examples/blog-team/docker-compose.kafka.yml run --rm orchestrator
```

### Stop

```bash
docker compose -f examples/blog-team/docker-compose.kafka.yml down
```

---

## Service Architecture

### BullMQ stack

```
localhost:3000  ──►  gateway   (HTTP + Socket.io)
                         │
                    redis:6379  (BullMQ queues)
                         │
               ┌─────────┼─────────┐
          researcher   writer   editor
```

### Kafka stack

```
localhost:3000  ──►  gateway   (HTTP + Socket.io)
                    /        \
             redis:6379    kafka:29092  (internal inter-broker)
           (state store)   kafka:9092  (host-accessible)
                               │
               ┌───────────────┼───────────────┐
          researcher         writer         editor
```

> Containers connect to Kafka via `kafka:29092` (internal listener). The host connects via `localhost:9092` (external listener).

---

## Environment Variables Reference

### All worker services (researcher, writer, editor)

| Variable | Default | Notes |
|----------|---------|-------|
| `REDIS_URL` | `redis://redis:6379` | Set automatically in compose |
| `OPENAI_API_KEY` | — | Required |
| `OPENROUTER_API_KEY` | — | Optional |
| `OPENAI_BASE_URL` | — | Optional, for OpenRouter / local LLMs |
| `LLM_MODEL` | `gpt-4o-mini` | Any model supported by your provider |
| `MESSAGING_DRIVER` | `bullmq` | `bullmq` or `kafka` |
| `KAFKA_BROKERS` | `localhost:9092` (host) / `kafka:29092` (Docker Compose) | Kafka only |
| `KAFKA_CLIENT_ID` | per-service name | Kafka only |
| `KAFKA_GROUP_ID` | `kaiban-group` | Kafka only |
| `SEMANTIC_FIREWALL_ENABLED` | `false` | BullMQ stack only |
| `CIRCUIT_BREAKER_ENABLED` | `false` | BullMQ stack only |
| `JIT_TOKENS_ENABLED` | `false` | BullMQ stack only |
| `CIRCUIT_BREAKER_THRESHOLD` | `10` | BullMQ stack only |
| `CIRCUIT_BREAKER_WINDOW_MS` | `60000` | BullMQ stack only |

### Gateway service

| Variable | Value | Notes |
|----------|-------|-------|
| `AGENT_IDS` | `gateway` | Fixed |
| `PORT` | `3000` | HTTP port |
| `SERVICE_NAME` | `kaiban-gateway` | Telemetry label |

---

## Troubleshooting

### `port is already allocated` error

Something is already using port 6379 or 9092. Stop conflicting services:

```bash
# Find what's using a port
sudo lsof -i :6379
sudo lsof -i :9092
```

### Workers not processing tasks

```bash
docker compose -f examples/blog-team/docker-compose.yml logs researcher
```

Verify `OPENAI_API_KEY` is set and Redis is healthy:

```bash
docker compose -f examples/blog-team/docker-compose.yml ps
```

### Kafka health check takes too long

The Kafka healthcheck has a 30 s start period and 15 retries (up to ~3.5 min total). This is normal for `cp-kafka:7.6.0`. Wait for:

```
kaiban-distributed-kafka-1  healthy
```

### Rebuild after source changes

```bash
docker compose -f examples/blog-team/docker-compose.yml up -d --build
```
