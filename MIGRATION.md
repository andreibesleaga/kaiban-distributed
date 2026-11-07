# Migration guide

Where to start: upgrading from 2.1.2, read [2.1.2 → 2.1.3](#212--213-documentation-and-configuration) (no action needed); from 2.1.1, read [2.1.1 → 2.1.2](#211--212-audit-fixes) first; from 2.0.x, read
[2.0.x → 2.1.0](#20x--210-emergency-stop-all-additive), then 2.1.0 → 2.1.1, then 2.1.1 → 2.1.2; from 1.x, read the v2.0
section below (v1.x → v2.0), then the 2.1 sections. The 2.1 sections run newest first. For
2.0.1 and 2.0.2 operator changes see [CHANGELOG.md](CHANGELOG.md): production boot refuses missing, short or repeated
signing secrets, tokens carry a `role` claim, `RETRY_ON_TIMEOUT` is new (default off) and Kafka workers send heartbeats.

## v1.x → v2.0

> v2.0 is a **major** release with breaking changes. This guide covers every breaking change.
> **Status:** `v2.0.0` was released on 2026-06-22. This guide was written during development on
> `feat/v2.0`, one entry per §B8 phase; changes after 2.0.0 are in `CHANGELOG.md`.
>

## Licensing (Phase 0)
- The **published npm library** is now **Apache-2.0** (was GPL-3.0). The full application / board /
  examples / repo aggregate remains **GPL-3.0**. See `LICENSING.md` + `docs/decisions/ADR-011`.
  No code change for consumers — `kaiban-distributed` is now usable under Apache-2.0.

## Dependencies (Phase 0)
- KaibanJS `0.23.1` → **`0.24.2`**; TypeScript `5.9` → **`6.0`** (build-time only); OpenTelemetry,
  bullmq, and dotenv bumped to latest stable. No public-API change. See `docs/decisions/ADR-012`.
- TS7-readiness tech-debt: the build temporarily sets `ignoreDeprecations: "6.0"` for
  `moduleResolution: node10` + `baseUrl` (removed in TS 7).

## Breaking changes (filled in as phases land)
- [x] **Phase 1.1** — gateway/worker split: the single Docker entrypoint becomes `ROLE=gateway|worker`.
      The image picks a role at runtime via the `ROLE` env var (default `gateway`).
      **Action:** worker deployments MUST set `ROLE=worker`; gateway deployments may set `ROLE=gateway`
      (the default). `AgentActor` now **throws on `start()` without a task handler** (the old silent
      no-handler fallback that discarded tasks is removed). See `docs/decisions/ADR-013`.
- [x] **Phase 1.2** — `TaskHandler` signature gains an `AbortSignal`:
      `(payload, signal?: AbortSignal) => Promise<unknown>`. The actor aborts the signal on
      timeout / shutdown so the in-flight LLM call stops burning tokens. The KaibanJS bridge wires
      this automatically by **owning the LangChain `ChatOpenAI` instance**. New direct dependency:
      `@langchain/openai ^0.5.7` (was transitive). See `docs/decisions/ADR-014`.
- [x] **Phase 1.3** — A2A input validation hardened: every `tasks.create` field is validated for
      **type and size**, the **total serialized params byte size is capped** (64 KB OOM guard), and
      **only the validated, size-capped payload is forwarded** (never raw `params`). Oversized /
      wrongly-typed input is rejected with JSON-RPC `-32602`. Caps exported as `A2A_INPUT_CAPS`.
- [x] **Phase 2** — A2A now runs on the **official `@a2a-js/sdk` v0.3** server; the custom
      `A2AConnector` is **removed** (no compat shim). See `docs/decisions/ADR-015`.
      **Wire changes (breaking):**
      - **Methods** are the v0.3 names on `POST /a2a/rpc`: `message/send`, `message/stream` (SSE),
        `tasks/get`, `tasks/cancel`. The old `tasks.create` / `tasks.get` / `agent.status` JSON-RPC
        methods are **gone**. To dispatch a task, send `message/send` with the target agent in
        `message.metadata.agentId` (and optional `instruction`/`expectedOutput`/`context`/`inputs`,
        or plain text parts). Input caps (`A2A_INPUT_CAPS`) + `-32602` rejection are preserved.
      - **AgentCard** at `/.well-known/agent-card.json` is the **v0.3 shape**
        (`protocolVersion`, `url`, `preferredTransport`, object `capabilities`, `skills[]`,
        `securitySchemes`, `additionalInterfaces[]`) — not the legacy
        `{ capabilities: string[], endpoints: { rpc } }`.
      - **`agent.status`** moved off JSON-RPC to `GET /a2a/agents/:agentId/status`, now returning the
        **real** last-known status (de-stub). `tasks/get` returns the **real** persisted task from a
        Redis-backed `TaskStore` (de-stub).
      - **Library API:** `A2AConnector` export removed. New exports: `buildA2AStack`,
        `KaibanAgentExecutor`, `RedisTaskStore`, `AgentStatusTracker`, `buildAgentCard`,
        `validateTaskInput`/`A2A_INPUT_CAPS`. `GatewayApp` constructor shape changed from
        `new GatewayApp(connector, opts)` to `new GatewayApp({ requestHandler, statusTracker, trustProxy })`.
      - **New dependency:** `@a2a-js/sdk ^0.3` (Express peer already present).
      - **Deferred to a later beta (Phase A):** signed-AgentCard JWS verify, push-notification webhook
        delivery (only the capability flag ships), and the gRPC transport binding.
- [x] **Phase 3** — `MESSAGING_DRIVER=amqp` recognized as an **unimplemented universal-AMQP seam**
      (`AmqpDriver` stub throws on use; coverage-excluded; `AmqpDriver` is exported). BullMQ/Redis +
      Kafka are unchanged and remain the two real drivers. See ADR-016 + `docs/messaging/AMQP.md`.
- [x] **Phase 4a** — packaging: the library adds a **`./shared`** subpath export
      (`import … from "kaiban-distributed/shared"`) alongside `.`. **Additive** — no breaking change.
- [x] **Phase R (BETA.2)** — resilience: a reusable **single-active orchestrator** (Redis
      checkpoint→resume, idempotent) moves into `src/shared` and is exported
      (`kaiban-distributed/shared`); the examples now consume it instead of duplicating it. The gateway
      serves **`/ready` + `/startup`** probes and `GatewayApp` gains optional
      `readinessProbe`/`startupProbe` deps. Graceful-shutdown + DLQ-replay helpers added
      (`src/resilience/*`). Additive for library consumers. See ADR-018.
- [x] **Phase M (BETA.2)** — MCP **server**: a first-party Model Context Protocol surface exposing
      allow-listed **Tools** (`dispatch_task`) + **Resources** (`kaiban://agents`,
      `kaiban://agents/{agentId}/status`) + **Prompts** (`delegate_task`) + **Elicitation** (HITL
      consent) over **Streamable HTTP**, mounted on the gateway at `MCP_SERVER_PATH` (default `/mcp`)
      behind the existing helmet + rate-limit + JWT chain. **Env-gated OFF by default**
      (`MCP_SERVER_ENABLED`; `MCP_DISPATCH_CONSENT` fail-closed; optional
      `MCP_ALLOWED_{TOOLS,RESOURCES,PROMPTS}` least-privilege filters — see `.env.example` +
      `docs/federation/MCP.md`). Dispatch reuses the A2A `validateTaskInput` caps (no `taskId` dedup).
      **New direct dependency:** `zod ^4.4.3` (already present transitively via the MCP SDK).
      **Library API (additive):** new exports `buildMcpServer`, `createMcpHttpHandler` + the `Mcp*`
      types and `MCP_*` capability-name constants; `McpConfig` added to `AppConfig`. A2A stays the
      public front door; MCP is the internal surface. See `docs/decisions/ADR-017`.
- [x] **Phase E (BETA.3)** — economics/FinOps: a **fleet-wide** cost-control layer in `src/economics/`
      (`RateCostLimiter`/`CostLimiterPort` over `rate-limiter-flexible`; `CostReservation` pre-exec
      admission with degrade-at-threshold; `priceUsage`/`effectiveCacheHitRate` prompt-cache accounting;
      `routeModel`/`estimatedStepCost` right-sizing; `detectSpendAnomaly`). **Default-OFF**
      (`ECONOMICS_ENABLED`; `_MAX_REQUESTS_PER_WINDOW`/`_MAX_COST_PER_WINDOW`/`_GLOBAL_COST_CEILING`/
      `_WINDOW_SECONDS`/`_DEGRADE_THRESHOLD`; `0` = unlimited — see `.env.example` +
      `docs/economics/ECONOMICS.md`). **Per-task accounting + the board economics panel are unchanged**
      (§B1.3 COST guard). **New direct dependency:** `rate-limiter-flexible ^11.2.0`. **Library API
      (additive):** new exports `RateCostLimiter`, `CostReservation`, `priceUsage`,
      `effectiveCacheHitRate`, `routeModel`, `estimatedStepCost`, `detectSpendAnomaly` + the
      `src/economics/types` contract; `economics` added to `AppConfig`. See `docs/decisions/ADR-019`.
- [x] **Phase G (BETA.3)** — governance & enforcement: a **default-OFF** Action Gate spine in
      `src/governance/` + memory hardening in `src/memory/`. `ActionGate` runs an ordered set of
      `GateValidator`s and returns the most-severe of allow/degrade/escalate/block/terminate, recording
      each decision to a **hash-chained (SHA-256) tamper-evident** `AuditLog`. Ships `PolicyEngine` +
      `loadPolicySet` (policy-as-code, `policies.yml`), `AgentRegistry` (PDLSS **kill-switch**), the
      `firewallValidator`/`breakerValidator`/`costValidator` adapters (compose the existing firewall +
      breaker + **Phase-E cost reservation**), and `SecureMemoryStore` (tenant keyspaces, provenance/
      trust tags, retrieval-time RBAC, TTL eviction, revoke-poisoned-entry). **Opt-in / no-op when
      unconfigured; non-bypassable when enabled** (`GOVERNANCE_ENABLED` / `GOVERNANCE_POLICIES_PATH` —
      see `.env.example` + `docs/governance/GOVERNANCE.md`). **New direct dependency:** `yaml ^2.9.0`.
      **Library API (additive):** the governance + memory modules + the `src/governance/types` contract
      are exported; `governance` added to `AppConfig`. See `docs/decisions/ADR-020`.
- [x] **Phase G hot-path enforcement (BETA.3)** — the governance Action Gate is now wired into the
      **AgentActor execution loop**. New domain port `IAdmissionGate` (`src/domain/security/admission-gate.ts`);
      `AgentActorDeps` gains an optional `admissionGate` consulted as a 3rd pre-execution guard (after
      breaker + firewall) — a block routes the task to the DLQ (`blocked_by_admission_gate`) without
      running the handler. `buildSecurityDeps` wires policy-as-code enforcement into every worker when
      `GOVERNANCE_ENABLED` (default-OFF; behavior-preserving when unset). **Library API (additive):**
      new exports `IAdmissionGate`/`AdmissionVerdict` + `buildAdmissionGate`/`buildWorkerAdmissionGate`.
      Cost-reservation enforcement is added when a fleet `CostLimiterPort` is injected. See
      `docs/decisions/ADR-021`.

## 2.1.2 → 2.1.3 (documentation and configuration)

No action needed. The library API is unchanged.

1. **Docker Compose passes more settings.** `NODE_ENV`, `A2A_JWT_SECRET`, `TRUST_PROXY`, `LOG_LEVEL`, `AGENT_TIMEOUT_MS`,
   `RETRY_ON_TIMEOUT`, `MCP_SERVER_ENABLED` and `MCP_DISPATCH_CONSENT` in your `.env` now reach the containers. Check your
   `.env` before you restart: a `NODE_ENV=production` line that had no effect before now makes the services refuse to start
   without the three secrets (see 2.1.1 → 2.1.2, item 1).
2. **Helm charts have optional settings.** `config.*` keys (empty = the code default), `secrets.A2A_JWT_SECRET`, and
   `secrets.create=false` to use a Secret you create yourself. With the default values the charts render the same objects
   as 2.1.2, except that the global-research gateway now reads the chart Secret.

## 2.1.1 → 2.1.2 (audit fixes)

Four operator-facing changes; everything else is a bug fix that needs no action.

1. **Production control plane needs the signing secret.** With `NODE_ENV=production` and
   `CONTROL_PLANE_ENABLED=true`, a node refuses to start unless `CHANNEL_SIGNING_SECRET` is set
   (or `ALLOW_INSECURE_PRODUCTION=true`). Set the same secret on every gateway, worker and
   orchestrator, and in the shell that runs `npm run stop-all`.
2. **`REDIS_URL` credentials are now used everywhere.** A password, user, database number or
   `rediss://` scheme in `REDIS_URL` now reaches the BullMQ task queues too (before, only the
   state and control clients used them). If your Redis has an ACL user for this app, make sure
   it may run the BullMQ commands (`EVAL`, `XADD`, `BZPOPMIN`, …) as well as `PUBLISH`/`SUBSCRIBE`.
3. **Agent ids are checked at the gateway.** A2A and MCP `dispatch_task` refuse an `agentId` that
   is not in `AGENT_IDS`. List every agent that callers address.
4. **Origins and proxies.** The `SOCKET_CORS_ORIGINS` allowlist now also applies to WebSocket
   connections (a browser Origin that was ignored before must be listed). Behind a proxy or
   ingress set `TRUST_PROXY=true`, otherwise all clients share the proxy's address for the
   refused-attempt limit on STOP ALL.

Smaller points:

- `OTEL_EXPORTER_OTLP_ENDPOINT` is the OTLP/HTTP base URL (`http://collector:4318`); a value that
  ends in `/v1/traces` still works.
- A viewer opened with `?gateway=<url>` and a token from `window.BOARD_TOKEN` now connects to
  `window.GATEWAY_URL` (or `localhost:3000`) and logs "Ignoring ?gateway=". Put the gateway in
  `window.GATEWAY_URL`, or pass the token as `#token=` in the same address. A board built with
  `VITE_BOARD_TOKEN` honours `?gateway=` only for the origin of `VITE_GATEWAY_URL`.
- Helm: the charts default to `ghcr.io/andreibesleaga/kaiban-distributed:<appVersion>`. For a
  locally built image set `--set image.repository=kaiban-distributed --set image.tag=latest`.
- The example Redis and Kafka are published on `127.0.0.1` only; reach them from another machine
  through an SSH tunnel or change the published address in the compose file.
- Kafka: a scaled agent (`--scale searcher=N`) shares work only when its task topic has at least N
  partitions; the compose files now create topics with 4. A worker whose consumer group has no
  committed offset (first start, a new `KAFKA_GROUP_ID`, or offsets expired after the broker's
  `offsets.retention.minutes`) now reads its mailbox from the beginning, so tasks the topic still
  retains are run (again). Keep the topic retention shorter than the longest idle period, or
  reset the group's offsets before restarting after a long pause. The completed and failed
  channels follow the same rule: a new orchestrator or gateway consumer group replays the
  retained events once (results for tasks nobody waits for are dropped with a log line).
- global-research: `AUTO_PUBLISH` is no longer inferred from a missing terminal. A piped or CI run
  must set `AUTO_PUBLISH=true` (or answer the review prompt), otherwise it waits for the decision.
- `AGENT_TIMEOUT_MS` and `CIRCUIT_BREAKER_*` values that were silently mis-parsed now log a warning
  and use the default.
- Code that called `DistributedStateMiddleware.attach` with its own store must give it
  `subscribe(listener(state, prev))`; `unwrapVerified(raw, { maxSkewMs })` gained an optional
  skew window (the default 30 s is unchanged).

## 2.1.0 → 2.1.1 (STOP ALL in the static viewers, additive)

Nothing to change. The static viewers under `examples/*/viewer` gain the STOP ALL button, which shows
only when the gateway has the control plane on. If you copied a viewer into your own deployment,
copy the new `board.html`, `board.js` and `board.css`. To connect a viewer to a gateway that sets
`BOARD_JWT_SECRET`, open it with `#token=<board token>` (or set `window.BOARD_TOKEN`).

## 2.0.x → 2.1.0 (emergency STOP ALL, additive)

Nothing to change: every addition is off unless `CONTROL_PLANE_ENABLED=true`, and with it unset
2.1.0 behaves as 2.0.3. To turn the emergency STOP ALL on ([ADR-025](docs/decisions/ADR-025-emergency-stop-control-channel.md)):

1. Set `CONTROL_PLANE_ENABLED=true` on every gateway, worker and orchestrator process (the compose
   files pass it through). A process without it neither stops nor refuses old tasks.
2. Set `BOARD_JWT_SECRET` on the gateway and give the board a token (`VITE_BOARD_TOKEN`): board and
   HTTP stop commands are refused without one. `npm run stop-all` needs only Redis access.
3. Custom worker code built on `AgentActor` (instead of `startAgentNode`): call
   `attachEmergencyStop({ actor, publisher, redisUrl, agentId })` **before** `actor.start()`, and
   pass `onEmergencyStop: (p) => statePublisher.publishStopped(p)` in the actor deps so the board
   shows `STOPPED`.
4. Custom orchestrators: pass `stopSignal` (from `createEmergencyStopSignal(redisUrl)`) to
   `WorkflowOrchestrator`, and `signal` to `waitForHITLDecision`; catch `EmergencyStopError`.
5. Code that switches over `TaskStatus` should handle the new member `STOPPED`.
6. Keep the hosts' clocks synchronised (NTP): the stop moment is compared with each task's send time.
7. With the control plane on, a node that cannot read the saved stop from Redis at start does not
   start (fail closed). Helm users set `config.CONTROL_PLANE_ENABLED: "true"`.

