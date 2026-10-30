# Contributing to kaiban-distributed

Thanks for your interest in improving kaiban-distributed.

## Prerequisites

- **Node.js ≥ 22** (the project targets the v22 LTS line)
- **npm 11.17.0** (`packageManager` in `package.json`): CI, the Dockerfile and Dependabot all use it.
  Node 22 bundles npm 10, so run `npx -y npm@11.17.0 ci` or install it once with `npm install -g npm@11.17.0`
- **Docker** + the `docker compose` v2 plugin (only for the e2e suites)

## Getting started

```bash
npm ci                 # install (root)
npm run build          # tsc -> dist/
cd board && npm ci     # board UI deps (separate lockfile)
```

## Lockfiles

Dependabot writes `package-lock.json` with npm 11, which can leave out optional nested
entries that npm 10 still requires; on npm 10 `npm ci` then stops with
`Missing: <package>@<version> from lock file`. CI and the Dockerfile use npm 11.17.0, so
Dependabot's lockfiles pass there. When a lockfile fails `npm ci` anywhere, or before a
release, run:

```bash
npm run lockfile:check   # proves npm ci on npm 10.9.8 and 11.17.0, root and board; changes nothing
npm run lockfile:fix     # rewrites both lockfiles with npm 10.9.8 (accepted by npm 10 and 11), then proves it
```

`lockfile:fix` prints the git commands to commit the result; it never commits.

## Development workflow

| Command | Purpose |
|---------|---------|
| `npm run typecheck` | `tsc --noEmit` — must be clean |
| `npm run lint` | ESLint (no-explicit-any, complexity ≤ 10) — must be clean |
| `npm run lint:arch` | madge circular-import check (`--extensions ts`) |
| `npm run test:coverage` | unit tests; coverage is **enforced at 100% of `src/**`** |
| `cd board && npm test` | board UI component tests |
| `npm run test:e2e` / `:kafka` / `:security` | integration suites (need Docker) |

## CI workflows

All workflows are in `.github/workflows/`; the ones that install Node use Node 22 and npm 11.17.0.

| Workflow | Runs on | What it does |
| --- | --- | --- |
| `ci.yml` | push and pull request to `main` and `develop` | **quality**: `npm ci`, lint, typecheck, `lint:arch`, `api:check`, `test:coverage` (coverage report uploaded as the `coverage` artifact); **board**: `npm audit --audit-level=high`, build, tests; **security**: licence check of the production dependencies (`license-checker --onlyAllow`, permissive licences only, ADR-011), `scripts/audit-gate.js`, CycloneDX SBOM, gitleaks, OSV-Scanner (SARIF to code scanning); **CodeQL**; **docker**: builds the image and fails on a fixable CRITICAL/HIGH Trivy finding |
| `nightly.yml` | daily 02:00 UTC, or by hand | e2e on BullMQ/Redis plus the security suite, e2e on Kafka, the chaos suite, Stryker mutation on the domain layer (fails below 85 %), benchmarks |
| `release.yml` | a `v*` tag | build, tests, SBOM, consumer smoke test (`scripts/smoke-consumer.sh`), Apache-2.0 tarball, SLSA provenance, cosign signatures, GitHub Release, signed image on ghcr.io ([docs/RELEASE.md](docs/RELEASE.md)) |
| `publish-npm.yml` | a `v*` tag without `-`, or by hand | gate, then publishes the library to npmjs.com through trusted publishing ([docs/RELEASE.md](docs/RELEASE.md)) |
| `publish-github-packages.yml` | a `v*` tag, or by hand | the same tarball as `@andreibesleaga/kaiban-distributed` on GitHub Packages |
| `pages.yml` | push to `main` that changes `site/**` or the workflow file, or by hand | deploys `site/` to GitHub Pages |
| `scorecard.yml` | weekly (Monday 07:00 UTC), push to `main`, branch-protection changes | OpenSSF Scorecard |

Dependabot (`.github/dependabot.yml`) opens weekly pull requests on Mondays for the root npm
packages (grouped into production and development), the board's npm packages and the GitHub Actions.

Reading a failure: `test:coverage` fails when any `src/**` metric drops below 100 %;
`scripts/audit-gate.js` and the Trivy image scan (fixable findings only) fail on a HIGH or CRITICAL
advisory unless `.trivyignore` lists it with an unexpired `exp:` date (see [SECURITY.md](SECURITY.md));
the board audit fails on any HIGH or CRITICAL advisory; `api:check` fails when the public API differs
from `etc/*.api.md` (`npm run api:update` rewrites the reports for review).

## Pull-request checklist

- [ ] `typecheck`, `lint`, `lint:arch`, `test:coverage`, and the board tests pass.
- [ ] **New behavior ships with new tests** covering golden-path **+ edge + error** cases.
- [ ] Coverage stays at 100% of `src/**` (the gate fails otherwise).
- [ ] **No breaking change to public behavior** unless intentional and documented.
      The 6 verification gates: public API surface (`api:check`), CLI
      `--help`, config schema (env vars additive with safe defaults), on-wire
      message shapes, ≤5% perf delta, and a non-positive CVE delta.
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`.
- [ ] Docs updated for any user-visible change (and kept in sync with the code —
      this repo is the companion code for the book *Agentic AI Architectures*; accuracy matters).

## Commit & branch conventions

Work on a feature branch; keep commits focused. Conventional-commit prefixes
(`fix:`, `feat:`, `docs:`, `chore:`) are appreciated.

Some docs and code comments cite `KAIBAN-v2.0-MASTER-PLAN.md` ("the master plan"): it is a private
planning file, not in this repository, and the ADRs in [`docs/decisions/`](docs/decisions/) are the public record.

## Security

Do not file security issues publicly — see [SECURITY.md](SECURITY.md).

## License

By contributing you agree your contributions are licensed under the project's
[GPL-3.0](LICENSE).
