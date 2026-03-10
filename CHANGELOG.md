# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project uses [Conventional Commits](https://www.conventionalcommits.org/).

---

## [Unreleased]

---

## [1.0.0] — 2026-03-10

### Added

#### Core Infrastructure
- `IMessagingDriver` abstraction interface (`src/infrastructure/messaging/interfaces.ts`)
- `BullMQDriver` — Redis/BullMQ v5 implementation with W3C trace context propagation
- `KafkaDriver` — Apache Kafka implementation using kafkajs with trace context propagation
- `DistributedStateMiddleware` — Zustand store interceptor with PII sanitization (`sanitizeDelta`)
- `AgentActor` — Actor runtime with 3-attempt exponential backoff retry, DLQ, PII-hashed logs
- `GatewayApp` — Express HTTP server (`/health`, `/.well-known/agent-card.json`, `/a2a/rpc`)
- `SocketGateway` — Socket.io server with Redis adapter for real-time state broadcasting
- `A2AConnector` — JSON-RPC 2.0 server; `tasks.create` routes to BullMQ agent queues
- `MCPFederationClient` — MCP tool server client via stdio transport
- `TraceContext` — W3C `traceparent`/`tracestate` inject/extract helpers (OpenTelemetry)
- `initTelemetry` — OpenTelemetry SDK setup (OTLP or Console exporter)

#### Domain Layer
- `DistributedTask` entity with type guard and `TaskStatus` enum
- `DistributedAgentState` entity with type guard and `AgentStatus` enum
- `DomainError` hierarchy (`TaskNotFoundError`, `AgentNotFoundError`, `ValidationError`, `MessagingError`)
- `Result<T,E>` type with `ok()`, `err()`, `isOk()`, `isErr()` helpers

#### KaibanJS Integration
- `createKaibanTaskHandler` — maps `MessagePayload` to real `agent.workOnTask()`, returns LLM `finalAnswer`
- `KaibanTeamBridge` — wraps KaibanJS `Team` with `DistributedStateMiddleware` for distributed state sync
- `KafkaDriver` and `BullMQDriver` now inject W3C trace context on publish and extract on subscribe

#### Composition Root
- `src/main/index.ts` — DI wiring; driver selected via `MESSAGING_DRIVER` env var
- `src/main/config.ts` — typed env var loading with validation

#### Infrastructure
- Multi-stage `Dockerfile` (Node 22 Alpine, non-root `kaiban` user)
- `docker-compose.yml` — Redis, Zookeeper, Kafka, kaiban-worker
- `.env.example` — all env vars documented
- `.github/workflows/ci.yml` — GitHub Actions CI: lint, typecheck, unit tests, BullMQ E2E, Kafka E2E, Docker build

#### Examples
- `examples/blog-team/` — Three-agent distributed pipeline:
  - `researcher-node.ts` — Ava (News Researcher)
  - `writer-node.ts` — Kai (Content Creator)
  - `editor-node.ts` — Morgan (Editorial Fact-Checker)
  - `orchestrator.ts` — Event-driven chain with HITL PUBLISH/REVISE/REJECT decision
  - `docker-compose.yml` — Multi-node deployment

#### Documentation
- `README.md` — comprehensive with quick start, architecture, integration guides, API reference
- `docs/api/SPEC.md` — aligned with actual implementation
- `docs/decisions/ADR-001` through `ADR-005` — Architecture Decision Records
- `docs/requirements/PRD.md` — Product Requirements
- `docs/architecture/PLAN.md` — C4 diagrams
- `CHANGELOG.md` — this file

### Tests
- 113 unit tests across 14 suites — 100% coverage (statements/branches/functions/lines)
- 7 BullMQ E2E tests (real Redis via Docker)
- 2 Kafka E2E tests (real Kafka via Docker)
- All SDLC acceptance criteria verified

### Fixed
- `AgentActor.stop()` called `driver.disconnect()` (disconnects shared driver) → now calls `driver.unsubscribe()`
- `KafkaDriver` was a stub (only `console.log`) → full `kafkajs` implementation
- `A2AConnector.tasks.create` returned stub data → now routes to BullMQ agent queue
- `TraceContext.ts` was dead code (never imported) → wired into both messaging drivers
- `main/index.ts` had stray orphaned Redis connection → removed
- BullMQ queue names with colons rejected by BullMQ v5 → renamed to use dashes

### Security
- PII stripped from state deltas via configurable denylist in `sanitizeDelta()`
- Agent IDs SHA-256 hashed in all log output
- Docker container runs as non-root `kaiban` user
- All secrets via environment variables; `.env` in `.gitignore`
- GDPR/SOC2/ISO 27001 compliance controls documented

### Known Issues
- `kaibanjs >= 0.3.0` transitive CVEs (4 high) via `@langchain/community`, `expr-eval`, `langsmith` — unfixable without downgrading to `kaibanjs@0.0.1` (breaking change). Tracked in `agents/memory/AUDIT_LOG.md`. Human decision required.
