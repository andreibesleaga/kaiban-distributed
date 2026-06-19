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
- [ ] **Phase 3** — `MESSAGING_DRIVER=amqp` recognized (unimplemented seam; BullMQ/Kafka unchanged).
- [ ] … (one entry per breaking change; cross-referenced to its ADR.)
