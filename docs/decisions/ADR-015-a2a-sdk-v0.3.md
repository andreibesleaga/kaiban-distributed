# ADR-015: Official `@a2a-js/sdk` v0.3 A2A server (replaces the custom A2AConnector)

- Status: Accepted
- Date: 2026-06

## Context
The A2A federation surface was a hand-rolled JSON-RPC handler (`A2AConnector`)
that implemented a non-standard method set (`tasks.create`, `tasks.get`,
`agent.status`) and a bespoke `AgentCard` shape (`{ name, version, capabilities:
string[], endpoints: { rpc } }`). It diverged from the real A2A wire protocol,
could not interoperate with conformant A2A clients, and stubbed two methods
(`tasks.get` always returned `{ status: "TODO" }`; `agent.status` always returned
`IDLE`).

The master plan (Phase 2 / §B0 A1–A4 / §B2) mandates building on the **official
`@a2a-js/sdk`**, targeting **stable A2A v0.3** (SDK `0.3.x`) now — *not* the v1.0
alpha — while keeping a clean seam to v1.0. The installed SDK is `@a2a-js/sdk@0.3.13`
(verified against its own type defs, not from memory, per §B11.2).

## Decision
1. **SDK-backed server.** A2A is now served by the SDK's Express middlewares
   (`@a2a-js/sdk/server/express`): `agentCardHandler` at
   `/.well-known/agent-card.json` and `jsonRpcHandler` at `/a2a/rpc`, driven by a
   `DefaultRequestHandler`. This delivers the real v0.3 methods **`message/send`**,
   **`message/stream`** (SSE), **`tasks/get`**, **`tasks/cancel`** with zero
   hand-rolled wire code. (The deprecated `A2AExpressApp` is avoided in favour of
   the granular middlewares.)
2. **Bridge executor (`a2a-executor.ts`).** `KaibanAgentExecutor` implements the
   SDK `AgentExecutor`: an incoming task is validated, published to
   `kaiban-agents-{id}` (the actor mailbox), and resolved via `CompletionRouter`.
   It emits `submitted → working → completed` (plus an artifact + result message)
   on the event bus, persisting each lifecycle Task in the store. `cancelTask`
   aborts the in-flight `CompletionRouter.wait` (new optional `AbortSignal` arg)
   and emits a final `canceled` event. Idempotent at-least-once: a duplicate
   `execute` for an in-flight `taskId` is a no-op; terminal tasks are never
   regressed (invariant I3).
3. **Redis task store (`a2a-task-store.ts`).** `RedisTaskStore` implements the SDK
   `TaskStore` (replacing `InMemoryTaskStore`) so `tasks/get` / `tasks/cancel`
   survive a restart and work across a scaled gateway pool. This **de-stubs**
   `tasks/get`.
4. **Real `agent.status` (`agent-status-tracker.ts`).** `AgentStatusTracker`
   subscribes to `kaiban-state-events` (Redis Pub/Sub) and reports each agent's
   last-known status (IDLE/THINKING/EXECUTING/ERROR) at
   `GET /a2a/agents/:agentId/status`. This **de-stubs** the hardcoded `IDLE`.
5. **Encapsulated v0.3 AgentCard (`a2a-agent-card.ts`).** `buildAgentCard` emits the
   v0.3 shape (`protocolVersion`, `url`, `preferredTransport`, object
   `capabilities`, `skills[]`, `securitySchemes`, `additionalInterfaces[]`). All
   card construction lives here so the v1.0 `supportedInterfaces[]` swap is a
   drop-in change to one module. Env-gated JWT maps to an `HTTPAuthSecurityScheme`
   (Bearer/JWT). Transports advertised: JSONRPC (preferred) + HTTP+JSON + GRPC.
6. **Gateway integration.** `GatewayApp` keeps its security front door (helmet,
   per-IP rate limiting, env-gated JWT auth, request timeout) and mounts the SDK
   middlewares behind it. `buildA2AStack` assembles the store + tracker + executor
   + `DefaultRequestHandler` for reuse by the gateway entrypoint and tests.

## Forward-compat built now
- Server-generated task IDs (the SDK generates them; the executor honours the
  request-context taskId).
- Full lifecycle states reachable in the store: `submitted`, `working`,
  `completed`, `failed`, `canceled`, and **`rejected`** (invalid input → terminal
  rejected Task, never a publish).
- `pushNotifications` capability flag (env-gated, default off) on the card.
- gRPC advertised in `additionalInterfaces`.

## Deferred (with reason)
- **Signed-AgentCard verify (JWS).** The SDK exposes `AgentCardSignature` on the
  card type but no built-in *verifier*; doing it correctly (JWKS resolution, key
  rotation) is its own security-reviewed unit. Deferred to a later BETA, tracked in
  the plan's §B5.1 Phase A. The card-builder is signature-ready (the field is part
  of the type) so adding `signatures[]` later is additive.
- **Push-notification webhook delivery.** Only the capability *flag* is advertised
  now; wiring `DefaultPushNotificationSender` + a Redis `PushNotificationStore`
  (and the gateway egress allow-list it needs) is deferred to Phase A to keep this
  pass focused on the core 4 methods + de-stub at 100% coverage.
- **gRPC transport binding.** Advertised in the card; mounting `@a2a-js/sdk/server/grpc`
  (+ `@grpc/grpc-js`, `@bufbuild/protobuf` peers) is deferred per §B6 ("A2A surface
  stays minimal"); JSON-RPC + SSE are the live transports.

## Consequences
- **+** A real `@a2a-js/sdk` client interoperates with our server (card + send +
  stream + get + cancel) — proven by `tests/e2e/a2a-protocol.test.ts`.
- **+** `tasks/get` and `agent.status` return real data (de-stub 1.4 done).
- **+** Wire conformance + future v1.0 migration are the SDK's job, not ours.
- **−** Breaking: `A2AConnector` and its custom methods are removed; the AgentCard
  shape changed; `/a2a/rpc` now speaks the v0.3 method names. See `MIGRATION.md`.
- **−** New runtime dependency `@a2a-js/sdk ^0.3` (Express peer already present).

## Invariants
Preserves §B1.2: **I5** — the status tracker reads `kaiban-state-events` over Redis
Pub/Sub regardless of `MESSAGING_DRIVER` (never the durable broker). **I3** —
`taskId` is the dedup key; duplicate `execute` is idempotent; terminal tasks never
regress. **I8** — JWT auth + push-notifications remain env-gated / default-off.
Data caps (`A2A_INPUT_CAPS`, 64 KB) preserved via the extracted
`a2a-input-validation.ts`. A2A-in-front / MCP-internally unchanged.

## Guard tests
`a2a-task-store.test.ts` (round-trip, TTL, corrupt-entry, injected client),
`a2a-agent-card.test.ts` (v0.3 fields, transports, JWT scheme, skills),
`agent-status-tracker.test.ts` (Redis Pub/Sub read, signed-envelope unwrap, I5),
`a2a-executor.test.ts` (publish→resolve, lifecycle states, rejected/failed/canceled,
idempotency, abort-on-cancel, no internal-error leak),
`a2a-input-validation.test.ts` (caps + `-32602`), `a2a-gateway-factory.test.ts`,
`GatewayApp*.test.ts` (security middleware + SDK routes + real agent.status),
and the conformance e2e `a2a-protocol.test.ts` (official SDK client ↔ our server).
