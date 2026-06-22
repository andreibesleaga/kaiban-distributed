# kaiban-distributed — Features & Real-World Value

> **Version 2.0.0** · branch `feat/v2.0` · dual-licensed **Apache-2.0** (published library core)
> / **GPL-3.0** (full application, board, examples). This document summarizes what the runtime does
> and—more importantly—**why each capability matters in practice**. Every feature listed below exists
> in the repository today; anything not yet built is explicitly labelled **roadmap**.
>
> Companion reading: [`README.md`](../README.md) · [`EXAMPLES.md`](../EXAMPLES.md) ·
> [`CHANGELOG.md`](../CHANGELOG.md) · ADRs in [`docs/decisions/`](decisions/) ·
> [`docs/api/SPEC.md`](api/SPEC.md) · [`docs/architecture/ACTOR_MODEL.md`](architecture/ACTOR_MODEL.md) ·
> the v2.0 plan [`KAIBAN-v2.0-MASTER-PLAN.md`](../KAIBAN-v2.0-MASTER-PLAN.md).

---

## 1. Positioning — what it is and who it's for

**kaiban-distributed is a horizontally-scalable, actor-model runtime for multi-agent AI teams in the
JavaScript/TypeScript ecosystem.** Each AI agent runs as a *stateful actor* in its own deployed
Node.js process, communicating only by asynchronous messages over a pluggable enterprise messaging
layer (BullMQ/Redis by default, Apache Kafka by configuration). Workflows are made legible through a
real-time **Kanban board** that consumes the very same state stream operators and auditors rely on,
and the fleet federates with the outside world over **A2A** (agent-to-agent) and **MCP** (Model
Context Protocol). It is built for engineers who have
outgrown single-process agent scripts and need agent workflows that survive real production load:
long-running LLM calls, mid-flight failures, human approval gates, cost ceilings, and
borderless interoperability.

The one-line identity, kept front-and-centre across the docs:

> *"One of the first open-source projects to combine **Enterprise Messaging (Kafka/Redis)**,
> **Distributed Actor-Model Isolation**, **AI Multi-Agent Orchestration**, and **Kanban
> Visualization** into a single JavaScript-ecosystem runtime, for agents and humans."*

And the design stance that distinguishes it from most JS agent frameworks:

> *"Where most frameworks treat agents as scripts, kaiban-distributed treats them as **Stateful
> Actors** — each operating in its own process, communicating via the pluggable MAL."*

---

## 2. Features and the value they deliver

### 2.1 Distributed actor model & messaging

- **Agents as stateful actors (process isolation / "let it crash").** Each agent is an `AgentActor`
  (`src/application/actor/`) with its own mailbox channel (`kaiban-agents-{id}`), processing one
  message at a time and crashing cleanly on error rather than wrapping every network call in defensive
  `try/catch`. **Value:** a rogue or failing agent cannot corrupt or take down its peers—the broker
  and retry policy decide recovery—so a fleet stays available under partial failure instead of losing
  all in-flight state the way a single-process orchestrator does.
- **Pluggable Messaging Abstraction Layer (MAL).** A single `IMessagingDriver` interface
  (`publish`/`subscribe`/`unsubscribe`/`disconnect`) with a `createDriver()` factory selected by the
  `MESSAGING_DRIVER` env var. **Value:** swap Redis/BullMQ ↔ Kafka with **zero worker code
  changes**—use Redis for low-latency UI updates and rapid scaling, or Kafka for massive throughput
  and immutable event replay—choosing transport per deployment rather than per rewrite. "The broker is
  replaceable."
- **Two real drivers, one contract.** `BullMQDriver` (Redis-backed, default; job-retention defaults
  to bound Redis growth, optional TLS) and `KafkaDriver` (a unique consumer group per worker role,
  optional SSL/mTLS, poison-message tolerance). **Value:** production-grade queueing semantics
  (durability, backpressure, competing consumers) without binding business logic to a specific broker.
- **Five canonical channels with a deliberate durable/ephemeral split.** Task mailboxes,
  `kaiban-events-completed`, and `kaiban-events-failed` (DLQ) flow over the durable driver; the
  `kaiban-state-events` and `kaiban-hitl-decisions` channels are **pinned to Redis Pub/Sub regardless
  of `MESSAGING_DRIVER`**. **Value:** durable task work and ephemeral UI/decision signalling each get
  the transport they actually need, and the contract is stable enough to reason about and test.
- **At-least-once delivery with `taskId` idempotency (AP + BASE).** Both brokers guarantee
  at-least-once, not exactly-once; `taskId` is the deduplication key and every handler is idempotent.
  **Value:** "duplicates are normal and must not corrupt state"—the system reaches consistency through
  message passing and idempotent handlers instead of a brittle global lock, which is what lets it scale
  horizontally.
