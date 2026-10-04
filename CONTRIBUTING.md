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
      this repo is the companion code for a published book; accuracy matters).

## Commit & branch conventions

Work on a feature branch; keep commits focused. Conventional-commit prefixes
(`fix:`, `feat:`, `docs:`, `chore:`) are appreciated.

## Security

Do not file security issues publicly — see [SECURITY.md](SECURITY.md).

## License

By contributing you agree your contributions are licensed under the project's
[GPL-3.0](LICENSE).
