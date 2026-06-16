# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x | ✅ |
| < 1.0 | ❌ |

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
- **Set `MAX_TOKEN_BUDGET`** and a hard provider-side billing ceiling so a
  misconfigured fan-out loop cannot run up unbounded cost.

## Supply-chain posture

CI enforces a dependency audit that **fails on HIGH or CRITICAL** advisories
(`npm audit --audit-level=high`), plus OSV-Scanner, gitleaks secret scanning,
CodeQL, a CycloneDX 1.6 SBOM, and OpenSSF Scorecard. Releases carry SLSA build
provenance and a Sigstore (cosign keyless) signature.

### Dependency `overrides` (transitive CVE mitigation)

Several transitive advisories reach the tree via `@langchain/*` (used by
`kaibanjs`) and the OpenTelemetry/gRPC stack. `package.json` `overrides` pin
patched versions: `@langchain/core`, `@langchain/community`, `langchain`,
`langsmith`, `axios`, `protobufjs`, `@grpc/grpc-js`, `ws`, `hono`, `fast-uri`,
`fast-xml-parser`, `qs`, `uuid`, `ip-address`, `expr-eval`, `file-type`, `glob`,
`@opentelemetry/exporter-prometheus`, `form-data` (>=4.0.6), `vite` (>=8.0.16).

### Residual advisories (moderate only)

`npm audit` reports **0 high/critical** (CI fails the build on HIGH+). A number of
**moderate** advisories remain — these fluctuate as the npm advisory database is
updated against existing dependency versions, and are predominantly **dev/build
tooling and transitive** packages (e.g. `brace-expansion`, `postcss`, and various
test/build transitives) that **do not ship in the deployed worker/gateway image or
the published `dist/src` library**. They are tracked and cleared as upstream fixes
land; CI intentionally does not block on moderates.

## Sensitive-data handling (operator responsibility)

`kaiban-distributed` is a **library/runtime, not a certified product**. It
provides controls (PII hashing/`sanitizeDelta`, mTLS, JWT/HMAC auth, audit
logging) that can **support** an operator's GDPR / SOC 2 / ISO 27001 program,
but compliance and certification are the responsibility of the deploying
organization, which must de-identify inputs and configure controls appropriately.