- **Location transparency & horizontal scale.** Actors on one host or a global cluster look identical
  to the rest of the system; competing consumers (BullMQ round-robin / Kafka group rebalance) spread
  load. **Value:** "horizontal scale is one command" (`docker compose up --scale searcher=N` or
  `kubectl scale --replicas=N`), and agents can be placed near data or specialized hardware (run
  searchers in one region, the writer in another).
- **W3C trace-context propagation.** `traceparent`/`tracestate` headers ride every message across
  hops (validated and sanitized by a shared helper). **Value:** a single distributed task is traceable
  end-to-end across processes and brokers—essential for debugging a swarm you cannot `console.log`.

### 2.2 Multi-agent orchestration & Kanban workflow

- **Kanban-as-state-machine workflow.** Tasks move through a canonical lifecycle
  (`TODO → DOING → AWAITING_VALIDATION → DONE/BLOCKED`) surfaced as board columns. **Value:** "the
  board makes the invisible visible"—opaque reasoning cycles become an observable, governable workflow
  that operators and auditors can read at a glance, turning agentic pilots into something an enterprise
  can actually run.
- **Single-active, crash-safe orchestrator (promoted to the library in v2.0).**
  `src/shared/orchestrator.ts` drives a workflow over the `CompletionRouter` with **Redis
  checkpoint→resume**: progress is persisted per transition and resumed after a restart instead of
  starting over. It is idempotent by `taskId` so duplicate deliveries never double-advance. **Value:**
  workflows survive a process restart without losing in-flight progress, and the orchestrator is now
  reusable core (both examples consume it rather than duplicating it).
- **Clean separation of lifecycle ownership.** Workers publish only their own agent/task deltas
  (`AgentStatePublisher`); the orchestrator alone owns the global `teamWorkflowStatus`
  (`OrchestratorStatePublisher`). **Value:** a worker heartbeat can never overwrite a terminal
  `FINISHED`/`STOPPED` state, eliminating a whole class of race conditions on the board.
- **In-process actor dispatch and fan-out/fan-in.** `dispatchToAgent` hands an instruction straight
  to an agent mailbox; `CompletionRouter` maps `taskId → pending Promise` (with `waitAll` for fan-in).
  **Value:** orchestrate your own deployed nodes without going through the HTTP A2A surface, while
  keeping the same input caps and dedup guarantees.
- **KaibanJS bridge.** `KaibanAgentBridge` wraps a KaibanJS agent in a per-task `Team` and returns a
  token-tracked result; `KaibanTeamBridge` runs a local KaibanJS `Team` whose state syncs to the
  distributed board. **Value:** existing KaibanJS agents drop straight into distributed worker
  nodes—you keep the familiar role/goal/background/`llmConfig` authoring model and gain scale and
  isolation for free.

### 2.3 Federation (A2A v0.3 + MCP server)

- **A2A v0.3 gateway (official `@a2a-js/sdk`).** The Edge Gateway answers wire-conformant
  `message/send`, `message/stream` (SSE), `tasks/get`, and `tasks/cancel` at `POST /a2a/rpc`, and
  serves a v0.3 AgentCard at `/.well-known/agent-card.json`. **Value:** any standards-compliant A2A
  client interoperates with the fleet (proven by an e2e test against a real `@a2a-js/sdk` client),
  letting agents be orchestrated across organizational and technological boundaries—"A2A makes the
  mesh federable."
- **First-party MCP server (new in v2.0).** `buildMcpServer` + `createMcpHttpHandler` expose curated
  Tools (`dispatch_task`), read-only Resources (`kaiban://agents`, per-agent status), and Prompts over
  **Streamable HTTP**, behind the gateway's security chain and **off by default**. **Value:** MCP hosts
  (IDEs, assistants, other agents) can discover and delegate to your fleet through the de-facto tool
  protocol, while least-privilege allow-lists (`MCP_ALLOWED_*`) keep the exposed surface minimal.
- **MCP elicitation consent (HITL for tool calls).** Before `dispatch_task` does any work it asks the
  client to authorize via MCP elicitation; a client that cannot elicit is **fail-closed** (refused).
  **Value:** a remote model cannot silently spend your fleet's budget or trigger side effects—human/
  host consent is required by default.
- **Bidirectional MCP.** Alongside the inbound server, `MCPFederationClient` lets agent workers call
  *external* MCP tool servers. **Value:** agents both publish capabilities and consume third-party
  tools, with A2A as the public agent-to-agent front door and MCP as the internal tool/context surface.

### 2.4 Human-in-the-loop (HITL)

