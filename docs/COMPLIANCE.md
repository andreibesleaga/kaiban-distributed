# Compliance & Standards Cross-Walk

> **An honest regulatory / standards cross-walk for the kaiban-distributed v2.0 release.**
> It maps what the project *actually built* against each framework, with a candid
> **built / partial / gap-roadmap** status per control. This is a **self-assessment, not a
> certification** — `kaiban-distributed` is a **library / runtime, not a certified product**
> (see [`SECURITY.md`](../SECURITY.md)). Compliance and certification are the responsibility
> of the deploying organisation, which must de-identify inputs and configure controls
> appropriately.

## Scope note — read this first

**Default-ON vs opt-in / default-OFF.** Per architecture invariant **#8** (master plan §B1.2 —
*"security opt-in / default-OFF, backward-compatible, fail-closed"*), **most security, governance,
and economics controls are OFF unless the deploying operator explicitly enables them** (sets the
secret / env flag). A deployment that does not configure them gets the runtime's safety/architecture
guarantees but **none of the optional protections** — so every "built" row below that depends on an
env flag is a *capability that exists and is tested*, not a guarantee that it is *active in your
deployment*.

What is **default-ON** (structural, always in force):

- Clean/Hexagonal layering + the actor-model invariants (message-passing only, let-it-crash, `taskId`
  idempotency, workers never own workflow lifecycle).
- **Data caps as safety**: outbound message **64 KB**, state-event result **20 KB / 20 000 chars**,
  SHA-256-hashed agent IDs in logs, `sanitizeDelta` PII strip.
- A2A input validation (`agentId` ≤64, `/^[\w-]+$/`, `*` rejected; `instruction` ≤10 000;
  total params ≤64 KB) — [`a2a-input-validation.ts`](../src/infrastructure/federation/a2a-input-validation.ts).
- Helmet/CSP/HSTS, per-IP rate limits, request/body/frame size caps, request timeout.
- Per-task retry (3× linear) → DLQ, 5-min per-task timeout, AbortSignal cancellation, graceful shutdown.
- CI/CD quality + supply-chain gates (100% coverage, lint, madge, api-extractor, npm audit, gitleaks,
  OSV, CodeQL, SBOM, SLSA, cosign, Scorecard).

What is **opt-in / default-OFF** (set a secret/flag to activate):

- Board JWT (`BOARD_JWT_SECRET`), A2A JWT (`A2A_JWT_SECRET`), channel signing (`CHANNEL_SIGNING_SECRET`),
  semantic firewall (`SEMANTIC_FIREWALL_ENABLED`), circuit breaker (`CIRCUIT_BREAKER_ENABLED`),
  JIT tokens (`JIT_TOKENS_ENABLED`), mTLS (`REDIS_TLS_*` / `KAFKA_SSL_*`), MCP server (`MCP_SERVER_ENABLED`),
  the **Economics/FinOps** layer (`ECONOMICS_ENABLED`), and the **Governance Action Gate**
  (`GOVERNANCE_ENABLED`). When unset, each is a no-op that behaves exactly as before.

**Licensing (ADR-011).** The **published library** (compiled core in `dist/src`) is **Apache-2.0**
(permissive + patent grant, widest enterprise adoption); the **full application** (board, examples,
infra, deployment, repo aggregate) is **GPL-3.0** (retained copyleft). CI enforces no copyleft runtime
dependency in the Apache core and no GPL source compiled into `dist/src`. See
[`ADR-011`](./decisions/ADR-011-dual-license.md) and [`LICENSING.md`](../LICENSING.md).

**Status legend:** ✅ built (grounded in a real file/ADR) · 🟡 partial (capability shipped/tested but
not fully wired, or deploy-dependent) · ⬜ gap / roadmap (not yet implemented).

---

## 1. EU AI Act — Articles 12–15

> Articles 12 (record-keeping / logging), 13 (transparency & provision of information), 14 (human
> oversight), 15 (accuracy, robustness & cybersecurity). Mapping is to the *technical capabilities*
> a provider could use to meet these obligations; legal classification and conformity assessment
> remain the deployer's responsibility.

