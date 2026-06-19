# ADR-016 — AMQP driver seam (unimplemented)

- **Status:** Accepted
- **Date:** 2026-06-18
- **Refs:** `KAIBAN-v2.0-MASTER-PLAN.md` §B8 Phase 3 + §B2 A8; `docs/messaging/AMQP.md`

## Context
The original v2.0 plan included a full RabbitMQ/AMQP driver. It was descoped (maintainer decision):
ship only an **unimplemented universal AMQP seam** so the extension point exists, without
RabbitMQ-specific work. Also, `amqplib` 2.x is not verified-compatible with `amqp-connection-manager`
(which targets the 0.10 line), so any real implementation must be pinned/verified separately.

## Decision
- `MESSAGING_DRIVER=amqp` is recognized (in `config.ts` + `driver-factory.ts`) and returns
  `AmqpDriver` — a stub implementing `IMessagingDriver` whose methods throw
  `AMQP driver is not implemented (roadmap)`.
- The stub file is **coverage-excluded** (`vitest.config.mts`) — it ships no implementation and no
  tests, per scope; the factory/config **routing** to it IS tested. `AmqpDriver` is exported from the
  public barrel so a future implementation needs no API change.
- BullMQ/Redis (default) + Kafka remain the two **real** drivers.

## Consequences
- (+) The AMQP slot + public `AmqpDriver` export exist for a future release with no breaking change.
- (−) Selecting `amqp` fails fast on first use (intended). A real impl is roadmap — see
  `docs/messaging/AMQP.md`.