- **HITL as a first-class lifecycle state.** Approval is the `AWAITING_VALIDATION` column with
  `PUBLISH`/`REVISE`/`REJECT` decisions, not an ad-hoc callback. **Value:** "HITL is a column, not a
  callback"—human oversight is built into the workflow state machine, which is exactly what regulated,
  high-stakes automation (financial, legal, clinical) increasingly *requires* and what stalls many
  agentic pilots when it's missing.
- **Dual decision channels, durable-first delivery.** A decision can arrive from the React board or
  the terminal, raced fairly ("first to respond wins"); the gateway writes the durable per-task list
  entry **before** the pub/sub publish, and the board is ACK'd only after both succeed. **Value:** a
  missed pub/sub message stays recoverable via the list fallback, so an approval is never silently lost.
- **Hardened HITL loop (v2.0 fix).** The terminal prompt no longer re-arms after a decision or stdin
  EOF, fixing a `REVISE` infinite re-prompt spin (100% CPU, unkillable process) and restoring the
  second gate on the revised draft. **Value:** the revise/re-execute cycle is dependable under real
  operator use.

### 2.5 Governance & compliance

- **Governance Action Gate (new in v2.0; default-off, non-bypassable when enabled).** Every sensitive
  operation (`tool-call` / `outbound-message` / `memory-write`) passes `ActionGate.evaluate`, which
  runs an ordered validator chain and returns the most severe verdict
  (`allow < degrade < escalate < block < terminate`). **Value:** a single, composable enforcement spine
  for policy—when on, there is no per-request opt-out, so the audit is always complete; when off, it is
  a true no-op, preserving backward compatibility.
- **Hot-path enforcement in the deployed actor (ADR-021).** When governance is enabled, the
  `AgentActor` consults an `IAdmissionGate` as a pre-execution guard; a `block` verdict routes the task
  to the DLQ (`blocked_by_admission_gate`) **without running the handler**. **Value:** disallowed
  actions are stopped before any tokens are burned—governance is enforced, not merely advisory.
- **Hash-chained, tamper-evident audit (`AuditLog`).** Append-only, SHA-256-chained records;
  `verify()` recomputes the chain and pinpoints the first broken index. **Value:** any after-the-fact
  tampering with a recorded decision is detectable—an auditable trail rather than mutable logs.
- **Policy-as-code (`PolicyEngine` / `policies.yml`).** Ordered, first-match-wins rules matching on
  operation, agent, and payload substrings, hot-reloadable. **Value:** security/compliance teams change
  what agents may do by editing a YAML file, no redeploy required.
- **Agent registry + kill-switch (PDLSS).** Each agent carries Purpose / Duration / Limit / Scope /
  Self-instantiation metadata; `revoke()` is an instant kill-switch that blocks expired, over-limit,
  out-of-scope, or revoked agents. **Value:** a misbehaving agent can be stopped fleet-wide in one
  call, and short-lived/scoped agents enforce least privilege by construction.
- **Secure, classified memory store.** `SecureMemoryStore` is tenant-keyspaced (no cross-tenant
  reads), with per-entry provenance + trust, classification (`public`/`internal`/`confidential`),
  retrieval-time RBAC, TTL eviction, min-trust filtering, and `revoke()` for poisoned entries.
  **Value:** memory poisoning and cross-tenant leakage—two of the headline agentic-AI risks—are
  contained at the storage layer.
- **Standards & compliance posture.** The project maps to OWASP ASVS 5.0, the OWASP LLM/Agentic Top
  10, and NIST AI RMF/SSDF (see [`docs/COMPLIANCE.md`](COMPLIANCE.md),
  [`docs/security/ASVS-5.0-checklist.md`](security/ASVS-5.0-checklist.md)). **Value:** teams get a
  documented cross-walk to recognized frameworks—stated honestly as a *capability* of a "library/
  runtime, not a certified product."

### 2.6 Economics / FinOps cost control

- **Fleet-wide rate + cost limiter (new in v2.0; default-off).** `RateCostLimiter` enforces request-
  rate and cost budgets across the tightest binding scope (global + per-tenant + per-agent), backed by
  `rate-limiter-flexible` with an injectable store (in-memory for one node, Redis for a fleet).
  **Value:** a runaway loop or a bad prompt can't quietly burn the monthly budget—spend is capped
  fleet-wide, complementing (never replacing) the existing per-task token accounting.
- **Pre-execution admission control (`CostReservation`).** Before a step runs, it returns
  `allow` / `degrade` / `reject`: over-budget rejects (the step never executes, no tokens spent),
  budget pressure at/above a threshold degrades to a cheaper model ("run cheaper," not "don't run").
  **Value:** cost is enforced *before* the LLM call, and the system gracefully trades quality for
  budget instead of hard-failing. Multi-scope reservations compensate so no partial reservation leaks.