| Control | Requirement (Article) | Status | Evidence | Notes |
|---------|-----------------------|--------|----------|-------|
| Automatic event logging / audit trail | **Art. 12** record-keeping over the system's lifetime | 🟡 | [`audit-log.ts`](../src/governance/audit-log.ts) (hash-chained `AuditLog`); [`ADR-020`](./decisions/ADR-020-governance-action-gate.md) | Tamper-evident SHA-256 chain with `verify()`. **In-memory only + opt-in** (gate disabled ⇒ nothing recorded); durable/signed persistence is roadmap. |
| Traceability of operation | **Art. 12** | ✅ | [`telemetry.ts`](../src/infrastructure/telemetry/telemetry.ts), W3C `traceparent` propagation, [`ADR-005`](./decisions/ADR-005-trace-context-propagation.md) | OpenTelemetry spans + per-hop trace context across BullMQ/Kafka; default-ON (console exporter if no OTLP endpoint). |
| Transparency / capability disclosure | **Art. 13** provision of information to deployers | 🟡 | A2A AgentCard [`a2a-agent-card.ts`](../src/infrastructure/federation/a2a-agent-card.ts) at `/.well-known/agent-card.json`; [`ADR-015`](./decisions/ADR-015-a2a-sdk-v0.3.md) | Machine-readable advertisement of skills/capabilities/transports/security schemes. Not an end-user "AI interaction" disclosure UI. |
| Observability as the read-model | **Art. 13** | ✅ | OpenTelemetry + board consuming the same `state:update` stream; economics panel (tokens/cost/duration) | The board renders agent status, task columns, cost, and the event log live off the gateway stream. |
| Human oversight — HITL editorial gate | **Art. 14** human oversight | ✅ | [`ADR-004`](./decisions/ADR-004-hitl-editorial-review.md), `kaiban-hitl-decisions` channel, board HITL modal (PUBLISH/REVISE/REJECT) | Built-in human approval gate in the workflow; pinned to Redis Pub/Sub (invariant #5). |
| Human oversight — MCP elicitation consent | **Art. 14** | 🟡 | [`mcp-server.ts`](../src/infrastructure/federation/mcp-server.ts) elicitation gate; [`ADR-017`](./decisions/ADR-017-mcp-server.md) | `dispatch_task` is **fail-closed**: a client with no elicitation capability is refused. MCP server is opt-in (`MCP_SERVER_ENABLED`). |
| Human oversight — kill-switch | **Art. 14** ability to intervene / stop | 🟡 | [`registry.ts`](../src/governance/registry.ts) `AgentRegistry.revoke()` (PDLSS) | Instant revoke ⇒ `terminate` verdict at the gate. Effective only when the gate is wired into the execution path (see §5). |
| Accuracy / robustness — resilience | **Art. 15** robustness | ✅ | [`ADR-018`](./decisions/ADR-018-resilience-orchestrator.md), crash-safe orchestrator (Redis checkpoint→resume), 3× retry → DLQ, 5-min timeout, graceful shutdown | Default-ON structural resilience; failover is checkpoint, not HA (orchestrator HA = roadmap). |
| Robustness — circuit breaker | **Art. 15** | 🟡 | [`sliding-window-breaker.ts`](../src/infrastructure/security/sliding-window-breaker.ts); [`ADR-010`](./decisions/ADR-010-circuit-breaker-policy.md) | Threshold 10 / 60 s window. **Opt-in** (`CIRCUIT_BREAKER_ENABLED`). |
| Cybersecurity — prompt-injection firewall | **Art. 15** cybersecurity / adversarial resistance | 🟡 | [`heuristic-firewall.ts`](../src/infrastructure/security/heuristic-firewall.ts); [`ADR-007`](./decisions/ADR-007-semantic-firewall-design.md) | 10 regex patterns; firewall-block routes to DLQ (no retry). **Opt-in** (`SEMANTIC_FIREWALL_ENABLED`); heuristic-only (optional LLM deep-analysis hook). |
| Cybersecurity — transport encryption | **Art. 15** | 🟡 | mTLS via `REDIS_TLS_*` / `KAFKA_SSL_*`; HTTPS to LLM APIs; `TLS_REJECT_UNAUTHORIZED` default true | Deploy-dependent (operator supplies certs). |
| Cybersecurity — governance enforcement gate | **Art. 15** | 🟡 | [`action-gate.ts`](../src/governance/action-gate.ts), [`policy-engine.ts`](../src/governance/policy-engine.ts); [`ADR-020`](./decisions/ADR-020-governance-action-gate.md) | Non-bypassable *when enabled* (most-severe-wins, all validators run, every decision audited). Engine shipped + 100% tested; **hot-path interception into the actor is deferred** (see §5). |

---

## 2. NIST AI RMF & NIST SSDF

### 2a. NIST AI Risk Management Framework (GOVERN / MAP / MEASURE / MANAGE)

| Function | Requirement | Status | Evidence | Notes |
|----------|-------------|--------|----------|-------|
| **GOVERN** | Policies, accountability, audit trail | 🟡 | [`policy-engine.ts`](../src/governance/policy-engine.ts) (policy-as-code, hot-reloadable YAML), [`policies.yml`](../src/governance/policies.yml), hash-chained [`audit-log.ts`](../src/governance/audit-log.ts); [`ADR-020`](./decisions/ADR-020-governance-action-gate.md) | Governance layer + ADR process (`docs/decisions/ADR-0*`) provide the documented decision/accountability spine. Gate is opt-in; not yet on the hot path. |
| **GOVERN** | Agent lifecycle accountability | 🟡 | [`registry.ts`](../src/governance/registry.ts) PDLSS (Purpose/Duration/Limit/Scope/Self-instantiation) + kill-switch | Registry + revoke implemented & tested; enforcement depends on gate wiring. |
| **MAP** | Identify context, data provenance, classification | 🟡 | [`secure-memory-store.ts`](../src/memory/secure-memory-store.ts) (provenance + trust tags + data classification + tenant keyspaces) | New opt-in component; binds provenance/classification at write time, RBAC at read time. |
| **MEASURE** | Quantitative metrics, observability, cost | ✅ | [`telemetry.ts`](../src/infrastructure/telemetry/telemetry.ts) (OTel counters/histograms), economics cost accounting [`cache-accounting.ts`](../src/economics/cache-accounting.ts) / [`model-router.ts`](../src/economics/model-router.ts), `detectSpendAnomaly` in [`rate-cost-limiter.ts`](../src/economics/rate-cost-limiter.ts) | Per-task token/cost accounting is default-ON; fleet-wide metrics are opt-in. |
| **MEASURE** | Test coverage / quality measurement | ✅ | 100% `src/**` coverage gate (lines/branches/functions/statements), Stryker mutation on domain, fast-check property tests | Enforced in CI (`.github/workflows/ci.yml`); non-negotiable per project law. |
| **MANAGE** | Risk response, rate/cost limiting, degradation | 🟡 | [`rate-cost-limiter.ts`](../src/economics/rate-cost-limiter.ts), [`cost-reservation.ts`](../src/economics/cost-reservation.ts) (`admit` → allow/degrade/reject); [`ADR-019`](./decisions/ADR-019-economics-finops.md) | Pre-exec admission + global/per-tenant/per-agent budgets. **Opt-in** (`ECONOMICS_ENABLED`); actor hot-path enforcement deferred (capability callable today). |
| **MANAGE** | Incident handling / breaker / DLQ | ✅ | Circuit breaker + DLQ taxonomy + DLQ-replay skips non-retryable poison; [`ADR-018`](./decisions/ADR-018-resilience-orchestrator.md) | Structural; breaker itself opt-in. |

### 2b. NIST SSDF (Secure Software Development Framework)

| Practice | Requirement | Status | Evidence | Notes |
|----------|-------------|--------|----------|-------|
| **PO** (Prepare the Organization) | Documented decisions, security policy | ✅ | ADR process `docs/decisions/`, [`SECURITY.md`](../SECURITY.md), [`ASVS-5.0-checklist.md`](./security/ASVS-5.0-checklist.md) | Coordinated-disclosure policy (90-day embargo); standards posture documented. |
| **PS** (Protect the Software) | Provenance & integrity of release artifacts | ✅ | `.github/workflows/release.yml` — CycloneDX 1.6 SBOM, SLSA provenance (`slsa-github-generator` v2.0.0), cosign keyless signing | SBOM + SLSA build provenance + Sigstore signature per version tag. |
| **PW** (Produce Well-Secured Software) | Secure SDLC, review, static analysis | ✅ | CI gates: lint (complexity ≤10), typecheck (strict), CodeQL, madge (no cycles), api-extractor (API drift); spec→test→code (TDD, test-first) | 100% coverage + review-driven development. |
| **RV** (Respond to Vulnerabilities) | Vulnerability scanning, dependency audit | ✅ | `npm audit --audit-level=high` (blocks HIGH/CRITICAL), OSV-Scanner, gitleaks, Trivy image scan, OpenSSF Scorecard (`scorecard.yml`); [`ADR-012`](./decisions/ADR-012-dependency-policy.md) | Moderate advisories tracked (predominantly dev/build transitive; not shipped in `dist/src`/image) — see [`SECURITY.md`](../SECURITY.md). |

---

## 3. STRIDE threat model

| STRIDE category | Threat | Status | Evidence | Notes |
|-----------------|--------|--------|----------|-------|
| **Spoofing** | Unauthenticated caller submits tasks / connects to board | 🟡 | A2A JWT [`a2a-auth.ts`](../src/infrastructure/security/a2a-auth.ts), board JWT [`board-auth.ts`](../src/infrastructure/security/board-auth.ts) (HS256); [`ADR-008`](./decisions/ADR-008-jwt-authentication.md) | **Opt-in** (`A2A_JWT_SECRET` / `BOARD_JWT_SECRET`); when unset, callers are trusted (dev default). |
| **Tampering** | Forged/altered state injected on Redis channels | 🟡 | HMAC-SHA256 channel signing [`channel-signing.ts`](../src/infrastructure/security/channel-signing.ts) with `timingSafeEqual` + 30 s replay window | **Opt-in** (`CHANNEL_SIGNING_SECRET`); plain-JSON pass-through when unset. |
| **Tampering** | Altered audit records | 🟡 | Hash-chained [`audit-log.ts`](../src/governance/audit-log.ts); `verify()` reports first `brokenAt` | Tamper-evident in-memory; durable storage + signed chain head = roadmap. |
| **Repudiation** | Agent/human denies an action | 🟡 | Hash-chained audit of every gate decision [`audit-log.ts`](../src/governance/audit-log.ts), OTel traces, HITL decision logging | Non-repudiation strength bounded by the audit chain being in-memory + the gate being opt-in. |
| **Information disclosure** | PII / secrets leak via state events or logs | ✅ | `sanitizeDelta()` PII strip + SHA-256 agent-id hashing (`src/adapters/state/`), result/message size caps, secrets via env only (never logged) | Default-ON data-protection caps. |
| **Information disclosure** | Cross-tenant / over-privileged memory reads | 🟡 | [`secure-memory-store.ts`](../src/memory/secure-memory-store.ts): tenant keyspaces + retrieval-time RBAC (role × classification) + minTrust floor | New opt-in component; consumers must adopt the store. |
| **Denial of service** | Request flood / oversized payload / runaway loop | ✅ / 🟡 | Per-IP rate limits (RPC 100/min, health 5/min), body 1 MB, WS frame 1 MB, request timeout 30 s, input caps (✅ default-ON); circuit breaker + fleet rate/cost limiter (🟡 opt-in) | HTTP-surface DoS guards are default-ON; cross-agent/fleet limiting is opt-in (`ECONOMICS_ENABLED`). |
| **Denial of service** | Encryption-in-transit / MITM | 🟡 | mTLS `REDIS_TLS_*` / `KAFKA_SSL_*`, `TLS_REJECT_UNAUTHORIZED` default true | Deploy-dependent. |
| **Elevation of privilege** | Compromised/rogue agent escalates | 🟡 | RBAC in memory store, kill-switch [`registry.ts`](../src/governance/registry.ts), MCP least-privilege allow-list [`mcp-server.ts`](../src/infrastructure/federation/mcp-server.ts), non-root container | Kill-switch/gate enforcement depends on gate wiring; MCP allow-list is default-deny per kind. |

---

## 4. MITRE ATLAS & OWASP LLM / Agentic Top-10

> **Honesty note:** in the source tree only **ASI01 / LLM01** is annotated against actual code
> (`heuristic-firewall.ts`). The other ASI/LLM mappings below are *conceptual alignments* between a
> shipped control and the threat it addresses — they are **not** claims of certified coverage, and
> several controls are opt-in. See the project's own redline (`docs/audit/book-redline.md`) which
> deliberately softens code-level ASI mappings.

| Threat (ATLAS / OWASP) | Control | Status | Evidence | Notes |
|------------------------|---------|--------|----------|-------|
| **LLM01 / ASI01** — Prompt injection / agent goal hijack | Semantic (heuristic) firewall | 🟡 | [`heuristic-firewall.ts`](../src/infrastructure/security/heuristic-firewall.ts) (10 patterns, → DLQ no-retry) | The one mapping annotated in code. Opt-in; regex heuristics (best-effort, not exhaustive). |
| **ATLAS** — Prompt injection / jailbreak (ML attack staging) | Firewall + governance policy rules | 🟡 | firewall + [`policy-engine.ts`](../src/governance/policy-engine.ts) (e.g. escalate `rm -rf`/`drop table`) | Policy is first-match substring matching, not a semantic DSL; opt-in. |
| **LLM10** — Unbounded consumption / DoW (denial-of-wallet) | Cost/rate limiter + pre-exec reservation + per-task budget | 🟡 | [`rate-cost-limiter.ts`](../src/economics/rate-cost-limiter.ts), [`cost-reservation.ts`](../src/economics/cost-reservation.ts), `MAX_TOKEN_BUDGET`, AbortSignal token-burn cutoff ([`ADR-014`](./decisions/ADR-014-abort-signal.md)) | Per-task accounting default-ON; fleet limiter + pre-exec `admit()` opt-in and not yet on the actor hot path. |
| **ASI08 / LLM10** — Cascading failures | Circuit breaker | 🟡 | [`sliding-window-breaker.ts`](../src/infrastructure/security/sliding-window-breaker.ts) | Opt-in (`CIRCUIT_BREAKER_ENABLED`). |
| **Excessive agency / ASI** — uncontrolled tool actions | MCP elicitation consent + HITL gate + kill-switch | 🟡 | [`mcp-server.ts`](../src/infrastructure/federation/mcp-server.ts) (fail-closed consent), [`ADR-004`](./decisions/ADR-004-hitl-editorial-review.md), [`registry.ts`](../src/governance/registry.ts) | MCP server opt-in; consent fails closed; kill-switch enforcement depends on gate wiring. |
| **LLM04 / data & memory poisoning** | Memory hardening (provenance, trust floor, revoke) | 🟡 | [`secure-memory-store.ts`](../src/memory/secure-memory-store.ts), policy rule `block-secrets-in-memory` ([`policies.yml`](../src/governance/policies.yml)) | Provenance + minTrust + `revoke()` poisoned entries; opt-in adoption. |
| **LLM02 / ASI** — Sensitive information disclosure | PII sanitization + classification RBAC | ✅ / 🟡 | `sanitizeDelta()` (✅ default-ON), memory classification RBAC (🟡 opt-in) | Board-facing PII strip is structural. |
| **ASI03** — Identity & privilege abuse | JIT token provider + JWT auth | 🟡 | [`env-token-provider.ts`](../src/infrastructure/security/env-token-provider.ts), `a2a-auth.ts` | `ITokenProvider` seam for Vault/Secrets-Manager; opt-in. |
| **ASI07** — Insecure inter-agent communication | mTLS + channel signing | 🟡 | mTLS + [`channel-signing.ts`](../src/infrastructure/security/channel-signing.ts) | Deploy-dependent / opt-in. |
| **Improper output handling (LLM05:2025)** | Output/state minimization + size caps | ✅ | `sanitizeDelta`, result 20 KB / outbound 64 KB caps | Default-ON. |
| **ML supply chain (ATLAS)** | SBOM + SLSA + cosign + dependency scanning | ✅ | `release.yml` (SBOM/SLSA/cosign), CI (OSV/CodeQL/audit/Trivy/Scorecard) | Software supply chain only; model-supply-chain provenance not in scope. |

---

## 5. Honest gaps & roadmap

The following are **not yet fully wired** and must not be read as active guarantees:

- **Action Gate / Cost Reservation enforcement is not yet in the AgentActor hot path.** The governance
  Action Gate ([`action-gate.ts`](../src/governance/action-gate.ts)) and the economics pre-exec
  `admit()` ([`cost-reservation.ts`](../src/economics/cost-reservation.ts)) are **shipped, exported,
  and 100% unit-tested**, but interception into the deployed worker's execution loop / MCP+A2A egress is
  a **separate reviewed step that is deferred** ([`ADR-020`](./decisions/ADR-020-governance-action-gate.md)
  §Deferred, [`ADR-019`](./decisions/ADR-019-economics-finops.md) §Deferred). Library consumers can call
  `evaluate()` / `admit()` today; the bundled actor does not call them automatically yet.
- **The audit chain is in-memory, not durable or externally signed.** [`audit-log.ts`](../src/governance/audit-log.ts)
  is tamper-evident (SHA-256 hash chain, `verify()`), but persistence to durable storage and signing the
  chain head are roadmap ([`ADR-020`](./decisions/ADR-020-governance-action-gate.md)). A process restart
  loses the chain. For EU AI Act Art. 12 record-keeping you must add durable, signed storage.
- **Security/governance/economics controls are default-OFF (opt-in).** Per invariant #8, an
  out-of-the-box deployment has **zero** of the optional protections (auth, signing, firewall, breaker,
  mTLS, governance gate, fleet limiter) until the operator sets the secrets/flags. There is currently
  **no production guard** that *forces* the auth/signing secrets to be set (only CORS throws in prod) —
  tracked as master-plan item **S3** (throw in `NODE_ENV=production` if core secrets unset).
- **OAuth 2.1 / PKCE for the MCP server is deferred.** v2.0 MCP auth reuses the env-gated gateway JWT
  (`A2A_JWT_SECRET`); MCP Roots and OAuth 2.1/PKCE are a later beta
  ([`ADR-017`](./decisions/ADR-017-mcp-server.md) §Deferred).
- **Signed-AgentCard (JWS) verification is deferred.** The card builder is signature-ready but there is
  no built-in verifier (JWKS/key-rotation) yet ([`ADR-015`](./decisions/ADR-015-a2a-sdk-v0.3.md) §Deferred).
- **ASI/LLM threat mappings are mostly conceptual.** Only ASI01/LLM01 is annotated in code; treat the
  other Top-10 rows in §4 as alignment claims, not certified coverage (per `docs/audit/book-redline.md`).
- **Semantic firewall is heuristic (regex) only.** 10 patterns is best-effort prompt-injection defense,
  not a guarantee; the optional LLM deep-analysis hook is unconfigured by default.
- **Orchestrator HA is not implemented.** Failover is single-active Redis checkpoint→resume, **not**
  leader-elected HA ([`ADR-018`](./decisions/ADR-018-resilience-orchestrator.md)).
- **Playwright visual-regression baselines are CI-only.** They guard the board UI in CI; they are not a
  runtime control.
- **AMQP driver is an unimplemented seam** (RabbitMQ descoped in v2.0); BullMQ/Redis + Kafka are the two
  real drivers (master plan §B2 A8).

---

### References

- Master plan: `KAIBAN-v2.0-MASTER-PLAN.md` (§B1 invariants/NFRs, §B5 phases, §B8 execution).
- ADRs: [`docs/decisions/`](./decisions/) — esp. 004, 005, 007, 008, 010, 011, 012, 014, 015, 017, 018, 019, 020.
- Security: [`SECURITY.md`](../SECURITY.md), [`docs/security/SECURITY_FEATURES.md`](./security/SECURITY_FEATURES.md),
  [`docs/security/ASVS-5.0-checklist.md`](./security/ASVS-5.0-checklist.md).
- Licensing: [`ADR-011`](./decisions/ADR-011-dual-license.md), [`LICENSING.md`](../LICENSING.md).

> Frameworks referenced: EU AI Act (Reg. (EU) 2024/1689) Art. 12–15 · NIST AI RMF 1.0 · NIST SSDF
> (SP 800-218) · STRIDE · MITRE ATLAS · OWASP Top 10 for LLM Applications (2025) · OWASP Top 10 for
> Agentic Applications (2026, ASI01–ASI10) · OWASP ASVS 5.0.
