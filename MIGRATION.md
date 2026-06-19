# MIGRATION — v1.x → v2.0

> v2.0 is a **major** release with breaking changes. This guide covers every breaking change.
> **Status: DRAFT** (in progress on `feat/v2.0`). Entries are added as each §B8 phase lands.
> Authoritative plan: `KAIBAN-v2.0-MASTER-PLAN.md`.

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
      `docs/federation/MCP.md`). Dispatch reuses the A2A `validateTaskInput` caps + `taskId` dedup.
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
- [ ] … (one entry per breaking change; cross-referenced to its ADR.)