- **Workflow budget guard.** `MAX_WORKFLOW_COST_USD` / `MAX_WORKFLOW_TOKENS` are checked between every
  phase and before each revision in both example orchestrators; a breach yields a **graceful STOPPED**
  state (default `0.50` in the example compose files; `0` = unlimited). **Value:** an end-to-end
  workflow has a hard ceiling and exits cleanly on breach rather than overspending.
- **Prompt-cache accounting & model right-sizing.** `priceUsage`/`effectiveCacheHitRate` bill cached
  input tokens at the provider's discount and surface the saving; `routeModel`/`estimatedStepCost` pick
  a model by capability and context window weighted by budget pressure. **Value:** accurate unit costs
  and automatic right-sizing—pay for the smallest model that can do the job, and see what caching saves.
- **Accurate model pricing.** `estimateCost` normalizes OpenRouter slugs and dated model suffixes
  before the `MODEL_PRICING` lookup and warns on a default-pricing fallback. **Value:** cost figures on
  the board reflect what you'll actually be billed, not a silent mis-priced estimate.

### 2.7 Resilience & operations

- **Retry → DLQ with a typed taxonomy.** Tasks retry 3× (linear backoff) then land in
  `kaiban-events-failed`; the DLQ distinguishes retries-exhausted from non-retryable poison
  (firewall-block, breaker-open). **Value:** transient failures self-heal, and genuinely bad messages
  are quarantined instead of crash-looping the consumer.
- **Safe DLQ replay.** `src/resilience/dlq-replay.ts` replays only the retries-exhausted class and
  **skips non-retryable poison**. **Value:** an operator can recover from an outage without re-injecting
  prompt-injection or breaker-tripping messages.
- **Health & lifecycle probes.** `/health`, plus `/ready` (Redis + broker reachable) and `/startup`
  probes, and a deadline-bounded **graceful shutdown** (stop intake → drain → finish acks → flush →
  close). **Value:** clean Kubernetes readiness/startup signalling and a drain that a hung dependency
  can't wedge—safe rolling deploys.
- **Circuit breaker.** `SlidingWindowBreaker` opens after a threshold of failures in a window
  (default 10 / 60 s, opt-in). **Value:** a failing downstream (LLM provider, tool) is shed quickly
  instead of amplifying load and cascading.
- **Per-task timeout with AbortSignal cancellation (v2.0).** A 5-minute default timeout, and an
  in-flight LLM call is **actually aborted** on timeout or `tasks/cancel` (the bridge owns the LLM
  instance). **Value:** a stuck inference is cancelled rather than left running and billing—and an
  external caller can cancel a task and have the work stop.
- **Chaos / fault-injection mode.** `--chaos` crashes ~20% of searchers mid-flight; the broker's
  job-lock TTL reassigns the task. The `test:e2e:chaos` suite pauses the Redis broker mid-flight and
  asserts every buffered publish flushes on recovery with **zero dropped agent messages**. **Value:**
  fault tolerance is demonstrated, not just claimed—you can watch the swarm recover.
- **Single-image role split.** One container runs as `ROLE=gateway|worker`. **Value:** one artifact to
  build, sign, and scan; the deployment chooses the role.

### 2.8 Security

- **Opt-in, default-off, fail-closed posture.** Every security control is enabled by an env var and is
  off unless configured; in production, unset secrets cause a fail-closed error rather than silent
  insecurity. **Value:** zero-config local dev stays frictionless, while a misconfigured production
  deploy is caught instead of running wide open.
- **Semantic firewall (ASI01).** `HeuristicFirewall` matches 10 prompt-injection / goal-hijack regex
  patterns and routes hits to the DLQ with no retry. **Value:** a first, cheap line of defense against
  the most common agent goal-hijack attempts, before the LLM ever sees the payload.
- **JWT auth & signed channels.** HS256 JWT for the board and A2A surfaces; HMAC-SHA256 channel
  signing with a 30-second anti-replay window and constant-time comparison (`timingSafeEqual`).
  **Value:** only authenticated callers reach the gateway, and forged or replayed Redis messages are
  rejected—integrity for the message bus itself.
- **Gateway & transport hardening.** Helmet/CSP/HSTS, 1 MB body limit, 30 s request timeout, rate
  limiting (100 req/min/IP for RPC), strict input validation (`agentId` ≤ 64 chars `/^[\w-]+$/`,
  `instruction` ≤ 10 000), a WebSocket origin allowlist (throws in prod if unset), and TLS/mTLS hooks
  for Redis and Kafka. **Value:** the public edge is locked down to a small, validated surface.
- **JIT / ephemeral credentials (ASI03).** `EnvTokenProvider` resolves per-task API keys (with a path
  to Vault/AWS Secrets Manager). **Value:** long-lived secrets aren't baked into every actor; identity
  abuse has a narrower blast radius.
