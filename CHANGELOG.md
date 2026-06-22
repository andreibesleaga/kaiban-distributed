# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - in progress (`feat/v2.0`)

Major release — breaking changes are documented in `MIGRATION.md`. Authoritative plan:
`KAIBAN-v2.0-MASTER-PLAN.md`.

### Added
- **A2A v0.3 federation** via `@a2a-js/sdk`: the gateway answers `message/send`,
  `message/stream` (SSE), `tasks/get`, `tasks/cancel` on `POST /a2a/rpc`; AgentCard v0.3
  (object `capabilities` + abilities in `skills[]`). (BETA.1, ADR-015)
- **MCP server** — first-party Model Context Protocol surface (Tools / Resources / Prompts /
  Elicitation) over Streamable HTTP. (BETA.2, ADR-017)
- **Resilience** — the single-active orchestrator is promoted to `src/shared` (reusable, published):
  Redis checkpoint/resume, liveness/readiness probes, graceful drain, DLQ replay. (BETA.2, ADR-018)
- **Economics / FinOps** — fleet-wide rate + cost control (token bucket + cost reservation),
  **default-off**. (BETA.3, ADR-019)
- **Governance Action Gate** — **default-off, non-bypassable when enabled**: hash-chained audit,
  policy-as-code, kill-switch; hot-path enforcement wired into `AgentActor`. (BETA.3, ADR-020/021)
- **Universal AMQP driver seam** — declared `amqplib` seam, unimplemented stub (coverage-excluded).
  (BETA.1, ADR-016)
- **`dispatchToAgent`** actor-mailbox primitive in `src/shared` (replaces the removed `tasks.create`
  RPC). _(The examples also gain a local `parseAgentCardSkills` helper to read v0.3 AgentCards — example
  code, not a published library export.)_
- **Workflow budget guard** (`MAX_WORKFLOW_COST_USD` / `MAX_WORKFLOW_TOKENS`) in both example
  orchestrators — checked between phases and before each revision; **graceful STOPPED on breach**
  (default `0.50` in the example compose files; `0` = unlimited; separate from per-agent
  `MAX_TOKEN_BUDGET`).
- **Playwright visual baselines** for the React board + the two static example viewers
  (`cd board && npm run test:visual`).
- **`scripts/smoke-consumer.sh`** — packs the Apache tarball and verifies a fresh consumer can import
  the public surface from both entry points (`.` and `./shared`).
- **Packaging:** `./shared` subpath export + two-entry api-extractor; staging-dir `npm pack`
  (Apache-only artifact, no GPL leak). (BETA.1, ADR-011)
- **COMPLIANCE** cross-walk and the **v2.1 roadmap**.

### Changed
- **License (BREAKING):** the published npm library is now **Apache-2.0** (was GPL-3.0); the full
  application / board / examples remain **GPL-3.0** (dual-license — see `LICENSING.md`, ADR-011).
- **Dependencies:** KaibanJS 0.24.2, TypeScript 6.0, OpenTelemetry 0.219/0.77, bullmq 5.79, dotenv 17
  — all latest stable, **0 vulnerabilities** (ADR-012).
- **gateway / worker ROLE split** — a single image runs as `ROLE=gateway|worker`. (BETA.1, ADR-013)
- **AbortSignal cancellation** — an in-flight LLM call is aborted on task timeout / `tasks/cancel`
  (the bridge owns the LLM instance). (BETA.1, ADR-014)
- **Examples migrated to A2A v0.3** — removed all `tasks.create` / `tasks.get` / `agent.status`
  usage; both examples dispatch via `dispatchToAgent` and read AgentCard `skills[]`.
- **Gateway HITL delivery** — the durable per-task BRPOP-list write now precedes the pub/sub
  publish, and the board is ACK'd only after **both** succeed (a missed pub/sub message stays
  recoverable via the list fallback).
- **`CompletionRouter` subscribes lazily** (on the first `wait()`) — a router that never waits no
  longer consumes the shared completed queue (fixes a competing-consumer hang between the gateway's
  A2A-executor router and an orchestrator router).
