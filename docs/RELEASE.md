# Release runbook — v2.0 (BETA.3 release-track)

> Status of the non-engineering BETA.3 phases (V/7eq/4b/8eq/Z). The substantive feature phases
> (M, R, E, G) are committed on `feat/v2.0`. Tagging/publishing `v2.0.0` is a **maintainer** action.
>
> **Update (29 Oct 2026):** `v2.0.0` was tagged and published on 2026-06-22, `v2.0.1` and `v2.0.2` on
> 2026-10-23. The sections below are the v2.0 release-track record; the current procedure is the next
> section.

## Cutting a 2.0.x release (current procedure)

Publishing runs in CI only. Never run `npm publish` (or `scripts/pack-staging.sh --publish`) from a
laptop: the npm trusted publisher and the build provenance need the workflow's OIDC token, and a bare
`npm publish` from the repository root would ship the GPL-3.0 root `LICENSE` in the Apache-2.0 package.

1. On a branch (`main` is protected; changes land through a pull request), set the new version in
   every place that carries it. The 2.0.2 release (commit `60702e1`) changed: `package.json` and
   `package-lock.json` (`version`), `src/main/gateway.ts` (the agent card `version`),
   `src/infrastructure/federation/mcp-server.ts` (`DEFAULT_VERSION`) and the agent-card example in
   `README.md`; `site/index.html` also names the current release (two places). Move the
   `CHANGELOG.md` `[Unreleased]` entries under `## [X.Y.Z] — <date>`.
2. Run `npm run lockfile:check` (CONTRIBUTING asks for it before every release), then the checks CI
   runs: `npm run lint`, `npm run typecheck`, `npm run lint:arch`, `npm run api:check`,
   `npm run test:coverage`, and `cd board && npm test`.