- **Byte-accurate data caps & PII minimization.** A 64 KB outbound-message cap and 20 KB state-event-
  result cap measured in **UTF-8 bytes** (truncating on codepoint boundaries), SHA-256-hashed agent IDs
  in logs, and `sanitizeDelta` PII stripping (email/name/phone/IP/secrets) on the state path. **Value:**
  one chatty actor can't congest the broker, and the observable stream meets GDPR data-minimization by
  default.
- **Supply-chain security.** The published library ships **0 HIGH/CRITICAL advisories**; the release
  flow produces a CycloneDX SBOM, SLSA provenance, and a Sigstore cosign signature, with Trivy image
  scanning, gitleaks, OSV-Scanner, and CodeQL in CI. **Value:** downstream consumers get a verifiable,
  signed, attested artifact—not an opaque tarball.

### 2.9 Observability

- **Observability *is* the read-model, not a bolted-on stack.** The React board and CLI monitor
  consume the same Redis/Kafka state stream that operators and auditors need; "the board is the
  tactical command centre, the bus is the strategic data asset." **Value:** there is one source of
  truth for live state, history, and audit—you don't maintain a parallel telemetry pipeline that can
  drift from reality.
- **OpenTelemetry traces & metrics.** OTLP-exportable traces plus a `kaiban.message.processed` counter
  and `kaiban.message.latency` histogram, emitted from the actor's success/DLQ paths (GenAI semantic
  conventions; LLM-native Langfuse export is a v2.1 roadmap item). **Value:** AI workflows are monitored
  with the same rigor as any microservice—latency, throughput, and per-step cost attribution into your
  existing observability backend.
- **Anomaly events.** `recordAnomalyEvent` surfaces `circuit_breaker.rejected` and
  `firewall.blocked` at the actor level. **Value:** security-relevant events are first-class telemetry,
  not buried log lines.
- **Structured logging (pino).** JSON logs with PII redaction, child loggers, level via `LOG_LEVEL`,
  and an opt-in pretty mode—rolled out across every production module. **Value:** machine-parseable,
  redacted operational logs in production, readable output for local demos.
- **Real-time React board + CLI monitor.** A live Kanban view (agent status badges, task columns, an
  economics panel of tokens/cost/duration, an event log, and the HITL modal), plus a terminal monitor
  streaming state events, queue depths, and Kafka lag. **Value:** humans can supervise, diagnose
  bottlenecks, and intervene without tailing logs or querying a database.

### 2.10 Developer experience & packaging

- **Clean / hexagonal architecture (4 layers + shared).** `domain` (no framework imports) ←
  `application` ← `adapters`/`infrastructure`, with cross-cutting `shared`. **Value:** swapping
  Redis↔Kafka or KaibanJS↔another agent framework touches only the infrastructure layer—the system is
  built to evolve without rewrites.
- **Dual-license, library-grade packaging (v2.0).** The published npm artifact is **Apache-2.0**,
  CORE-ONLY, with a curated public barrel (`.`) and a `./shared` subpath export, built by a two-entry
  api-extractor and packed from a staging dir so no GPL example/board code leaks. **Value:** the
  permissive license and tight surface make it safe to depend on commercially, while the full app stays
  GPL-3.0.
- **Curated, drift-checked public API.** `@microsoft/api-extractor` tracks `etc/*.api.md` and CI fails
  on undocumented public-API drift. **Value:** consumers get a stable, intentional API; accidental
  breaking changes are caught before release.
- **Turn-key examples and scripts.** `./scripts/blog-team.sh` and `./scripts/global-research.sh`
  (`start`/`stop`, `--docker`, `--kafka`, `--chaos`, `--searchers N`), a `monitor.sh` CLI, and a
  `smoke-consumer.sh` that packs the Apache tarball and verifies a fresh consumer can import both entry
  points. **Value:** the whole distributed stack comes up with one command, and packaging is verified
  the way a real consumer would use it.
- **Typed, throw-free error flow.** A `Result<T,E>` monad and typed `DomainError`s in the domain
  layer. **Value:** errors cross layer boundaries as values, not surprises—predictable handling.
- **Strict quality posture.** TypeScript strict mode, ESLint zero-warnings with cyclomatic complexity
  ≤ 10, no `any`, madge (no circular imports). **Value:** the codebase stays legible and maintainable
  as it grows.

---

## 3. What's new since 1.0 — the 2.0.0 leap

The 1.x line was a working distributed actor runtime with the Kanban board, BullMQ/Kafka drivers, a
custom A2A connector, an MCP *client*, env-gated security controls, and a full CI/supply-chain gate.
**v2.0 turns it from a runtime into a federated, governed, cost-aware platform.** Headline changes
(from [`CHANGELOG.md`](../CHANGELOG.md) `[2.0.0]` and the ADRs):

