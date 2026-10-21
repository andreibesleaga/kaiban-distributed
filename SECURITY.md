# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 2.x | ✅ |
| < 2.0 | ❌ |

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

- Preferred: open a [GitHub private security advisory](https://github.com/andreibesleaga/kaiban-distributed/security/advisories/new).

We aim to acknowledge within **5 working days** and to provide a remediation
timeline within **15 working days**. Please allow a **90-day coordinated
disclosure embargo**. Include: affected version/commit, reproduction steps,
impact, and any suggested mitigation.

## API key handling (OpenAI / OpenRouter / compatible)

- **Never commit a real key.** Only `.env.example` (placeholders) is tracked.
- **Never log the key.** Keys are read from the environment only.
- **Use a project-scoped key**; rotate at least every 90 days.
- **Spend caps are on by default** (`MAX_WORKFLOW_COST_USD=0.50`,
  `MAX_TOKEN_BUDGET=200000`, `MAX_TASK_TOKEN_BUDGET=50000` when unset; only the
  literal `unlimited` removes one). Keep them, and set a hard provider-side
  billing ceiling so a misconfigured fan-out loop cannot run up unbounded cost.

## Supply-chain posture

CI enforces a dependency audit that **fails on HIGH or CRITICAL** advisories
(`npm audit --audit-level=high`), plus OSV-Scanner, gitleaks secret scanning,
CodeQL, a CycloneDX 1.6 SBOM, and OpenSSF Scorecard. Releases carry SLSA build
provenance and a Sigstore (cosign keyless) signature.

### Dependency `overrides` (transitive CVE mitigation)

Several transitive advisories reach the tree via `@langchain/*` (used by
`kaibanjs`) and the OpenTelemetry/gRPC stack. `package.json` `overrides` pin
patched versions: `@langchain/core`, `@langchain/community`, `langchain`,
`langsmith`, `axios`, `protobufjs` (>=8.6.6), `@grpc/grpc-js`, `ws`, `hono`
(>=4.12.32), `fast-uri` (>=4.1.1), `fast-xml-parser`, `qs`, `uuid`, `ip-address`,
`expr-eval`, `file-type`, `glob`, `brace-expansion` (>=5.0.8), `js-yaml`
(>=4.3.0 <5), `postcss` (>=8.5.25), `@opentelemetry/exporter-prometheus`,
`form-data` (>=4.0.6), `vite` (>=8.1.6), `handlebars` (>=4.7.10 <5), `proxy-addr`
(>=2.0.8 <3), `follow-redirects` (>=1.16.1 <2), `source-map-js` (>=1.2.2 <2),
`fast-copy` (>=4.1.0 <5); `@langchain/core` is held at >=1.2.20 <2 (required by
`@langchain/openai` 1.6), `fast-uri` at >=4.1.5 and `qs` at >=6.16.0.

An override is a **security floor, not a version bump** — each one is the lowest
patched release for the advisory, so the pinned tree stays semver-compatible with
what the dependents declare. `js-yaml` is deliberately capped below `5` because
`@langchain/classic` targets the 4.x API.

### Residual advisories

**As of 2026-10-21**, after the consolidated dependency branch
`deps/security-2026-10-21`, `npm audit` reports **0 critical / 0 high** in both
lockfiles (`package-lock.json`, `board/package-lock.json`) and the Trivy image scan
reports **0 fixable CRITICAL/HIGH**. What remains is **13 moderate** `npm audit` entries in the root lockfile,
from two advisories:

| Severity | Count | Packages | Why it stays |
| -------- | ----- | -------- | ------------ |
| Moderate | 9 | 8 `@opentelemetry/instrumentation-*` (cassandra-driver, knex, mongoose, mysql, mysql2, oracledb, pg, tedious) via `@opentelemetry/auto-instrumentations-node` (GHSA-qqmp-wf37-98f9: database user name recorded as a span attribute) | The fix needs `auto-instrumentations-node` 0.82, a breaking 0.x update taken together with the rest of the OpenTelemetry set in a later release. |
| Moderate | 4 | `sprintf-js` via `argparse` ← `@microsoft/api-extractor` (GHSA-hp3w-g68c-fv3c); npm lists the three packages that pull it in as separate entries | Development tooling only, not in the runtime image; no fixed `sprintf-js` exists. |

The board lockfile has no open advisories.

Policy: open advisories are addressed on a **dependency branch** (the Dependabot
pull requests or a consolidated `deps/*` branch), merged after CI and review —
never mixed into feature or documentation changes. CI fails the build on HIGH+
(`npm audit --audit-level=high`) and intentionally does not block on moderates,
since moderate findings fluctuate as the npm advisory database is updated against
existing dependency versions and are predominantly **dev/build tooling and
transitive** packages that **do not ship in the deployed worker/gateway image or
the published `dist/src` library**. This section is re-dated whenever the list
changes.

Note that the Trivy image scan reads `/app/package-lock.json` inside the runtime
image, so it reports **dev-only** locked packages too even though the runner stage
installs with `npm ci --omit=dev`. A dev-tooling HIGH therefore still fails the
image gate, and the fix is to raise the floor in the lockfile rather than to
exclude the finding.

## Sensitive-data handling (operator responsibility)

`kaiban-distributed` is a **library/runtime, not a certified product**. It
provides controls (PII hashing/`sanitizeDelta`, mTLS, JWT/HMAC auth, audit
logging) that can **support** an operator's GDPR / SOC 2 / ISO 27001 program,
but compliance and certification are the responsibility of the deploying
organization, which must de-identify inputs and configure controls appropriately.
