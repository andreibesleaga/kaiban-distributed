# Release runbook — v2.0 (BETA.3 release-track)

> Status of the non-engineering BETA.3 phases (V/7eq/4b/8eq/Z). The substantive feature phases
> (M, R, E, G) are committed on `feat/v2.0`. Tagging/publishing `v2.0.0` is a **maintainer** action.

## Phase 4b — publish from a staging dir (license-correct Apache tarball)

**Problem:** `npm pack`/`npm publish` ALWAYS includes a root `LICENSE`/`LICENCE` file in the tarball,
**regardless of the `files` allow-list**. The repo root `LICENSE` is **GPL-3.0** (the app / aggregate
is GPL), but the published **library** is **Apache-2.0** (ADR-011) and must ship the Apache text. Left
unfixed, `npm pack` leaks the 35 kB GPL license into the Apache package.

**Fix:** [`scripts/pack-staging.sh`](../scripts/pack-staging.sh) assembles a clean staging dir whose
only `LICENSE` is `LICENSE-APACHE`, then packs/publishes from there:

```bash
scripts/pack-staging.sh            # build + pack → ./kaiban-distributed-<version>.tgz
scripts/pack-staging.sh --publish  # build + `npm publish --provenance --access public` from staging
```

**Verified locally** (`npm pack`): the staged tarball contains `LICENSE` (Apache) + `LICENSE-APACHE`,
`dist/src/**`, and **zero GPL text** (`grep -c "GNU GENERAL PUBLIC LICENSE"` → `0`).

> **Maintainer-gated:** wiring this into `.github/workflows/release.yml` (replacing the bare
> `npm publish`) changes the release/provenance flow and is left for maintainer approval. The script is
> drop-in: the release job should run `scripts/pack-staging.sh --publish` instead of `npm publish`.
> The SLSA provenance / SBOM / cosign steps are unchanged (they operate on the published artifact).

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