- **Standards-conformant A2A v0.3 federation (ADR-015).** Replaced the custom, non-standard
  `tasks.create`/`tasks.get`/`agent.status` method set with the official `@a2a-js/sdk` v0.3 server
  (`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`) and a v0.3 AgentCard. **Value:** real
  interoperability with the A2A ecosystem instead of a bespoke protocol.
- **First-party MCP server (ADR-017).** A new inbound MCP surface (Tools/Resources/Prompts/Elicitation)
  over Streamable HTTP, default-off, behind the gateway's security chain. **Value:** the fleet is now
  consumable by any MCP host, with consent-gated, least-privilege tool exposure.
- **Resilience layer promoted into the library (ADR-018).** The single-active orchestrator moved from
  `examples/` into `src/shared` with Redis checkpoint/resume, plus readiness/startup probes, graceful
  drain, and safe DLQ replay. **Value:** crash-safe core workflows and clean k8s lifecycle—reusable, not
  copy-pasted into each example.
- **Economics / FinOps layer (ADR-019).** Fleet-wide rate + cost limiting and pre-execution cost
  reservation, default-off. **Value:** spend is enforceable before the LLM call, fleet-wide.
- **Governance Action Gate + hot-path enforcement (ADR-020/021).** Hash-chained audit, policy-as-code,
  agent registry/kill-switch, and a non-bypassable gate wired into the actor's execution loop—default
  off, fail-closed on a throwing validator. **Value:** enforceable, auditable control over what agents
  may do, with no token spend on blocked actions.
- **Workflow budget guard.** `MAX_WORKFLOW_COST_USD` / `MAX_WORKFLOW_TOKENS` with graceful STOPPED on
  breach. **Value:** a hard, end-to-end ceiling on a whole workflow.
- **AbortSignal cancellation (ADR-014).** In-flight LLM calls are aborted on timeout or cancel.
  **Value:** stuck inferences stop billing and external cancellation actually halts work.
- **Dual-license, Apache-2.0 core (ADR-011, BREAKING).** The published npm library is now Apache-2.0
  (was GPL-3.0); the full app/board/examples stay GPL-3.0, with a `./shared` subpath export and
  GPL-leak-proof staging-dir packaging. **Value:** safe to adopt as a commercial dependency.
- **Gateway/worker role split (ADR-013)** and **universal AMQP driver seam (ADR-016, stub).** **Value:**
  one image, role chosen at deploy; a declared extension point for a third broker.
- **Dependency refresh & 0 vulnerabilities (ADR-012).** KaibanJS 0.24.2, TypeScript 6.0, OpenTelemetry
  0.219/0.77, BullMQ 5.79, dotenv 17—all latest stable. **Value:** a modern, clean-audit baseline.
- **Hardening & correctness fixes.** The HITL re-arm/infinite-spin fix, terminal-STOPPED on hard
  failure (board no longer hangs on RUNNING), byte-accurate data caps, structured-output stringify,
  accurate model pricing, NaN-safe config parsing, and a fan-out result↔index mapping fix. **Value:**
  the long-running, human-gated, failure-prone paths behave correctly under real use.

> The published v2.0 surface is verified locally at **108 test files / 1155 unit tests / 100% coverage
> of `src/**`** (see [`docs/VERIFICATION.md`](VERIFICATION.md)); the e2e (real-broker), mutation,
> visual, and supply-chain gates run in CI. GA tag/merge to `main` is the maintainer's final step.

---

## 4. First-of-its-kind / differentiated

This section is deliberately careful: claims are marked **[believed first]**, **[novel combination]**,
or **[differentiated]** rather than overstated, and each cites repository evidence. Competitor
comparisons are framed cautiously—the agent-framework landscape moves fast.

- **[novel combination] One JavaScript/TypeScript runtime that unifies enterprise messaging
  (Kafka/Redis) + true actor-model process isolation + multi-agent orchestration + Kanban
  visualization + A2A/MCP federation—with default-off governance and economics layered on top.** Each
  ingredient exists elsewhere; the project's own positioning is that combining *all* of them in a
  single JS-ecosystem runtime is rare ("one of the first open-source projects to combine…", README/
  master-plan §B1.1). The runtime is honest that it is *"one of the first,"* not *"the very first in the
  world."*