- **Kafka driver** now throws a clear error on a 2nd `subscribe()` (explicit one-topic-per-driver
  contract) instead of silently breaking.
- **BullMQ driver** sets job-retention defaults (`removeOnComplete` / `removeOnFail`, bounding Redis
  growth) and registers a worker `error` listener.
- **A2A executor** logs the underlying error server-side on failure (the wire response stays generic).

### Fixed
- **HITL re-arm loop** — the terminal prompt no longer re-arms after a decision arrives (board OR
  terminal) or after stdin EOF; fixes the **REVISE** infinite re-prompt spin (100% CPU, process
  never exits, Ctrl-C ineffective) and restores the second HITL gate on the revised draft.
- **Board hangs on RUNNING after a hard failure** — both orchestrators now publish a terminal
  STOPPED state on error, so the board reflects the failure instead of hanging.
- **Board store** — malformed state deltas with no `agentId` / `taskId` are skipped (the Zustand map
  is never keyed by `"undefined"`).
- **Fan-out/fan-in result↔index mismatch** (global-research, plan finding C1/HIGH) — search results
  are now mapped to their **dispatch** index by `taskId` (was indexed by `waitAll` completion-order
  position), so searchers that finish out of order get the correct sub-topic, node label and logged
  taskId.
- **Governance Action Gate fails closed** on a throwing validator; MCP-without-auth warning.
- **Byte-accurate data caps** — the 64 KB outbound-message and 20 KB state-event-result caps are now
  measured in **UTF-8 bytes** (`Buffer.byteLength`), truncating on a codepoint boundary (was UTF-16
  `.length`, which let multi-byte payloads exceed the byte cap).
- **Structured agent output** — the KaibanJS bridge now JSON-stringifies a non-string (object) LLM
  result instead of emitting `"[object Object]"`.
- **Model-pricing accuracy** — `estimateCost` normalizes OpenRouter slugs / dated suffixes
  (`openai/gpt-4o-mini`, `gpt-4o-2024-08-06`, `anthropic/claude-3-5-sonnet`) before pricing lookup,
  and warns on a default-pricing fallback (was exact-match only → slugs silently mis-priced).
- **Config robustness** — numeric env vars are parsed NaN-safe (`AGENT_TIMEOUT_MS=abc` no longer
  yields `setTimeout(…, NaN)` / instant timeouts).
- **Actor robustness** — a timed-out task handler's late rejection no longer surfaces as an
  `unhandledRejection`.
- **Global-research budget guard** now runs after **every** phase (search, write, governance,
  editorial), matching blog-team.
- A2A input validation hardened; de-stubbed `IDLE` / `TODO` placeholders. (BETA.1)

### Security
- The published library ships **0 HIGH/CRITICAL advisories**; release flow keeps SBOM + SLSA
  provenance + cosign signing (ADR-012).

## [1.5.0-beta] - 2026-06-16

### Pre-merge hardening pass (audit follow-up)
- **Container image CVEs** (cleared the new Trivy gate to 0 fixable CRITICAL/HIGH):
  `Dockerfile` runs `apk upgrade --no-cache` in both stages (self-heals base-image
  openssl/musl/zlib — incl. a CRITICAL openssl); installs with `npm ci` (lock-faithful,
  no transitive drift above the audited 0-high lock) and pins `glob >= 10.5.0` via
  `overrides`; and **removes the bundled npm CLI from the runtime stage** (the node
  base image's vendored npm shipped HIGH-CVE glob/minimatch/tar that the runtime —
  which only runs `node` — never uses). Also shrinks the image and reduces attack
  surface.
- **Kafka poison-message resilience**: the consumer now skips an unparseable
  (non-JSON) record (logs a warning, advances the offset) instead of throwing and
  crash-looping on it — matching the BullMQ path's tolerance.
- **Trace-header parity**: extracted a shared `sanitizeTraceHeaders` (drops
  non-string entries + rejects malformed `traceparent`); both BullMQ and Kafka
  drivers now use it (previously only BullMQ validated).
