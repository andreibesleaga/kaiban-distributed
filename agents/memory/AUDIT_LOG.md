# AUDIT_LOG.md
LOKI_INIT
PHASE_TRANSITION: S01 complete
PHASE_TRANSITION: S02 complete
PHASE_TRANSITION: S03 complete
PHASE_TRANSITION: S04 complete

PHASE_TRANSITION: S05 complete

PHASE_TRANSITION: S06 complete

PHASE_TRANSITION: S07 complete — 2026-03-10
DECISION: BullMQ queue names must not contain colons — renamed kaiban:events:* to kaiban-events-*
DECISION: kaibanjs CVEs (4 high) unfixable without breaking downgrade — escalated to human review
DECISION: DistributedStateMiddleware uses IMessagingDriver for BullMQ-based pub/sub; SocketGateway uses ioredis pub/sub directly (separate drivers by purpose)
DECISION: KafkaDriver is real implementation but E2E tests use BullMQ+Redis only (Kafka requires separate zookeeper/kafka infra)

KAFKA_VERIFICATION: 2026-03-10
DECISION: Added MESSAGING_DRIVER env var ('bullmq'|'kafka') — runtime driver selection in main/index.ts
DECISION: Fixed docker-compose zookeeper healthcheck: 'nc -z localhost 2181' replaces failed 'echo ruok | nc | grep imok'
DECISION: Added start_period to zookeeper/kafka healthchecks to avoid race condition on slow startup
DECISION: Added Kafka E2E test (kafka-driver.test.ts) with dedicated vitest.e2e.kafka.config.ts + kafkaSetup.ts
DECISION: Removed stray redisBullMQ connection from main/index.ts — BullMQ manages connections internally
RESULT: All 94 unit tests pass (100% coverage), 7 BullMQ E2E pass, 2 Kafka E2E pass against real Kafka broker

PHASE_TRANSITION: KaibanJS integration complete — 2026-03-10
DECISION: KaibanAgentBridge created — wraps Agent + Task, maps MessagePayload → workOnTask()
DECISION: KaibanTeamBridge created — wraps Team, attaches DistributedStateMiddleware to getStore()
DECISION: A2AConnector tasks.create wired to IMessagingDriver — now routes to kaiban-agents-{agentId} BullMQ queue
DECISION: blog-team example created — follows kaibanjs-node-demo pattern with researcher + writer nodes
DECISION: Kafka E2E tests added — 2 tests verify publish/subscribe round-trip against real Kafka broker
DECISION: socket.io-client added to dependencies — required by orchestrator.ts for real-time state monitoring
DECISION: README.md created — comprehensive docs with architecture, quick start, board integration, multi-node demo

PHASE_TRANSITION: Editor agent (Morgan) added — 2026-03-10
DECISION: TaskHandler return type changed from Promise<void> to Promise<unknown> — enables LLM result propagation through completion events
DECISION: KaibanAgentBridge now returns actual workOnTask() finalAnswer in completion data.result field
DECISION: extractFinalAnswer() helper extracted to keep complexity under 10 — handles 4 cases: finalAnswer object, string, plain object, null
DECISION: Morgan (Editorial Fact-Checker) agent added to blog-team example — structured PUBLISH/REVISE/REJECT review format
DECISION: Orchestrator rewritten as event-driven (BullMQ subscription to kaiban-events-completed) instead of fixed timeouts
DECISION: HITL decision loop added — pauses after Morgan's review for human PUBLISH/REVISE/REJECT/VIEW decision
DECISION: REVISE path implemented — editor notes + original draft returned to Kai for revision round

PHASE_TRANSITION: S08 complete — 2026-03-10
DECISION: CI/CD added: .github/workflows/ci.yml runs lint, typecheck, unit tests, BullMQ E2E, Kafka E2E, Docker build
DECISION: ADR-001 through ADR-005 created in docs/decisions/ — satisfies CONSTITUTION Article VIII

PHASE_TRANSITION: S09 complete — 2026-03-10
DECISION: TraceContext dead code resolved — BullMQDriver and KafkaDriver now inject/extract W3C traceparent headers
DECISION: otelContext.with(ctx, handler) used for proper span context propagation across queue hops

PHASE_TRANSITION: S10 complete — 2026-03-10
DECISION: CHANGELOG.md created following Keep a Changelog format
DECISION: SPEC.md updated to match implementation (IMessagingDriver, TaskLog.timestamp: number, context: string[])
DECISION: lint:arch script added to package.json (madge --circular src/)
DECISION: PROJECT_STATE.md updated (113 tests, all S01-S10 complete)

DECISION: AgentStatePublisher publishes directly to Redis Pub/Sub (ioredis.publish), NOT via BullMQ — SocketGateway reads Redis Pub/Sub, not BullMQ queues
DECISION: Board merges state deltas by agentId/taskId (not replace) so multiple worker nodes show simultaneously
DECISION: KaibanJS agentInstance.initialize(null, env) must be called to bootstrap LLM instance outside a Team context
DECISION: BullMQ queue names cannot contain colons — all channels use dashes (kaiban-agents-researcher, etc.)
DECISION: KaibanJS apiBaseUrl requires `as any` cast — field exists at runtime but not in TypeScript types
DECISION: tsconfig rootDir must be "." when examples/ is in include — otherwise dist paths shift
DECISION: main/index.ts must NOT call .connect() on ioredis after SocketGateway.initialize() — already connected
PHASE_TRANSITION: Full project COMPLETE — all agents live, board showing state, README done

DECISION: AgentStatePublisher heartbeat (15s interval) ensures late-connecting boards see current agent state — Redis pub/sub is fire-and-forget; heartbeat re-publishes on timer
DECISION: Kafka blog-team uses createDriver(groupIdSuffix) factory — each worker gets unique consumer group (e.g. kaiban-group-researcher) to prevent message routing conflicts  
DECISION: Orchestrator CompletionRouter uses TWO separate drivers for Kafka (orchestrator-completed / orchestrator-failed) because KafkaJS consumer.run() cannot subscribe to new topics after it starts
DECISION: Both BullMQ and Kafka docker-composes available for blog-team; Kafka also needs zookeeper and uses internal listener kafka:29092 for inter-container comms
PHASE_TRANSITION: All systems complete — BullMQ + Kafka paths, board heartbeat, 128 tests, 100% coverage

DECISION: Workers' AgentStatePublisher heartbeats MUST NOT publish teamWorkflowStatus — only orchestrator controls lifecycle (RUNNING/FINISHED/STOPPED/INITIAL)
DECISION: workflowFinished(writeTaskId, topic, editTaskId) takes optional editTaskId to also clear the AWAITING_VALIDATION editorial task to DONE
DECISION: workflowStopped(taskId, reason, editTaskId?) clears editorial task to BLOCKED on REJECT
DECISION: workflowStarted() published at orchestrator boot so board immediately shows RUNNING + all agents IDLE
DECISION: Board event stream uses type-specific CSS classes (lt-WORKFLOW, lt-AGENT, lt-TASK) and shows full message content with status icons
DECISION: FINISHED state: board shows green ✅ WORKFLOW COMPLETE banner + ws-finished glow animation; STOPPED shows grey ⏹ WORKFLOW ENDED
