# Project Tasks (S05 Implementation)

## T-001: Initialize NPM & Dependencies
- **Status:** DONE
- **Description:** Initialize npm project, configure TypeScript, and install base packages (`kaibanjs`, `bullmq`, `ioredis`, `@socket.io/redis-adapter`, `@opentelemetry/sdk-node`).

## T-002: Generate Formal Diagrams
- **Status:** DONE
- **Description:** Generated C4 container architecture diagram in draw.io url format.

## T-003: Messaging Layer (Redis/BullMQ)
- **Status:** DONE
- **Description:** Implement `src/infrastructure/messaging/interfaces.ts`, `bullmq-driver.ts`, and `kafka-driver.ts`. Write failing test first.

## T-004: Distributed State Middleware (Zustand)
- **Status:** DONE
- **Description:** Implement `src/adapters/state/distributedMiddleware.ts` to hook into KaibanJS's Zustand store and push events to Redis Pub/Sub.

## T-005: Actor Runtime
- **Status:** DONE
- **Description:** Implement `src/application/actor/AgentActor.ts` to sequentially process tasks and emit telemetry.

## T-006: Federation (MCP and A2A)
- **Status:** DONE
- **Description:** Implement `src/infrastructure/federation/a2a-connector.ts` and `mcp-client.ts`.

## T-007: Domain Layer
- **Status:** DONE
- **Description:** Created src/domain/ entities (DistributedTask, DistributedAgentState), DomainError hierarchy, Result<T,E> pattern.

## T-008: Real KafkaDriver + Interface Updates
- **Status:** DONE
- **Description:** Replaced stub KafkaDriver with real kafkajs implementation. Added unsubscribe() and traceHeaders to IMessagingDriver.

## T-009: A2A Connector
- **Status:** DONE
- **Description:** Implemented src/infrastructure/federation/a2a-connector.ts with JSON-RPC 2.0, agent-card, tasks.create/get, agent.status.

## T-010: AgentActor Refactor
- **Status:** DONE
- **Description:** Fixed stop() to unsubscribe not disconnect, added 3-attempt retry with DLQ, added PII sanitization via SHA-256 hash.

## T-011: DistributedStateMiddleware Refactor
- **Status:** DONE
- **Description:** Fixed unknown type casts, added sanitizeDelta PII denylist, proper ZustandStore interface.

## T-012: Edge Gateway
- **Status:** DONE
- **Description:** Created GatewayApp (Express: /health, agent-card, /a2a/rpc, 404) and SocketGateway (Socket.io + Redis Pub/Sub bridge).

## T-013: OpenTelemetry
- **Status:** DONE
- **Description:** initTelemetry() with OTLP/Console exporter, TraceContext W3C propagation helpers.

## T-014: Composition Root + Docker
- **Status:** DONE
- **Description:** src/main/index.ts (DI wiring), src/main/config.ts (env validation), docker-compose.yml, Dockerfile (multi-stage), .env.example.

## T-015: E2E Tests
- **Status:** DONE
- **Description:** globalSetup (Docker Redis), distributed-execution.test.ts (3 scenarios), a2a-protocol.test.ts (4 tests). All 7 pass.

## T-016: KaibanJS Integration
- **Status:** DONE
- **Description:** KaibanAgentBridge (createKaibanTaskHandler wraps real Agent.workOnTask), KaibanTeamBridge (attaches DistributedStateMiddleware to team.getStore()), A2AConnector tasks.create routes to BullMQ queue.

## T-017: Kafka E2E
- **Status:** DONE
- **Description:** Fixed zookeeper healthcheck (nc -z), kafkaSetup.ts global setup, kafka-driver.test.ts with 2 passing E2E tests.

## T-018: Blog Team Example
- **Status:** DONE
- **Description:** examples/blog-team — team-config.ts, researcher-node.ts, writer-node.ts, orchestrator.ts, docker-compose.yml.

## T-019: README Documentation
- **Status:** DONE
- **Description:** Comprehensive README.md with summary, architecture, quick start, individual node pattern, multi-node demo, kaiban-board integration, A2A protocol, MCP, messaging drivers, config reference, security, testing, deployment.

## T-020: Editor Agent (Morgan) + HITL
- **Status:** DONE
- **Description:** Added editorConfig (Morgan the editorial fact-checker) to team-config, editor-node.ts, event-driven orchestrator with PUBLISH/REVISE/REJECT HITL, updated docker-compose, README with full pipeline documentation.

## T-021: S08 — CI/CD Pipeline
- **Status:** DONE
- **Description:** .github/workflows/ci.yml — GitHub Actions CI with 5 jobs: quality (lint+typecheck+coverage+madge), e2e-bullmq (Redis), e2e-kafka (Kafka), security audit, Docker build.

## T-022: S08 — Architecture Decision Records
- **Status:** DONE
- **Description:** docs/decisions/ADR-001 (IMessagingDriver abstraction), ADR-002 (BullMQ colon restriction), ADR-003 (KaibanJS bridge pattern), ADR-004 (HITL editorial review), ADR-005 (W3C TraceContext propagation).

## T-023: S09 — TraceContext wired into messaging drivers
- **Status:** DONE
- **Description:** BullMQDriver and KafkaDriver now inject W3C traceparent headers on publish and extract/restore OTel context on subscribe. TraceContext.ts is no longer dead code.

## T-024: S10 — CHANGELOG, SPEC sync, lint:arch
- **Status:** DONE
- **Description:** CHANGELOG.md created, SPEC.md aligned with implementation (IMessagingDriver, TaskLog.timestamp: number), lint:arch script added (madge --circular src/), PROJECT_STATE.md updated to 113 tests / S01-S10 complete.