- **Timer leaks fixed**: `AgentActor` clears its per-task timeout when the handler
  wins the race; `SocketGateway` clears the token-expiry disconnect timer when a
  client disconnects early.
- **CompletionRouter**: rejects a duplicate `wait()` for an in-flight taskId
  instead of silently overwriting (which hung the first waiter).
- **Token budget wired**: `startAgentNode` now forwards `MAX_TOKEN_BUDGET` to the
  `AgentStatePublisher` (was loaded into config but never reached the worker path;
  0 = unlimited, so default behavior is unchanged).
- **CI**: added a Trivy image scan to the `docker` job (gate on fixable
  CRITICAL/HIGH, SARIF to the Security tab); `engines.node >= 22`; PR trigger now
  also covers `develop`; board job renamed to reflect it typechecks+builds (it has
  no eslint).
- **Docs**: corrected a broken ASVS→SECURITY.md link, stale test counts in
  BLOG_TEAM_TEST/EXAMPLES, the `--chaos/--searchers` example (global-research, not
  blog-team), `createKaibanTaskHandler`/`KaibanTeamBridge` signatures in SPEC,
  security impl paths + `JIT_TOKENS_ENABLED` in ACTOR_MODEL, and the documented
  `overrides` list in SECURITY.md.

### Security
- Cleared **all critical/high dependency advisories** (was 1 critical + 8 high):
  bumped `@opentelemetry/{sdk-node,auto-instrumentations-node,exporter-trace-otlp-http}`
  to the patched 0.217.x line and extended `package.json` `overrides`
  (`protobufjs`, `axios`, `@grpc/grpc-js`, `langsmith`, `ws`, `hono`, `qs`,
  `uuid`, `fast-uri`, `fast-xml-parser`, `ip-address`). Remaining 2 advisories
  are moderate, dev/build-only (see `SECURITY.md`).
- Added `SECURITY.md` (private reporting, key handling, supply-chain posture).

### Added
- CI/CD: `ci.yml` (lint, typecheck, enforced **100%** coverage, real madge gate,
  board tests, `npm audit` blocking on HIGH+, CycloneDX SBOM, gitleaks, OSV,
  CodeQL, Docker build), `nightly.yml` (Redis/Kafka/security e2e), `release.yml`
  (SBOM + SLSA provenance + Sigstore cosign signing), `scorecard.yml`.
