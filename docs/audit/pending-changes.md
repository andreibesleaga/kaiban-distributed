# Pending-Change & Dependency Reconciliation

> Phase 0 of the 100% audit. Captured on the `feat-fixes` branch with `gh` against
> `andreibesleaga/kaiban-distributed`. Goal: incorporate all *safe* in-flight upgrades
> into our baseline now, so that after this engagement **no queued Dependabot/PR upgrade
> can introduce a later breaking change**. Risky (major) bumps would be pinned/deferred —
> none were found; every pending bump is within-major (`additive`).

## Open pull requests

| PR | Created | Scope | Disposition |
|----|---------|-------|-------------|
| **#18** "Bump npm_and_yarn group across 1 directory with 9 updates" | 2026-06-04 | root `package.json` + `package-lock.json` | **Newer — supersedes #17** for all shared packages; also bumps `@opentelemetry/exporter-prometheus` 0.213.0→0.218.0 |
| **#17** "Bump npm_and_yarn group across 2 directories with 9 updates" | 2026-05-29 | root + **`board/`** | Mostly superseded by #18; unique contribution is the **`board/` `ws` 8.20.0→8.21.0** bump |

**Reconciliation decision:** do **not** merge #17/#18 as-is (they branch from an older base and would conflict with the consolidated `overrides` strategy below). Instead apply a single controlled dependency refresh on `feat-fixes` covering the union of both PRs **plus** the open security alerts, re-run the full suite green, then close #17/#18 as *superseded by feat-fixes* once merged. This guarantees the upgrades can't later re-introduce a break.

## Open Dependabot security alerts (root unless noted)

All transitive except the two OpenTelemetry direct deps. Every fix is within the same major version → **`additive`, safe to take now**.

| Package | Sev | Vulnerable | Patched (target) | Where | How we fix |
|---------|-----|-----------|------------------|-------|-----------|
| **protobufjs** | **critical** | `< 7.5.5` (+ ≤7.5.7) | **7.5.8** | transitive (grpc/OTel) | `overrides` |
| `@opentelemetry/sdk-node` | high | `< 0.217.0` | **0.217.0+** | **direct** | bump in `dependencies` |
| `@opentelemetry/auto-instrumentations-node` | high | `< 0.75.0` | **0.75.0+** | **direct** | bump in `dependencies` |
| `@opentelemetry/exporter-prometheus` | high | `< 0.217.0` | 0.217.0+ | transitive | `overrides` (align OTel family) |
| `@grpc/grpc-js` | high | `< 1.14.4` | **1.14.4** | transitive | `overrides` |
| `axios` | high | `< 1.16.0` | **1.16.1** | transitive (langchain) | `overrides` (raise existing `>=1.15.0`) |
| `langsmith` | high | `< 0.6.0` | **0.7.4** | transitive (langchain) | `overrides` (raise existing `>=0.5.9`) |
| `fast-uri` | high | `<= 3.1.1` | **3.1.2** | transitive | `overrides` |
| `esbuild` | high | `< 0.28.1` | **0.28.1** | **`board/`** (vite) | `board/package.json` `overrides` |
| `protobufjs`/`@protobufjs/utf8` | med | `<= 1.1.0` | 1.1.1 | transitive | `overrides` |
| `fast-xml-parser` | med | `< 5.7.0` | 5.7.0 | transitive | `overrides` |
| `hono` | med | `< 4.12.21` | 4.12.23 | transitive | `overrides` |
| `ws` | med | `< 8.20.1` | **8.21.0** | root + **board** | `overrides` (both) |
| `qs` | med | `<= 6.15.1` | 6.15.2 | transitive | `overrides` |
| `uuid` | med | `< 11.1.1` | 11.1.1 | transitive | `overrides` |
| `ip-address` | med | `<= 10.1.0` | 10.2.0 | transitive | `overrides` |

`npm ci` baseline reports **31 vulnerabilities (1 critical, 8 high, 22 moderate)** — so the README **`security-audit-complete` badge is currently false**. Target after Phase 4: **0 critical / 0 high**, residual moderates documented in `SECURITY.md`, CVE delta ≤ 0.

## Action (Phase 4)

1. Bump direct deps: `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node` (+ align `exporter-trace-otlp-http`).
2. Extend root `package.json` `overrides`: `protobufjs>=7.5.8`, `axios>=1.16.1`, `@grpc/grpc-js>=1.14.4`, `langsmith>=0.7.4`, `fast-uri>=3.1.2`, `hono>=4.12.23`, `ws>=8.21.0`, `qs>=6.15.2`, `uuid>=11.1.1`, `fast-xml-parser>=5.7.0`, `ip-address>=10.2.0`, `@opentelemetry/exporter-prometheus>=0.217.0`.
3. Add `board/package.json` `overrides`: `esbuild>=0.28.1`, `ws>=8.21.0`.
4. `npm install` (root + board) → re-run full suite green → confirm `npm audit` 0 high/critical.
5. Document each override + residual risk in `SECURITY.md`; close PRs #17/#18 as superseded.
