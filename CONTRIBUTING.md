# Contributing to kaiban-distributed

Thanks for your interest in improving kaiban-distributed.

## Prerequisites

- **Node.js ≥ 22** (the project targets the v22 LTS line)
- **npm** (lockfile-based installs)
- **Docker** + the `docker compose` v2 plugin (only for the e2e suites)

## Getting started

```bash
npm ci                 # install (root)
npm run build          # tsc -> dist/
cd board && npm ci     # board UI deps (separate lockfile)
```

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
