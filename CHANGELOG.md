# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- `docs/audit/` — full audit: baseline reality, pending-change reconciliation,
  doc↔code verification matrix, external-standards research, book↔code consistency.
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
- **Accessibility**: board axe-core a11y tests (`vitest-axe`) across 6 components — 0 violations.
- **Deployment**: verified + hardened Railway/Vercel/AWS/Azure — removed Vercel
  phantom steps; gateway `SOCKET_CORS_ORIGINS` everywhere; worker LLM keys/commands;
  health-check scoping (gateway-only); WEBSITES_PORT for Azure App Service.
