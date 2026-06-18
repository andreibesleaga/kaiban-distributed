# ADR-011 — Dual-license: Apache-2.0 library / GPL-3.0 application

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Andrei Besleaga (maintainer), with Claude
- **Refs:** `KAIBAN-v2.0-MASTER-PLAN.md` §B0 (License), §B7, §B8 BETA.1 Phase 0; `LICENSING.md`

## Context
v2.0 publishes the core as a public npm library. The repo is currently GPL-3.0. A GPL-3.0 *library*
forces downstream code that imports it to also be GPL, which blocks most enterprise adoption and
contradicts the "enterprise prod-grade public library" goal. The maintainer is the sole copyright
holder and may offer the core under a different license while keeping the application copyleft.

## Decision
Dual-license (open-core):
- Published **library** (the core in `dist/src`, compiled from `src/`) = **Apache-2.0** (permissive +
  patent grant; widest enterprise adoption).
- Full **application** (board, examples, infra, deployment, repo aggregate) = **GPL-3.0** (retained copyleft).

Expressed via root `LICENSE` (GPL-3.0) + `LICENSE-APACHE` (verbatim Apache-2.0), SPDX headers per file,
and `package.json "license": "Apache-2.0"` with `files` shipping core-only. See `LICENSING.md`.

## Consequences
- (+) Enterprises consume the runtime without copyleft obligations; explicit patent grant.
- (+) The application/product stays copyleft-protected.
- (−) Two licenses to maintain; SPDX hygiene required; CI must enforce (a) no copyleft runtime dep in
  the Apache core and (b) no GPL source compiled into `dist/src`.
- **License-compat audit (2026-06-18): PASS** — runtime deps all permissive (no GPL/AGPL/LGPL/SSPL).

## Alternatives considered
- Keep GPL-3.0 everywhere — rejected (blocks enterprise library adoption).
- MIT for the library — viable, but Apache-2.0's patent grant is preferred for enterprise.
- Relicense the whole repo to Apache-2.0 — rejected (loses copyleft on the application).
