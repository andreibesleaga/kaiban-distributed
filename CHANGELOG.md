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