3. Open the pull request, wait for CI (see [CONTRIBUTING.md](../CONTRIBUTING.md#ci-workflows)), merge.
4. Tag the merge commit on `main` with an annotated `vX.Y.Z` tag and push the tag. The tag starts:
   - `release.yml`: build, unit tests with coverage, CycloneDX SBOM, the Apache-2.0 tarball from
     `scripts/pack-staging.sh`, SLSA provenance, cosign signatures, a GitHub Release with those files,
     and the container image `ghcr.io/andreibesleaga/kaiban-distributed` (signed);
   - `publish-npm.yml`: typecheck, lint and coverage gate, then `scripts/pack-staging.sh --publish`
     to npmjs.com with provenance (skipped for a tag with a `-`, such as `v2.0.0-beta`);
   - `publish-github-packages.yml`: the same tarball as `@andreibesleaga/kaiban-distributed` on
     GitHub Packages (skipped when that version is already there).
5. Check the result: `npm view kaiban-distributed version`, the GitHub Release assets, and the image
   tag on ghcr.io.

To publish a tag again after a failed run: `gh workflow run publish-npm.yml --ref vX.Y.Z` (and
`publish-github-packages.yml` the same way). npm never accepts the same version twice, so a bad
release is fixed with a new patch version.

## Phase 4b — publish from a staging dir (license-correct Apache tarball)

**Problem:** `npm pack`/`npm publish` ALWAYS includes a root `LICENSE`/`LICENCE` file in the tarball,
**regardless of the `files` allow-list**. The repo root `LICENSE` is **GPL-3.0** (the app / aggregate
is GPL), but the published **library** is **Apache-2.0** (ADR-011) and must ship the Apache text. Left
unfixed, `npm pack` leaks the 35 kB GPL license into the Apache package.

**Fix:** [`scripts/pack-staging.sh`](../scripts/pack-staging.sh) assembles a clean staging dir whose
only `LICENSE` is `LICENSE-APACHE`, then packs/publishes from there:

```bash
scripts/pack-staging.sh            # build + pack → ./kaiban-distributed-<version>.tgz
scripts/pack-staging.sh --publish  # CI only (publish-npm.yml): build + `npm publish --provenance --access public` from staging
```

**Verified locally** (`npm pack`): the staged tarball contains `LICENSE` (Apache) + `LICENSE-APACHE`,
`dist/src/**`, and **zero GPL text** (`grep -c "GNU GENERAL PUBLIC LICENSE"` → `0`).

> **Maintainer-gated:** wiring this into `.github/workflows/release.yml` (replacing the bare
> `npm publish`) changes the release/provenance flow and is left for maintainer approval. The script is
> drop-in: the release job should run `scripts/pack-staging.sh --publish` instead of `npm publish`.
> The SLSA provenance / SBOM / cosign steps are unchanged (they operate on the published artifact).
>
> **Done since:** `publish-npm.yml` runs `scripts/pack-staging.sh --publish`, and `release.yml` packs
> its tarball with `scripts/pack-staging.sh`.

## Phase 7eq — latest-deps re-verify (2026-06-19)

`npm outdated` re-checked against the pinned stack. **All direct deps are at their latest stable,
in-range version** (OpenTelemetry, `zod@4`, `@a2a-js/sdk@0.3` — 1.0 is still alpha, `express@5` +
`@types/express@5` + `helmet@8`, `@modelcontextprotocol/sdk`, `rate-limiter-flexible`, `yaml`,
`bullmq`, `ioredis`, `kafkajs`, `socket.io`). `npm audit` = **0 high/critical**.

**One major deferred — `@langchain/openai` `0.5.x` → `1.x`:**
- `@langchain/openai@1.5.1` peers on `@langchain/core ^1.2.0`, but the tree pins `@langchain/core`
  at **`1.1.49`** (forced by the `overrides` block so `kaibanjs@0.24.2`'s LangChain stack resolves
  consistently). The bump installs and **typechecks clean**, but the `^1.2.0` peer is **not satisfied**
  by `1.1.49` (a masked conflict via the override).
- The unit suite **mocks the LLM**, so a green unit gate does **not** verify the real `ChatOpenAI`
  bridge (`src/infrastructure/kaibanjs/owned-llm.ts` + the KaibanJS `Team`). Validating a major
  LangChain bump requires the **`e2e:live`** suite (real OpenAI key, CI/maintainer).
- Per AGENTS.md §8/§9 (major dependency bump = human decision) this is **deferred**: revisit when
  `kaibanjs` moves its LangChain peer to `core@^1.2`, and verify via `npm run test:e2e:live`.

`Langfuse v5` (mentioned in the plan) is **not a current dependency** — no action.

## Phase 8eq — compliance cross-walk

[`docs/COMPLIANCE.md`](./COMPLIANCE.md) — an honest EU AI Act (Art. 12–15) / NIST AI RMF + SSDF /
STRIDE / MITRE ATLAS / OWASP LLM-Agentic cross-walk, with candid built / partial / gap status per
control (self-assessment, not certification).

## Remaining for `v2.0.0` (maintainer / CI)

> Record of June 2026; `v2.0.0` has been released since. The board majors are in (`board/package.json`:
> React 19, Tailwind 4, Zustand 5) and the Phase 4b publish is wired (above). No workflow runs the
> Playwright visual tests.

- **Phase V** — Playwright visual baselines (built inside the pinned `mcr.microsoft.com/playwright`
  image — **CI-only**, not reproducible on a dev box) + the board framework majors (React 19 /
  Tailwind 4 / Zustand 5).
- **Phase 4b publish** — adopt `pack-staging.sh --publish` into `release.yml` (maintainer).
- **Phase Z** — full gate matrix + every §B1.2 invariant / §B1.3 NFR guard re-checked +
  anti-hallucination sign-off → tag `v2.0.0-beta.3` → soak → **`v2.0.0`** (bump version off
  `1.5.0-beta`).
- **Deferred hot-path wiring** (E + G): `CostReservation.admit()` and `ActionGate.evaluate()` are
  shipped + 100%-tested as capabilities; intercepting them in the deployed `AgentActor` loop /
  federation egress is a separate reviewed step.

## GitHub Packages mirror (2026-09-14)

Only GitHub-hosted registries (ghcr.io, npm.pkg.github.com) appear in the repository's "Packages"
sidebar; npmjs.com packages never do. [`.github/workflows/publish-github-packages.yml`](../.github/workflows/publish-github-packages.yml)
therefore publishes a second copy of the library tarball to GitHub Packages as
`@andreibesleaga/kaiban-distributed` (the owner scope GitHub Packages requires) on every `v*` tag and
on manual dispatch. It reuses `scripts/pack-staging.sh` (pack mode) so the mirrored tarball is the same
license-correct Apache-2.0 artifact as the npm one, renames it inside `dist-staging/` only, authenticates
with the job's `GITHUB_TOKEN` (`packages: write`, no secret), turns provenance off (npmjs-only feature),
and skips a version that is already on GitHub Packages. **npmjs.com remains canonical**; the Phase 4b
`pack-staging.sh --publish` flow above is unchanged (it is already wired into `publish-npm.yml`).

**npm authentication (2.0.2): trusted publishing.** `publish-npm.yml` logs in to npmjs.com with the
job's GitHub OIDC id-token, not an `NPM_TOKEN`: npm now asks token-based publishes for a one-time
password, which CI cannot give. One-time setup by a package owner (npm ≥ 11.10, 2FA on the account):
`npm trust github kaiban-distributed --file publish-npm.yml --repo andreibesleaga/kaiban-distributed --allow-publish`.
The workflow runs on every non-prerelease `v*` tag; republish a tag with
`gh workflow run publish-npm.yml --ref vX.Y.Z`.

Backfill of an existing version: `gh workflow run publish-github-packages.yml --ref v2.0.0`.