- Governance: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`,
  `.github/dependabot.yml` (root + board + actions).
- `@opentelemetry/api` added as a direct dependency (was imported but undeclared).
- Unit test for the bootstrap/composition root (`src/main/index.ts`).

### Fixed
- **global-research**: editorial score always rendered `N/A` because the phase
  parsed the governance reviewer's `Compliance Score` label instead of the
  editor's `Accuracy Score` — corrected, with a regression test.
- Coverage gate was a no-op (thresholds mis-keyed for vitest 4 and `coverage.all`
  unset); now `coverage.all` + `include: src/**` + `coverage.thresholds` enforce
  a genuine 100% of `src/**`.
- Architecture gate was a no-op (`madge --circular src/` scanned 0 files); now
  uses `--extensions ts` (scans the TypeScript graph).

### Changed
- Reconciled open Dependabot PRs #17/#18 into a single controlled refresh.
- **Packaging**: added `src/index.ts` public-API barrel; `package.json`
  `main`/`types`/`exports`/`files` for a clean **library publish** (ships `dist/src`
  only — examples/board/tests excluded); `tsconfig.build` emits declarations.
- Removed 4 divergent duplicate `vitest.*.config.ts` (kept `.mts` + wired `test:e2e:live`).
- Docs softened to defensible/accurate wording: CI/Scorecard-backed badges; "one of
  the first" (not "the very first in the world"); compliance → capability language with
  a "library, not a certified product" disclaimer; corrected backoff (linear), result
  cap (20 000), and circuit-breaker threshold (10).
- `release.yml` now also builds, pushes, and **cosign-signs the container image**.

### Security (additional)
- Applied `sanitizeDelta` PII stripping on the worker `AgentStatePublisher` path
  (defense-in-depth; previously only the middleware path).
- Added `LICENSE-EXCEPTIONS.md` (GPL-3.0 SaaS-vs-distribution + commercial licensing).

### Observability & quality (additional)
- **OTel metrics**: `kaiban.message.processed` counter + `kaiban.message.latency`
  histogram via a `PeriodicExportingMetricReader` (OTLP when configured, Console in
  dev); emitted from the actor's success/DLQ paths.
- **Anomaly events**: `recordAnomalyEvent` wired at the actor level
  (`circuit_breaker.rejected`, `firewall.blocked`).
- **Benchmarks**: `bench/throughput.bench.ts` + `npm run bench` (vitest bench) +
  nightly job; **property tests** (fast-check) for channel-signing.
- **Lint**: `--max-warnings 0`; `examples/` now linted (browser-globals override
  for the viewer JS) — `npm run lint` covers src + tests + examples.
- **Deploy docs/manifests**: HELM gateway `secretRef` + accurate image-tag default;
  AWS ECS worker `CMD` note; Railway per-service guidance (no unsupported `railway.json`).
- **Structured logging (pino)**: `src/shared/structured-logger.ts` — JSON logs with
  PII redaction, child loggers, level via `LOG_LEVEL`, and opt-in `LOG_PRETTY=true`
  (pino-pretty) for readable local/demo output. Rolled out across **all production
  modules** (AgentActor, SocketGateway, GatewayApp, SlidingWindowBreaker,
  AgentStatePublisher, DistributedStateMiddleware, MCP client, KaibanAgentBridge,
  Telemetry) **and** the worker bootstrap (`main/index.ts`) + shared orchestration
  (`agent-node`, `orchestrator-state-publisher`) — all operational logging is now
  structured. The demo `createLogger` and HITL interactive prompts stay
  intentionally human-readable (terminal UX, not operational logs).
- **API-surface gate**: `@microsoft/api-extractor` (`api:check`/`api:update`) with a
  committed `etc/kaiban-distributed.api.md` report; CI fails on undocumented public-API
  drift — completing the 6-gate verification protocol.
- **Chaos / broker fault-injection e2e**: `test:e2e:chaos` pauses the Redis broker
  mid-flight and asserts every buffered publish flushes on recovery with **zero dropped
  agent messages**; fully isolated (own config, `afterAll`/`finally` always restore the
  broker) and wired into `nightly.yml`.
- **Mutation testing (Stryker)**: `test:mutation` over the pure `src/domain/**` layer —
  **96.61%** mutation score (break gate 85%), nightly job + HTML report. Remaining
  survivors are provably-equivalent mutants. (Stryker introduced no new HIGH/critical
  advisories.)
- **Accessibility**: board axe-core a11y tests (`vitest-axe`) across 6 components — 0 violations.
- **Container image scanning**: CI now scans the built Docker image with **Trivy**
  (gates on fixable CRITICAL/HIGH OS+library CVEs, `ignore-unfixed`, SARIF to the
  Security tab) — closing the image-layer gap the lockfile scanners can't see.
- **Doc accuracy (final reconciliation)**: corrected the remaining stale claims —
  unit/e2e **test counts** (769 unit / 77 files, 65 BullMQ-e2e) across README/EXAMPLES/
  BLOG_TEAM_TEST; firewall verdict shape (`{ allowed, reason }`); Kafka auto-create
  dev-vs-prod note; blog-team phase wait times (120/240/300 s); ADR-003 cost wording
  (estimated via `MODEL_PRICING`); "linear backoff" in `ACTOR_MODEL.md`. Declared
  `ts-node` as a devDep (the documented `npx ts-node` dev-run path). The in-repo audit
  matrix now shows **zero open items**.
- **Deployment**: verified + hardened Railway/Vercel/AWS/Azure — removed Vercel
  phantom steps; gateway `SOCKET_CORS_ORIGINS` everywhere; worker LLM keys/commands;
  health-check scoping (gateway-only); WEBSITES_PORT for Azure App Service.
