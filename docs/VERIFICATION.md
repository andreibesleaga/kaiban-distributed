# v2.0 Verification Record (Phase Z — local)

> Master plan §B8 Phase Z / §B11. This records the **locally-runnable** gate matrix at the current
> `feat/v2.0` head, the invariant/NFR guard map, and the explicit **CI-only / maintainer-gated**
> remainder. Anti-hallucination (§B11.2): every PASS below is from a command actually run on this box —
> no DoD line is asserted without observed output. The **final GA sign-off + tag is deferred** to the
> maintainer's full review (merge to `main` + tag `v2.0.0` are NOT done here).

## Scope of what shipped on `feat/v2.0`
BETA.1 (0–4a) · BETA.2 (R resilience, M MCP server) · BETA.3 (E economics, G governance, hot-path
enforcement, 7eq deps, 8eq COMPLIANCE, 4b staging-publish prototype) + this verification record.
Commits: `e205845`→ … →`691e419` (see `git log`).

## Local gate matrix (run 2026-06-19)

### Library / runtime (root)
| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | ✅ PASS (tsc --noEmit, strict) |
| Lint | `npm run lint` | ✅ PASS (0 warnings, complexity ≤10) |
| Arch (no cycles) | `npm run lint:arch` | ✅ PASS (madge — no circular deps) |
| Build | `npm run build` | ✅ PASS |
| Unit + coverage | `npm run test:coverage` | ✅ PASS — **105 files / 1102 tests / 100%** (1834 stmts, 1084 branches, 458 funcs, 1718 lines) |
| Public API surface | `npm run api:check` | ✅ PASS (2 entry points `.` + `./shared`; only pre-existing forgotten-export warnings) |
| Dependency audit | `npm audit --audit-level=high` | ✅ PASS (0 high/critical) |
| Reproducible install | `npm ci` | ✅ PASS (clean, no `--legacy-peer-deps`) |

### Board (separate package `board/`)
| Gate | Command | Result |
| --- | --- | --- |
| Unit + a11y | `cd board && npm test` | ✅ PASS — 14 files / 146 tests (Vitest + Testing Library + vitest-axe) |
| Build | `cd board && npm run build` | ✅ PASS (`tsc --noEmit && vite build`) |

## Invariant / NFR guard map (§B1.2 / §B1.3) — each has a backing test
| Invariant / NFR | Guard (representative) |
| --- | --- |
| I4 — workers never set `teamWorkflowStatus` | `tests/unit/examples/*-state-publisher.test.ts` |
| I5 — state/HITL channels on Redis Pub/Sub regardless of driver | `tests/unit/state/distributedMiddleware.test.ts`, `tests/unit/gateway/SocketGateway-coverage.test.ts` |
| `taskId` idempotency / at-least-once dedup | `tests/unit/federation/a2a-executor.test.ts`, `tests/unit/shared/completion-router.test.ts` |
| Data caps (64 KB msg / 20 KB state result) | `tests/unit/actor/AgentActor-hardening.test.ts`, `tests/unit/federation/a2a-input-validation.test.ts` |
| Single-active orchestrator / no-bottleneck (worker-scoped) | `tests/unit/shared/orchestrator*.test.ts` |
| Security/governance/economics **default-OFF** | `tests/unit/governance/action-gate.test.ts`, `tests/unit/economics/cost-reservation.test.ts`, `tests/unit/main/config.test.ts` |
| Hot-path enforcement (block → DLQ, no run) | `tests/unit/actor/AgentActor-edge.test.ts`, `tests/unit/shared/admission-gate.test.ts` |

## NOT run locally — CI-only (require Docker/containers/secrets)
These are part of the release gate but are **not reproducible on this dev box**; they run in CI
(`ci.yml` / `nightly.yml`) and must be green before GA:
- E2E vs real brokers: `test:e2e` (Redis/BullMQ) · `:kafka` · `:security` · `:chaos` · `:live` (real LLM).
- Mutation testing (Stryker, domain layer).
- **Playwright visual baselines** (built in the pinned `mcr.microsoft.com/playwright` image).
- Supply-chain / security scanners: Trivy image scan, gitleaks, OSV-Scanner, CodeQL, CycloneDX SBOM,
  SLSA provenance, cosign signature, OpenSSF Scorecard.

## Maintainer / CI-gated remainder (deferred — NOT done here)
| Item | Why deferred |
| --- | --- |
| **Phase V** — board framework majors (React 19 / Tailwind 4 / Zustand 5) | §8 major-version bumps = human decision; visual baselines are CI-only. Board is green on current versions. |
| **Playwright visual harness** | CI-only (pinned container); cannot generate/verify baselines locally. |
| **Adopt `scripts/pack-staging.sh --publish` into `release.yml`** | §6/§9 — CI/CD pipeline change requires maintainer approval (part of the release-flow review). Script is ready + verified via `npm pack` (`docs/RELEASE.md`). |
| **`@langchain/openai` 1.x** | §8 major bump; peer `core ^1.2.0` vs the 1.1.49 pinned for kaibanjs; needs `test:e2e:live`. See `docs/RELEASE.md`. |
| **Merge to `main` + tag `v2.0.0`** | Explicitly the last steps, after a full review (maintainer). |
| v2.1 roadmap items | `docs/roadmap/V2.1-ROADMAP.md` (federation-egress, default fleet cost limiter, universal CloudEvents/AsyncAPI messaging schema). |

## Conclusion
Everything **locally buildable and verifiable** for v2.0 is GREEN (library + board). The remaining work
is CI execution and maintainer release decisions, captured above. Recommend the maintainer run the full
CI matrix (e2e/mutation/visual/security/supply-chain) and the deferred decisions during the pre-GA
review, then merge + tag.