- **[differentiated] Agents are stateful, individually-deployed actors—not scripts or graph nodes.**
  Most JS agent frameworks (and many Python ones) model an agent as a function or a node in a
  centralized graph executed in one process. Here, each agent is its own OS process with a mailbox,
  communicating only by message ("what messages does this agent react to, and what messages does it
  emit?"). Unlike DAG/graph orchestration (e.g. LangGraph-style centralized graph state), this gives
  inherent isolation, "let it crash" supervision, and horizontal-native scale. The project positions
  itself as the **JS-side member of the actor-runtime family** (Erlang/OTP, Akka, Orleans), noting that
  AutoGen v0.4 made the same "agents = actors" bet in Python—offered as independent confirmation, not as
  a claim of priority.
- **[differentiated] HITL as a first-class workflow column, federation, and the message bus as the
  audit/observability source of truth—integrated, not bolted on.** "HITL is a column, not a callback";
  "observability is the read-model, not a separate stack." Many frameworks bolt approval gates and
  telemetry on as side channels; here they are properties of the same state machine and message stream
  that the board, the auditors, and OpenTelemetry all consume.
- **[differentiated] Governance and economics that are genuinely default-off yet non-bypassable when
  enabled, and enforced on the deployed actor's hot path before tokens are spent.** A hash-chained
  audit, policy-as-code, an instant kill-switch, fleet-wide cost reservation, and admission-gate
  enforcement that routes blocked work to the DLQ without running the handler (ADR-019/020/021) is an
  unusually complete control plane to find inside an open-source JS agent runtime—while staying a true
  no-op when disabled (a hard invariant with backing tests).
- **[differentiated] Transport-agnostic by contract: swap Redis ↔ Kafka with zero worker code
  changes**, with state/HITL channels deliberately pinned to Redis Pub/Sub regardless of driver. The
  MAL + five-channel contract is a stronger separation than many agent frameworks, which couple
  orchestration to one transport.

**What is *not* claimed:** this is not a durable-execution engine in the Temporal sense (the
orchestrator is single-active per workflow with checkpoint/resume, **not** HA—orchestrator HA is
roadmap), nor a general-purpose actor system like Ray or Akka (it is an *AI-agent* runtime built on
those ideas). The differentiation is the **synthesis** for AI agents in the JS ecosystem, not the
invention of any one primitive.

---

## 5. Full feature catalog (everything else)

A fuller enumeration of remaining capabilities, all present in the repository:

**Messaging & drivers**
1. `IMessagingDriver` abstraction + `createDriver()` factory selected by `MESSAGING_DRIVER`.
2. `BullMQDriver` (Redis): default; job-retention defaults, optional TLS, no-colon queue names, worker `error` listener.
3. `KafkaDriver`: unique consumer group per role, optional SSL/mTLS, poison-message skip, explicit one-topic-per-driver contract.
4. **Universal AMQP driver seam** (`amqplib`): declared, unimplemented stub, coverage-excluded—an explicit extension point (ADR-016).
5. Shared `sanitizeTraceHeaders` for W3C trace-header parity across both drivers.
6. `CompletionRouter` with lazy subscription, duplicate-`wait()` rejection, and `taskId`-keyed dispatch.

**Channels, state & checkpoint/resume**
7. Five canonical channels with the durable/ephemeral split (durable broker vs. Redis Pub/Sub).
8. `AgentStatePublisher` (IDLE/THINKING/EXECUTING/ERROR + task deltas, 15 s heartbeat) and `OrchestratorStatePublisher` (workflow lifecycle).
9. `DistributedStateMiddleware` intercepts Zustand `setState()` and publishes PII-stripped deltas.
10. Redis checkpoint→resume in the single-active orchestrator; idempotent re-advance by `taskId`.
11. DLQ (`kaiban-events-failed`) with a typed taxonomy and safe replay (skips non-retryable poison).

**Federation**
12. A2A v0.3 server stack (`buildA2AStack`: executor + `RedisTaskStore` + `AgentStatusTracker`), JSON-RPC + REST + gRPC interfaces advertised, SSE streaming, input caps (`A2A_INPUT_CAPS`, 64 KB).
13. MCP server (`buildMcpServer`/`createMcpHttpHandler`): Streamable HTTP, stateful sessions, least-privilege `MCP_ALLOWED_*`, elicitation consent, curated tools/resources/prompts.
14. `MCPFederationClient` outbound stdio client for external MCP tools.

**Resilience & ops**
15. Retry (3× linear backoff) → DLQ; 5-minute per-task timeout; AbortSignal cancellation.
16. `SlidingWindowBreaker` circuit breaker (threshold 10 / 60 s, opt-in).
17. `/health`, `/ready`, `/startup` probes; deadline-bounded graceful shutdown.
18. `dlq-replay.ts` operator recovery; **chaos mode** (`--chaos`, ~20% searcher crash) + a chaos e2e suite asserting zero dropped messages on broker pause/resume.
19. Single `ROLE=gateway|worker` image; per-service Docker Compose; K8s/Helm with HPA (in the example infra).

**Security**
20. Semantic firewall (ASI01), circuit breaker (ASI10), JIT tokens (ASI03), all env-gated via `buildSecurityDeps`.
21. Board/A2A JWT (HS256), HMAC-SHA256 channel signing with 30 s anti-replay + constant-time compare.
22. Helmet/CSP/HSTS, body/timeout/rate limits, WS origin allowlist, A2A input validation, TLS/mTLS hooks.
23. Byte-accurate 64 KB / 20 KB data caps, SHA-256-hashed agent IDs in logs, `sanitizeDelta` PII strip.
24. Non-root `kaiban` container user; stripped runtime npm CLI; `apk upgrade` base-CVE self-heal.

**Governance & economics**
25. Action Gate, hash-chained `AuditLog`, `PolicyEngine` + `policies.yml`, `AgentRegistry` kill-switch, `SecureMemoryStore`.
26. `RateCostLimiter`, `CostReservation` (allow/degrade/reject), `priceUsage`/cache accounting, `routeModel` right-sizing.
27. Workflow budget guard (`MAX_WORKFLOW_COST_USD`/`MAX_WORKFLOW_TOKENS`) + per-agent `MAX_TOKEN_BUDGET`.

**Observability & board**
28. React 18 + Vite + Tailwind + Zustand board (agent grid, 5-column Kanban, HITL modal, economics panel, event log), runtime-configurable gateway URL.
29. Zero-setup static HTML board viewer; custom Socket.io client recipe; `KaibanTeamBridge` local-Team option.
30. CLI `monitor.sh` (state events, logs, queue depths, Kafka lag).
31. OpenTelemetry traces + `kaiban.message.{processed,latency}` metrics; anomaly events; structured pino logging.

**Examples**
32. **blog-team** — researcher → writer → editor with a HITL editorial gate (ADR-004).
33. **global-research** — fan-out/fan-in searcher/reviewer/writer/editor swarm with `--chaos` and `--searchers N`; the reviewer checks IEEE AI 7000 / EU AI Act / GDPR / OWASP AI / NIST AI RMF framing.

**Developer experience, packaging & quality**
34. Clean/hexagonal 4-layer architecture; `Result<T,E>` monad + typed `DomainError`s.
35. Apache-2.0 CORE-ONLY publish; `.` + `./shared` exports; two-entry api-extractor with committed `etc/*.api.md`; staging-dir pack; `smoke-consumer.sh`.
36. Strict TypeScript, ESLint zero-warnings (complexity ≤ 10, no `any`), madge no-cycles gate.
37. **Test/quality posture:** 100% `src/**` coverage (108 files / 1155 unit tests verified), `fast-check` property tests, `supertest` gateway tests, Stryker mutation testing on the domain layer (~96.6% score), micro-benchmarks, board Vitest + `vitest-axe` a11y + Playwright visual baselines.
38. **Supply chain / SLSA:** CycloneDX SBOM, SLSA provenance, cosign keyless signing, Trivy image scan, gitleaks, OSV-Scanner, CodeQL, OpenSSF Scorecard; `npm audit` blocking on HIGH+.
39. 21 ADRs (`docs/decisions/ADR-001..021`) recording every significant decision; a `MIGRATION.md`, `COMPLIANCE.md`, `VERIFICATION.md`, and a `docs/roadmap/V2.1-ROADMAP.md`.

---

## 6. Roadmap (explicitly not yet built)

From [`docs/roadmap/V2.1-ROADMAP.md`](roadmap/V2.1-ROADMAP.md) — all **PLAN**, opt-in / default-off,
and additive:

- **Federation-egress enforcement (ADR-022):** extend the Action Gate to outbound A2A/MCP traffic so
  policy/kill-switch/cost apply symmetrically to what agents emit, not just what they receive.
- **Default-wired fleet cost limiter (ADR-023):** turnkey Redis-backed fleet cost enforcement when
  `ECONOMICS_ENABLED=true`, without forcing each consumer to inject a limiter.
- **Universal CloudEvents/AsyncAPI messaging schema (ADR-024, centerpiece):** a versioned, schema-
  enforced, driver-agnostic event envelope (CloudEvents) with an AsyncAPI contract for the five
  channels and in-MAL validation—the "OpenAPI for the agent message bus."
- **Further backlog (post-2.1):** typed/episodic memory, a carbon/energy metric, MCP Roots/OAuth 2.1,
  the A2A v1.0 wire format, multi-tenant isolation, a cross-broker schema registry, event-sourcing/CQRS,
  a durable-workflow engine, a Ragas evaluation sidecar, and an LLM prompt-injection classifier — each
  deferred, not dropped (master plan §B6).

---

*Grounded in the kaiban-distributed repository at v2.0.0 (`feat/v2.0`) and the author's *Agentic AI Architectures* book.*
