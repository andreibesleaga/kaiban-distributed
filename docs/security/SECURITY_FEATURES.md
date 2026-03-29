# Kaiban Distributed: Security Features Reference

> Complete reference for every security feature in kaiban-distributed — what it does, where it lives, how to configure it, and how to verify it works.

---

## Contents

1. [Authentication](#1-authentication)
   - [Board Viewer JWT (Socket.io)](#11-board-viewer-jwt-socketio)
   - [A2A Service-to-Service JWT (HTTP RPC)](#12-a2a-service-to-service-jwt-http-rpc)
2. [Redis Pub/Sub Channel Signing](#2-redis-pubsub-channel-signing)
3. [Input Validation & API Hardening](#3-input-validation--api-hardening)
   - [HTTP Gateway Hardening](#31-http-gateway-hardening)
   - [WebSocket Gateway Hardening](#32-websocket-gateway-hardening)
   - [A2A Connector Input Validation](#33-a2a-connector-input-validation)
   - [BullMQ Trace Header Validation](#34-bullmq-trace-header-validation)
4. [Agent Runtime Security](#4-agent-runtime-security)
   - [Semantic Firewall](#41-semantic-firewall)
   - [Circuit Breaker](#42-circuit-breaker)
   - [JIT Token Provider](#43-jit-token-provider)
5. [Transport Security (mTLS)](#5-transport-security-mtls)
6. [Data Protection](#6-data-protection)
   - [PII Sanitization](#61-pii-sanitization)
   - [Data Size Limits](#62-data-size-limits)
7. [Infrastructure Security](#7-infrastructure-security)
   - [Redis Password & Network Binding](#71-redis-password--network-binding)
   - [Kafka Topic Controls](#72-kafka-topic-controls)
   - [Container Security](#73-container-security)
   - [Docker Resource Limits](#74-docker-resource-limits)
8. [Observability & Auditability](#8-observability--auditability)
9. [Environment Variable Reference](#9-environment-variable-reference)
10. [Production Deployment Checklist](#10-production-deployment-checklist)

---

## 1. Authentication

### 1.1 Board Viewer JWT (Socket.io)

**Purpose:** Restricts who can connect to the Socket.io board gateway and receive live agent state.

**File:** [`src/infrastructure/security/board-auth.ts`](../../src/infrastructure/security/board-auth.ts)

**How it works:**

1. An operator (or CI step) calls `issueBoardToken(subject, expiresInSeconds?)` to mint a short-lived HS256 JWT.
2. The board client passes the token in the Socket.io handshake:
   ```typescript
   io(gatewayUrl, { auth: { token: boardToken } })
   ```
3. `SocketGateway.initialize()` registers an `io.use()` middleware that calls `verifyBoardToken(token)`.
4. On connection, the server reads the JWT `exp` claim and schedules `socket.disconnect(true)` at expiry — preventing stolen tokens from maintaining sessions.

**Token claims:**
```json
{ "sub": "<operator-id>", "role": "board-viewer", "exp": <unix-ts> }
```

**Gate:** Only active when `BOARD_JWT_SECRET` is set. When unset, all connections are accepted (backwards-compatible for local development).

**Configuration:**
```bash
BOARD_JWT_SECRET=<random 32+ bytes, base64>   # activates auth
BOARD_JWT_EXPIRY=3600                         # optional, default 3600 s
```

**Board app:** Set `VITE_BOARD_TOKEN=<token>` in `board/.env` before running `npm run dev` or building the production bundle. The token is injected at build time (Vite `import.meta.env`).

**Issuing a token:**
```typescript
import { issueBoardToken } from './src/infrastructure/security/board-auth';
process.env.BOARD_JWT_SECRET = 'your-secret';
const token = issueBoardToken('alice', 3600); // 1 hour
```

Or from a shell:
```bash
node -e "
  process.env.BOARD_JWT_SECRET='$(openssl rand -base64 32)';
  const { issueBoardToken } = require('./dist/src/infrastructure/security/board-auth');
  console.log(issueBoardToken('ops-team'));
"
```

**Tests:** `tests/unit/security/board-auth.test.ts`, `tests/unit/gateway/SocketGateway-auth.test.ts`, `tests/e2e/security-integration.test.ts`

---

### 1.2 A2A Service-to-Service JWT (HTTP RPC)

**Purpose:** Restricts which services can submit tasks via `POST /a2a/rpc`.

**File:** [`src/infrastructure/security/a2a-auth.ts`](../../src/infrastructure/security/a2a-auth.ts)

**How it works:**

1. Each authorized service (orchestrator, worker) calls `issueA2AToken(serviceId)` at startup.
2. The token is passed as a Bearer header on every RPC call:
   ```
   Authorization: Bearer <token>
   ```
3. `GatewayApp.requireA2AAuth()` middleware calls `verifyA2AToken(authHeader)` — 401 on failure.

**Token claims:**
```json
{ "sub": "<service-id>", "role": "a2a-client", "exp": <unix-ts> }
```

**Gate:** Only active when `A2A_JWT_SECRET` is set. When unset, all callers are trusted.

**Configuration:**
```bash
A2A_JWT_SECRET=<random 32+ bytes, base64>   # activates auth
```

**Example — orchestrator issuing its own token at startup:**
```typescript
import { issueA2AToken } from '../../src/infrastructure/security/a2a-auth';

let a2aToken = '';
if (process.env['A2A_JWT_SECRET']) {
  a2aToken = issueA2AToken('blog-team-orchestrator');
}

// In RPC calls:
const headers: Record<string, string> = { 'Content-Type': 'application/json' };
if (a2aToken) headers['Authorization'] = `Bearer ${a2aToken}`;
```

**Tests:** `tests/unit/security/a2a-auth.test.ts`, `tests/unit/gateway/GatewayApp-auth.test.ts`, `tests/e2e/security-integration.test.ts`

---

## 2. Redis Pub/Sub Channel Signing

**Purpose:** Prevents anyone with Redis access from injecting fake workflow state into the gateway's state snapshot or the board's live view.

**File:** [`src/infrastructure/security/channel-signing.ts`](../../src/infrastructure/security/channel-signing.ts)

**How it works:**

Publishers call `wrapSigned(payload)`:
```typescript
// Produces: '{"payload":{...},"sig":"<hmac-hex>","ts":1711580000000}'
const envelope = wrapSigned({ teamWorkflowStatus: 'RUNNING', agents: [...] });
this.redis.publish('kaiban-state-events', envelope);
```

The consumer (`SocketGateway`) calls `unwrapVerified(raw)`:
```typescript
const parsed = unwrapVerified(data);
if (!parsed) {
  console.warn('[SocketGateway] Rejected unsigned/invalid channel message');
  return;
}
// use parsed safely
```

**Security properties:**
- **Integrity:** HMAC-SHA256 covers `"<ts>.<JSON.stringify(payload)>"` — any field change invalidates the signature.
- **Replay protection:** Messages older than 30 seconds are rejected (`MAX_CLOCK_SKEW_MS = 30_000`).
- **Timing safety:** Comparison uses `crypto.timingSafeEqual()` — no timing oracle.

**Gate:** Plain-JSON pass-through when `CHANNEL_SIGNING_SECRET` is unset. Existing deployments continue working unchanged.

**Configuration:**
```bash
CHANNEL_SIGNING_SECRET=<random 32+ bytes, base64>   # activates signing
```

**All publishers:**
- `AgentStatePublisher.publish()` — `src/adapters/state/agent-state-publisher.ts`
- `OrchestratorStatePublisher.publish()` — `examples/blog-team/orchestrator.ts`

**Tests:** `tests/unit/security/channel-signing.test.ts`, `tests/unit/state/agent-state-publisher-signing.test.ts`, `tests/e2e/security-integration.test.ts`

---

## 3. Input Validation & API Hardening

### 3.1 HTTP Gateway Hardening

**File:** [`src/adapters/gateway/GatewayApp.ts`](../../src/adapters/gateway/GatewayApp.ts)

| Feature | Detail |
|---------|--------|
| **Helmet** | `Content-Security-Policy: default-src 'none'` |
| | `Strict-Transport-Security: max-age=63072000; includeSubDomains` |
| | `Referrer-Policy: no-referrer` |
| **Body size limit** | `express.json({ limit: '1mb' })` — rejects oversized payloads |
| **Content-Type enforcement** | Returns 415 if `Content-Type` is not `application/json` on `/a2a/rpc` |
| **Request timeout** | `req.setTimeout(30_000)` — prevents slow-read / Slowloris attacks |
| **Rate limiting — RPC** | 100 req/min per IP via `SlidingWindowRateLimiter` |
| **Rate limiting — health** | 5 req/min per IP (separate limiter; prevents recon abuse) |
| **Trust proxy** | `app.set('trust proxy', 1)` only when `TRUST_PROXY=true` — prevents IP spoofing via `X-Forwarded-For` |
| **Error sanitization** | Production: `'Internal server error'`; Development: full error message |
| **Request logging** | UUID per request; logged on response finish (no sensitive data in log line) |

**Rate limiter design:** `SlidingWindowRateLimiter` uses an in-memory `Map<ip, number[]>`. Expired timestamps are evicted on each access; empty keys are replaced rather than accumulated — preventing unbounded memory growth under IP-spray attacks.

```bash
# Trust proxy (required for Railway, Kubernetes, Nginx deployments)
TRUST_PROXY=true

# Environment
NODE_ENV=production    # enables error sanitization
```

---

### 3.2 WebSocket Gateway Hardening

**File:** [`src/adapters/gateway/SocketGateway.ts`](../../src/adapters/gateway/SocketGateway.ts)

| Feature | Detail |
|---------|--------|
| **CORS** | Exact-origin allowlist from `SOCKET_CORS_ORIGINS`; throws in production if unset (wildcard refused) |
| **Frame size limit** | `maxHttpBufferSize: 1e6` (1 MB) — prevents oversized WebSocket frames |
| **Ping timeout** | `pingTimeout: 20_000` — disconnects dead clients after 20 s without pong |
| **Ping interval** | `pingInterval: 25_000` — server-initiated heartbeat every 25 s |
| **Board JWT auth** | `io.use()` middleware before any connection handler |
| **Token expiry** | `setTimeout(disconnect, msUntilExpiry)` scheduled per connection |
| **Channel signing** | All Redis messages verified via `unwrapVerified()` before forwarding |
| **HITL validation** | `decision` must be one of `['PUBLISH', 'REVISE', 'REJECT']`; `taskId` must be a string |

**CORS configuration:**
```bash
SOCKET_CORS_ORIGINS=http://localhost:5173,https://board.example.com
# In production, gateway refuses to start if this is unset
```

---

### 3.3 A2A Connector Input Validation

**File:** [`src/infrastructure/federation/a2a-connector.ts`](../../src/infrastructure/federation/a2a-connector.ts)

| Field | Validation | Error Code |
|-------|-----------|------------|
| `jsonrpc` | Must be `'2.0'` | `-32600` Invalid Request |
| `method` | Whitelist: `agent.status`, `tasks.create`, `tasks.get` | `-32601` Method Not Found |
| `agentId` | Required, non-empty | `-32602` Invalid Params |
| `agentId` | Pattern: `/^[\w-]+$/` (alphanumeric/hyphen/underscore) | `-32602` |
| `agentId` | Max 64 characters | `-32602` |
| `agentId` | Wildcard `*` rejected | `-32602` |
| `instruction` | Max 10,000 characters | `-32602` |
| Error method echo | Truncated to 100 characters | — |

---

### 3.4 BullMQ Trace Header Validation

**File:** [`src/infrastructure/messaging/bullmq-driver.ts`](../../src/infrastructure/messaging/bullmq-driver.ts)

Before passing job headers to `extractTraceContext`, the worker validates all trace headers:

```typescript
const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
// Strips any non-string values; skips traceparent if format invalid
```

This prevents crafted job payloads from injecting malformed OpenTelemetry trace headers (MED-06 from V2 audit).

---

## 4. Agent Runtime Security

### 4.1 Semantic Firewall

**Purpose:** Detects and blocks prompt injection attempts before they reach the LLM.

**File:** `src/infrastructure/security/heuristic-firewall.ts`

**How it works:** Evaluates `instruction` and `context` fields against 10 regex patterns covering common injection vectors (ignore/override previous instructions, jailbreak commands, etc.). Returns `{ blocked: true, reason }` for matches.

**Injected into:** `AgentActor` — evaluated before `handler(payload)` is called.

**Configuration:**
```bash
SEMANTIC_FIREWALL_ENABLED=true              # activates firewall
SEMANTIC_FIREWALL_LLM_URL=http://...        # optional: deep LLM-based analysis
```

**OWASP:** ASI01 (Agent Goal Hijack), LLM01 (Prompt Injection)

---

### 4.2 Circuit Breaker

**Purpose:** Trips after a configurable number of LLM/handler failures within a sliding window, preventing runaway agents from exhausting quotas or cascading.

**File:** `src/infrastructure/security/sliding-window-breaker.ts`

**How it works:** Tracks failure timestamps in a sliding window. When `failures >= threshold` within `windowMs`, the breaker opens and rejects new calls. Closes automatically when the window expires. Emits OTLP `recordAnomalyEvent()` on state transitions.

**Configuration:**
```bash
CIRCUIT_BREAKER_ENABLED=true
CIRCUIT_BREAKER_THRESHOLD=10      # failures before breaker trips (default: 10)
CIRCUIT_BREAKER_WINDOW_MS=60000   # sliding window duration in ms (default: 60 s)
```

**OWASP:** ASI10 (Rogue Agents), LLM10 (Model DoS)

---

### 4.3 JIT Token Provider

**Purpose:** Abstracts LLM API key retrieval to support Just-In-Time ephemeral credentials from Vault, AWS Secrets Manager, or similar systems.

**File:** `src/infrastructure/security/env-token-provider.ts`

**Interface:** `ITokenProvider` (domain layer) — swap implementations without changing agent code.

**Default:** `EnvTokenProvider` reads from environment variables (same as before). When `JIT_TOKENS_ENABLED=true`, the system signals that a dynamic token provider is in use.

**Configuration:**
```bash
JIT_TOKENS_ENABLED=true           # activates JIT signaling; implement ITokenProvider for your secrets backend
```

**OWASP:** ASI03 (Identity & Privilege Abuse)

---

## 5. Transport Security (mTLS)

**Purpose:** Encrypts all traffic between agent workers and Redis/Kafka, and authenticates both sides with client certificates.

**Files:** `src/infrastructure/messaging/bullmq-driver.ts`, `src/infrastructure/messaging/kafka-driver.ts`

**Certificate generation (development/staging):**
```bash
./scripts/generate-dev-certs.sh
# Outputs: certs/ca.crt, certs/client.crt, certs/client.key
```

**Configuration:**
```bash
# Redis mTLS
REDIS_TLS_CA=./certs/ca.crt
REDIS_TLS_CERT=./certs/client.crt
REDIS_TLS_KEY=./certs/client.key

# Kafka SSL/mTLS
KAFKA_SSL_CA=./certs/ca.crt
KAFKA_SSL_CERT=./certs/client.crt
KAFKA_SSL_KEY=./certs/client.key

# Use 'false' only for self-signed certs in staging; always 'true' in production
TLS_REJECT_UNAUTHORIZED=true
```

**OWASP:** ASI07 (Insecure Inter-Agent Communication)

---

## 6. Data Protection

### 6.1 PII Sanitization

**Purpose:** Strips personally identifiable information from state events before they are broadcast to the board.

**Files:** `src/adapters/state/` — `sanitizeDelta()`, `sanitizeId()`

| Function | Behaviour |
|----------|-----------|
| `sanitizeDelta(delta)` | Strips fields: `email`, `name`, `phone`, `ip`, `password`, `token`, `secret`, `ssn`, `dob` |
| `sanitizeId(agentId)` | SHA-256 hashes agent IDs; logs 8-char prefix only |

**OWASP / Compliance:** LLM02, GDPR data minimization

---

### 6.2 Data Size Limits

| Boundary | Limit | Location |
|----------|-------|----------|
| Task result in state events | 800 characters | `AgentStatePublisher` — `MAX_RESULT_LEN` |
| Task title in state events | 60 characters | `AgentStatePublisher` |
| Outbound task result in messages | 64 KB | `AgentActor` |
| HTTP request body | 1 MB | `GatewayApp` — `express.json({ limit: '1mb' })` |
| WebSocket frame | 1 MB | `SocketGateway` — `maxHttpBufferSize: 1e6` |
| `instruction` field | 10,000 characters | `A2AConnector` input validation |
| `agentId` field | 64 characters | `A2AConnector` input validation |

---

## 7. Infrastructure Security

### 7.1 Redis Password & Network Binding

**File:** [`docker-compose.yml`](../../docker-compose.yml)

```yaml
redis:
  command: redis-server ${REDIS_PASSWORD:+--requirepass ${REDIS_PASSWORD}}
  ports:
    - "127.0.0.1:6379:6379"   # loopback-only — not accessible from outside host
```

- When `REDIS_PASSWORD` is set, Redis starts with `requirepass`.
- Port is bound to `127.0.0.1` only — not externally reachable on a single-host deployment.
- Update `REDIS_URL` to include the password: `redis://:${REDIS_PASSWORD}@redis:6379` (or `localhost:6379` for bare-metal).

**Healthcheck** handles the optional password automatically:
```yaml
test: ["CMD", "redis-cli", "${REDIS_PASSWORD:+-a}", "${REDIS_PASSWORD:-}", "ping"]
```

---

### 7.2 Kafka Topic Controls

**File:** [`docker-compose.yml`](../../docker-compose.yml)

```yaml
KAFKA_AUTO_CREATE_TOPICS_ENABLE: "false"
```

Topics must be created explicitly before use. This prevents arbitrary topic creation from compromising the namespace.

---

### 7.3 Container Security

**File:** `Dockerfile`

```dockerfile
USER kaiban    # non-root user; no Linux capability escalation
```

**OWASP / Compliance:** SOC2 least-privilege, ASI05 (unexpected code execution)

---

### 7.4 Docker Resource Limits

All services in `docker-compose.yml` declare CPU and memory limits to prevent one service from starving others:

| Service | CPU limit | Memory limit |
|---------|-----------|--------------|
| `redis` | 0.5 | 256 MB |
| `zookeeper` | 0.5 | 256 MB |
| `kafka` | 1.0 | 512 MB |
| `kaiban-worker` | 1.0 | 512 MB |

---

## 8. Observability & Auditability

| Feature | Detail |
|---------|--------|
| **OpenTelemetry** | Auto-instrumented; OTLP export to configurable endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT`) |
| **W3C traceparent** | Injected into BullMQ/Kafka job headers; propagated across async hops; validated on receive |
| **Anomaly events** | `recordAnomalyEvent()` emits OTLP span events on circuit breaker state changes |
| **Request logging** | UUID per HTTP request; method, path, status logged on response finish |
| **HITL decision logging** | Decision + truncated task ID logged on receipt and Redis publish |
| **Channel signing warnings** | `console.warn` when an unsigned/invalid Redis message is rejected |
| **OTLP auth** | Pass `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>` for authenticated collectors |

**Compliance:** SOC2 (non-repudiation), ISO 27001 (audit logs), STRIDE (Repudiation mitigation)

---

## 9. Environment Variable Reference

### Authentication & Signing

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BOARD_JWT_SECRET` | In production | — | HS256 secret for Socket.io board viewer tokens. When set, all WebSocket connections require a valid token. |
| `A2A_JWT_SECRET` | In production | — | HS256 secret for A2A service tokens. When set, `POST /a2a/rpc` requires `Authorization: Bearer <token>`. |
| `CHANNEL_SIGNING_SECRET` | In production | — | HMAC-SHA256 secret for Redis pub/sub message signing. When set, unsigned messages are rejected by the gateway. |
| `SOCKET_CORS_ORIGINS` | In production | — | Comma-separated allowed origins for Socket.io. **Required in `NODE_ENV=production`** (gateway refuses to start without it). |

### Infrastructure

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDIS_PASSWORD` | Recommended | — | Redis server password. Must match `REDIS_URL` (include in connection string). |
| `NODE_ENV` | In production | `development` | Set to `production` to enable error sanitization and CORS enforcement. |
| `TRUST_PROXY` | Deployment-specific | `false` | Set `true` when behind a reverse proxy (Railway, K8s Ingress, Nginx) to enable correct `req.ip` derivation. |

### Transport (mTLS)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDIS_TLS_CA` | Optional | — | Path to CA certificate for Redis mTLS |
| `REDIS_TLS_CERT` | Optional | — | Path to client certificate for Redis mTLS |
| `REDIS_TLS_KEY` | Optional | — | Path to client key for Redis mTLS |
| `KAFKA_SSL_CA` | Optional | — | Path to CA certificate for Kafka SSL |
| `KAFKA_SSL_CERT` | Optional | — | Path to client certificate for Kafka SSL |
| `KAFKA_SSL_KEY` | Optional | — | Path to client key for Kafka SSL |
| `TLS_REJECT_UNAUTHORIZED` | Optional | `true` | Set `false` for self-signed certs in staging only |

### Agent Runtime Security

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SEMANTIC_FIREWALL_ENABLED` | Optional | `false` | Enable regex-based prompt injection firewall on agents |
| `SEMANTIC_FIREWALL_LLM_URL` | Optional | — | Optional local LLM endpoint for deep semantic analysis |
| `CIRCUIT_BREAKER_ENABLED` | Optional | `false` | Enable sliding-window circuit breaker on agents |
| `CIRCUIT_BREAKER_THRESHOLD` | Optional | `10` | Failure count to trip breaker |
| `CIRCUIT_BREAKER_WINDOW_MS` | Optional | `60000` | Sliding window duration in ms |
| `JIT_TOKENS_ENABLED` | Optional | `false` | Enable JIT token provider for LLM API keys |

### Telemetry

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Optional | — | OTLP endpoint; uses `ConsoleSpanExporter` if unset |
| `OTEL_EXPORTER_OTLP_HEADERS` | Optional | — | Auth headers for OTLP collector e.g. `Authorization=Bearer <token>` |

### Board App (`board/.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_GATEWAY_URL` | Optional | `http://localhost:3000` | Gateway WebSocket URL |
| `VITE_BOARD_TOKEN` | When `BOARD_JWT_SECRET` set | — | JWT board viewer token passed in Socket.io handshake |

---

## 10. Production Deployment Checklist

Run through this before deploying to any internet-facing or multi-tenant environment.

### Critical (system is insecure without these)

- [ ] `NODE_ENV=production`
- [ ] `BOARD_JWT_SECRET=<openssl rand -base64 32>` — enables WebSocket auth
- [ ] `SOCKET_CORS_ORIGINS=https://board.example.com` — prevents wildcard CORS
- [ ] `A2A_JWT_SECRET=<openssl rand -base64 32>` — enables RPC auth
- [ ] `CHANNEL_SIGNING_SECRET=<openssl rand -base64 32>` — enables Redis signing
- [ ] `REDIS_PASSWORD=<openssl rand -base64 24>` and `REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379`
- [ ] `TRUST_PROXY=true` if behind Nginx / Railway / Kubernetes ingress
- [ ] `VITE_BOARD_TOKEN=<issued token>` in the board deployment

### Strongly Recommended

- [ ] `SEMANTIC_FIREWALL_ENABLED=true`
- [ ] `CIRCUIT_BREAKER_ENABLED=true`
- [ ] Redis / Kafka mTLS certs configured
- [ ] `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS` for monitored telemetry
- [ ] LLM API keys sourced from Vault / Secrets Manager (implement `ITokenProvider`)

### Quick Secret Generation

```bash
echo "BOARD_JWT_SECRET=$(openssl rand -base64 32)"
echo "A2A_JWT_SECRET=$(openssl rand -base64 32)"
echo "CHANNEL_SIGNING_SECRET=$(openssl rand -base64 32)"
echo "REDIS_PASSWORD=$(openssl rand -base64 24)"
```

---
