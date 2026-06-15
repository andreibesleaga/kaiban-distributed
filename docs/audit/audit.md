# kaiban-distributed — Ground-Truth Audit (refreshes the 2026-05-23 metadata audit)

> Per the OpenSourceAudit 8-pillar framework. **This audit was performed against the
> real code** (build/test/coverage/scan actually run on Node 22), unlike the prior
> metadata-only audit which mis-stated CI and several facts. Strict backward-compatible
> (`internal-only`/`additive`); breaking ideas in §Future/v2. Companion: `00-baseline-reality.md`,
> `verification-matrix.md`, `external-research.md`, `book-code-consistency.md`, `production-readiness.md`.

## Snapshot
| | |
|---|---|
| Version | 1.4.0 · GPL-3.0 · Node ≥22 · TypeScript strict |
| Build/typecheck/lint/madge | ✅ all clean (madge now scans 41 files) |
| Tests | **754 unit** (75 files) + **140 board** = 894, all green; +14 Docker e2e files (run in CI/nightly) |
| Coverage | **100% of `src/**`** (genuinely; enforced) |
| Dependency CVEs | **0 critical / 0 high** (was 1+8); 2 moderate dev-only accepted |

## Scoring (0–5)
| Pillar | Prior (metadata) | Current (ground-truth, post-fixes this engagement) | Target |
|---|---|---|---|
| 1 Architecture & Design | 4 | **4** | 5 (C4 diagram; A2A conformance/labelling) |
| 2 Code Quality & Maintainability | 3 | **4** | 5 (de-dup `index.ts` builders vs `shared/`) |
| 3 Security & Supply Chain | 3 | **4** | 5 (PII path P1-9; ASVS checklist; A2A) |
| 4 Dependencies & Licensing | 3 | **4** | 5 (LICENSE-EXCEPTIONS; SHA-pin actions) |
| 5 Testing & Verification | 4 | **4** | 5 (mutation + property + chaos) |
| 6 CI/CD & Release Engineering | 2 | **4** | 5 (live release proof; SHA-pinned actions) |
| 7 Documentation & DX | 3 | **3** | 5 (apply the ~30 doc corrections; ADR-006..010) |
| 8 Performance, Observability, Ops | 3 | **3** | 5 (OTel metrics; bench; worker health) |
| **Total / 40** | **25** | **30** | **40** |

## Pillar notes (deltas from prior audit)
- **§1 Architecture (4).** Confirmed real (not metadata): clean DDD layering, pluggable `IMessagingDriver`, actor model, Result monad, security-as-domain. Book ch9 + doc sweeps verified the component inventory line-by-line. Half-points: A2A surface is *A2A-inspired, not wire-conformant* (`external-research.md §1`); no published C4 diagram.
- **§2 Code Quality (3→4).** 100% coverage is now **genuine** (was measuring only imported files); lint clean; **complexity ≤10 already enforced**; `no-explicit-any` enforced; **no circular deps (madge now real)**. Residual: `index.ts` `buildMessagingDriver/buildSecurityDeps` duplicate `src/shared/` equivalents.
- **§3 Security (3→4).** Best-in-portfolio security architecture (firewall, breaker, channel signing, JWT, JIT tokens, PII hashing). Supply chain **fixed**: 0 high/critical, CI gates (audit/OSV/gitleaks/CodeQL/SBOM), signed releases. Open: PII `sanitizeDelta` not applied on the worker `AgentStatePublisher` path (P1-9); ASVS 5.0 checklist pending.
- **§4 Dependencies (3→4).** `overrides` extended, Dependabot (root+board+actions) added, open PRs reconciled, `@opentelemetry/api` declared. GPL-3.0 internally consistent. Pending: `LICENSE-EXCEPTIONS.md`; SHA-pin actions.
- **§5 Testing (4).** Genuine 100% enforced gate; board suite now in CI; golden/edge/error discipline; added bootstrap test + regression test for the editorial-score bug. Pending: mutation (Stryker), property (fast-check on channel-signing), chaos e2e.
- **§6 CI/CD (2→4).** Prior audit hallucinated a working `ci.yml`; reality was a non-blocking-audit CI deleted in the working tree. Now: enforced `ci.yml` + `nightly.yml` + `release.yml` (SLSA L3 + cosign + SBOM) + `scorecard.yml`. Pending: a real signed-release run; SHA-pinned actions.
- **§7 Docs (3).** Extensive (8 deployment guides, 5 ADRs, SECURITY_FEATURES with OWASP map) **but** ~30 verified inaccuracies (`verification-matrix.md`) incl. wrong constants (800 vs 20 000), "exponential" vs linear backoff, dead env vars (`GATEWAY_PORT`), broken deploy steps, OWASP label miscites, overstated compliance. Corrections in progress; until applied, stays 3.
- **§8 Ops (3).** Tracing correct; graceful drain good; **metrics/bench/worker-health missing**; see `production-readiness.md`.

## Recommendations (strict-compat) — status
Done this engagement: supply-chain CVE clearance, enforced coverage+madge gates, CI/CD suite, governance files, editorial-score bug, `@opentelemetry/api`, audit deliverables.
Pending (all `additive`/`internal-only`, tracked in `verification-matrix.md` + `production-readiness.md`):
the ~30 doc corrections; PII path fix (P1-9); `recordAnomalyEvent` wiring (P1-6); worker health endpoint + k8s/helm probe fix (P0-1); OTel metrics + `bench/`; ASVS-5.0 checklist; ADR-006..010; C4 diagram; `LICENSE-EXCEPTIONS.md`; vitest config de-dup; package.json `main`/`exports` decision (open Q1); compliance wording softening; OWASP label fixes.

## Future / v2 (breaking — out of scope)
A2A method/schema rename to wire-conformance (`message/send`, real `AgentCard`); mandatory channel signing by default; single messaging backbone; promote A2A connector to a standalone package; AGPL/dual-license consideration.

## Open questions (need your decision)
1. **Packaging** — publish as an npm **library** (fix `main`/`exports`/`types`) or mark **private** app/deploy artifact (drop broken `main`)?
2. **Book↔code divergences** — fix code vs soften the publisher-bound `.adoc`; and may I edit the manuscript files (book-code-consistency.md B1 license, B2 pinning, B4/B7)?
3. **Compliance claims** — keep GDPR/SOC2/ISO as softened *capability* language (recommended) or remove?
4. **A2A** — document as "A2A-inspired, not wire-compatible" (strict-compat) now, with full conformance deferred to v2? (recommended)
