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
- [ ] **Phase 2** — A2A: the custom `A2AConnector` is replaced by the `@a2a-js/sdk`-backed executor
      (method/shape changes; AgentCard at `/.well-known/agent-card.json`).
- [ ] **Phase 3** — `MESSAGING_DRIVER=amqp` recognized (unimplemented seam; BullMQ/Kafka unchanged).
- [ ] … (one entry per breaking change; cross-referenced to its ADR.)
