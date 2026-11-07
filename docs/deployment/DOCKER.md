# Local Docker Compose Deployment

> Run the full kaiban-distributed blog team pipeline locally using Docker Compose — no cloud account needed.

Five compose stacks ship in the repository:

| File | Messaging | What it starts |
|------|-----------|----------------|
| `docker-compose.yml` (repo root) | Redis; Kafka and Zookeeper also start | One gateway and one generic worker (`ROLE=worker`, agents `researcher,writer`); the stack the Gateway and Worker tables below describe |
| `examples/blog-team/docker-compose.yml` | BullMQ (Redis) | Gateway and the three blog-team workers; default, fastest local setup |
| `examples/blog-team/docker-compose.kafka.yml` | Kafka | The same with Zookeeper and Kafka, for Kafka end-to-end testing |
| `examples/global-research/docker-compose.yml` | BullMQ (Redis) | Gateway, searcher replicas, writer, reviewer, editor |
| `examples/global-research/docker-compose.kafka.yml` | Kafka | The same over Kafka |

The sections below use the blog-team stacks; the global-research stacks are started with `scripts/global-research.sh` (see [EXAMPLES.md](../../EXAMPLES.md)) and take the same variables.

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

Compose does not pass the whole file to the containers: see [Which variables reach the containers](#which-variables-reach-the-containers).

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
| `SEMANTIC_FIREWALL_ENABLED` | `false` | All five stacks |
| `CIRCUIT_BREAKER_ENABLED` | `false` | All five stacks |
| `JIT_TOKENS_ENABLED` | `false` | All five stacks |
| `CIRCUIT_BREAKER_THRESHOLD` | `10` | All five stacks |
| `CIRCUIT_BREAKER_WINDOW_MS` | `60000` | All five stacks |
| `CONTROL_PLANE_ENABLED` | unset (off) | Emergency STOP ALL (2.1.0): set `true` on the gateway, every worker and the orchestrator; the gateway also needs `BOARD_JWT_SECRET` for board/HTTP stops. All compose files pass both through |
| `CHANNEL_SIGNING_SECRET`, `BOARD_JWT_SECRET` | unset | Passed through by every stack (the board secret to the gateway; the root stack's worker gets it too) |
| `MAX_TOKEN_BUDGET`, `MAX_TASK_TOKEN_BUDGET` | `200000`, `50000` | Token caps per agent and per task; every worker service passes them |
| `REDIS_PASSWORD` | unset | Root `docker-compose.yml` only: starts Redis with `--requirepass` and puts the password into the containers' `REDIS_URL`. The example stacks do not read it |

The Gateway and Worker tables below describe the root `docker-compose.yml` (`kaiban-gateway`,
`kaiban-worker`). In `examples/blog-team/docker-compose.yml` the gateway sets no `ROLE` (default
`gateway`) and `AGENT_IDS=researcher,writer,editor`, and each worker runs its own command
(`node dist/examples/blog-team/<agent>-node.js`).

### Gateway service

| Variable | Value | Notes |
|----------|-------|-------|
| `ROLE` | `gateway` | Role for the single image (ADR-013): `gateway` or `worker`. Default `gateway`. |
| `AGENT_IDS` | `researcher,writer` | The agent ids the workers run; the agent card advertises one skill per id |
| `PORT` | `3000` | HTTP port (gateway role only) |
| `SERVICE_NAME` | `kaiban-gateway` | Telemetry label |

### Worker service

| Variable | Value | Notes |
|----------|-------|-------|
| `ROLE` | `worker` | LLM-backed task-consuming agent pool; no HTTP `/health`. |
| `AGENT_IDS` | `researcher,writer` | The agent pool this worker runs |
| `SERVICE_NAME` | `kaiban-worker` | Telemetry label |

> **Role selection (ADR-013).** One image, role chosen at runtime via `ROLE`. The compose stack runs
> a `kaiban-gateway` (HTTP/`/health`) and a `kaiban-worker` (no HTTP, healthcheck disabled).

---

## Which variables reach the containers

`docker compose --env-file .env` only fills the `${...}` references written inside the compose file. A variable that is in `.env` but not referenced there never reaches a container. The stacks pass these:

| Variable | Gateway | Workers | Notes |
|----------|---------|---------|-------|
| `CONTROL_PLANE_ENABLED`, `CHANNEL_SIGNING_SECRET` | yes | yes | Also the orchestrator service |
| `BOARD_JWT_SECRET` | yes | root stack only | |
| `A2A_JWT_SECRET` | yes | root stack only | |
| `NODE_ENV` | yes | root stack only | Only the gateway and a `ROLE=worker` process check the production rules (three secrets of 32+ bytes, all different; on the gateway also `SOCKET_CORS_ORIGINS`) |
| `TRUST_PROXY`, `MCP_SERVER_ENABLED`, `MCP_DISPATCH_CONSENT` | yes | no | |
| `SOCKET_CORS_ORIGINS`, `A2A_PUBLIC_URL`, `MCP_SERVER_PATH`, `MCP_ALLOWED_TOOLS`, `MCP_ALLOWED_RESOURCES`, `MCP_ALLOWED_PROMPTS`, `OTEL_EXPORTER_OTLP_ENDPOINT` | yes, only when set | no | An empty value would break these, so they are passed only when you set them |
| `AGENT_TIMEOUT_MS`, `RETRY_ON_TIMEOUT`, `LOG_LEVEL` | yes | yes | Set the timeouts identically on the gateway and every worker |
| `SEMANTIC_FIREWALL_ENABLED`, `CIRCUIT_BREAKER_*`, `JIT_TOKENS_ENABLED` | no | yes | |
| `VALID_HITL_DECISIONS` | yes | no | |
| `MAX_TOKEN_BUDGET`, `MAX_TASK_TOKEN_BUDGET`, model and key variables | no | yes | |

Unset or empty keeps the code default. Any variable not in this table (`ECONOMICS_*`, `GOVERNANCE_*`, `LOG_PRETTY`, the TLS paths and so on) must be added under `environment:` of the service, or give the service `env_file: .env`. The Kubernetes and Helm files have their own settings: see [KUBERNETES.md](KUBERNETES.md) and [HELM.md](HELM.md).

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

The Kafka healthcheck has a 30 s start period and 15 retries (up to about 4 min in total). This is normal for `cp-kafka:7.6.0`. Wait for:

```
kaiban-distributed-kafka-1  healthy
```

### Rebuild after source changes

```bash
docker compose -f examples/blog-team/docker-compose.yml up -d --build
```
