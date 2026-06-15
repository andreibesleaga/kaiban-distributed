# Phase 0 — Ground-Truth Baseline (Reality Snapshot)

> Run on branch `feat-fixes`, 2026-06-15, with **nvm Node v22.22.3** (the box's native Node is 18 and only Windows `npm` is on PATH). This records what the toolchain *actually* does — replacing the prior audit's metadata guesses. Numbers here are the regression baseline; nothing in Phase 4 may regress them.

## Environment & tooling

| Tool | Status |
|------|--------|
| Node | nvm `v22.22.3` (project requires `>=22`) ✓ |
| npm | `10.9.3` (via nvm) ✓ |
| Docker | installed `29.1.3`, daemon **up**, but user **not in `docker` group** → e2e blocked locally (see below) |
| compose | only **v1 `1.29.2`**; `docker compose` v2 plugin absent |
| gh | `2.45.0`, authenticated ✓ |

## Quality gates (no external services)

| Gate | Command | Result |
|------|---------|--------|
| Install | `npm ci` | ✓ 820 packages |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | ✓ 0 errors |
| Lint | `npm run lint` (`eslint src tests`) | ✓ 0 errors/warnings |
| Build | `npm run build` (`tsc -p tsconfig.build.json`) | ✓ |
| Arch | `npm run lint:arch` (`madge --circular src/`) | ⚠️ **FALSE-GREEN — "Processed 0 files"** (madge defaults to `.js`; needs `--extensions ts` + tsconfig; the gate checks nothing) |
| Unit + coverage | `npm run test:coverage` | ✓ **74 files / 751 tests**; coverage **100%** (1211/1211 stmts, 683/683 branches, 268/268 funcs, 1142/1142 lines) |
| Board | `cd board && npm test` (vitest 4.1.4) | ✓ **13 files / 140 tests** |

**Total green now: 891 tests** (751 unit + 140 board). The 14 Docker-gated e2e files are pending docker-group access.

## Security baseline

- `npm ci` → **31 vulnerabilities: 1 critical, 8 high, 22 moderate** (all transitive/minor — see [pending-changes.md](pending-changes.md)). The `security-audit-complete` README badge is therefore **currently false**.

## Badge / claim vs reality

| Claim (README badge / text) | Reality | Action |
|---|---|---|
| `tests-482-passing` | **751** unit tests (+140 board) | Update badge → make CI-enforced |
| `coverage-100%` | 100% **of imported modules** — `vitest.config.mts` sets 100% thresholds but **no `coverage.all`/`include`**, so untested source files are invisible, not counted as 0% | Enable `coverage.all: true` + `include: ['src/**']`, cover gaps, or soften wording |
| `security-audit-complete` | 31 open CVEs (1 crit/8 high) | Drive to 0 high/crit, then re-state; link to artifact |
| `TypeScript-strict` | `strict: true` + full strict family, but **not** `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes` | Defensible; optionally raise |
| `node->=22` | matches `engines` ✓ | keep |
| CI ("ci.yml exists") | **committed in HEAD** (quality+e2e+security+docker) but **deleted in working tree** (your uncommitted WIP) | Evolve into ci.yml + nightly.yml + release.yml |

## Confirmed structural findings (feed Phase 1/3)

1. **madge arch-gate is a no-op** (0 files scanned) — `lint:arch` proves nothing today.
2. **Coverage scope** — 100% is over executed modules only; not provably 100% of `src/**`.
3. **`package.json` `main: "index.js"`** → file does not exist; no `exports`/`types`/`files` → not properly packaged as a library (or should be `private`).
4. **vitest config duplication** — every config exists as `.ts` **and** `.mts`; only `.mts` are wired to scripts; `vitest.e2e.live.config.ts` is orphaned (no script).
5. **README badge `482`** stale vs real `751`.
6. **31 dependency CVEs** open incl. 1 critical (protobufjs) — contradicts `security-audit-complete`.
7. Example-orchestrator HITL prompts leak to stdout during unit tests (noise).
8. **`@opentelemetry/api` imported but undeclared** in `package.json` (depcheck) — currently resolved via a transitive; should be a direct dependency (additive fix). No unused deps/devDeps.

## Secret / supply-chain scan (local)

- Scanner tools (gitleaks/osv-scanner/trivy/syft/cosign) are **not installed** on this box → authoritative scanning moves to CI. Fallback `git log -p` secret-pattern scan over **all history is clean** (no `sk-`/`AKIA`/PEM/`ghp_` matches); **no `.env` file ever committed**. CI `gitleaks` + `osv-scanner` will be the enforced gate.

## Docker e2e status (blocked — needs user action)

Daemon is up but the user isn't in the `docker` group (`permission denied` on `/var/run/docker.sock`); non-interactive `sudo` unavailable. To run the 14 e2e files locally:
```bash
sudo usermod -aG docker $USER && newgrp docker
sudo apt-get install -y docker-compose-plugin   # for `docker compose` v2
```
Until then, e2e (BullMQ/Redis, Kafka, security-full-stack, board-hitl, fan-out/fan-in, horizontal-scaling, chaos) are deferred; they are exercised by the CI matrix regardless.

## 6-gate baselines captured

- API surface: `tsc --emitDeclarationOnly` snapshot (see `docs/audit/gates/`).
- CLI `--help`: `scripts/*.sh` captured.
- Config schema: `.env.example` key set captured.
- On-wire fixtures, perf micro-bench, CVE delta: established at Phase 4 entry.
