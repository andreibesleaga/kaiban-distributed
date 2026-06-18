# Licensing — kaiban-distributed

kaiban-distributed is **dual-licensed** (open-core), decided in [ADR-011](docs/decisions/ADR-011-dual-license.md):

| What | License | Why |
|---|---|---|
| The **published npm library** — the core in `dist/src` (compiled from `src/`) | **Apache-2.0** | Permissive + explicit patent grant → widest enterprise adoption; downstream code can use the runtime without copyleft obligations. |
| The **full application** — `board/`, `examples/`, `infra/`, deployment, scripts, docs, and the repository as an aggregate | **GPL-3.0** | Retains strong copyleft on the application/product. |

The sole copyright holder (Andrei Besleaga) offers the library under Apache-2.0 while the repository
aggregate remains GPL-3.0.

## How it is expressed
- `LICENSE` (repo root) — **GPL-3.0** (the application / aggregate).
- `LICENSE-APACHE` (repo root) — the **verbatim Apache License 2.0** (the published library).
- **SPDX headers** per file: `SPDX-License-Identifier: Apache-2.0` on `src/**` (the published core);
  `SPDX-License-Identifier: GPL-3.0-only` on `board/**`, `examples/**`, `infra/**`, scripts.
- `package.json` `"license": "Apache-2.0"` (the npm package = the library only; `files: ["dist/src", …]`
  excludes the GPL app/board/examples). The npm tarball ships `LICENSE-APACHE`.

## Dependency license-compatibility audit (2026-06-18)
Runtime (prod) dependencies of the published core were scanned for copyleft licenses
(GPL / AGPL / LGPL / SSPL): **none found** — all permissive (MIT / Apache-2.0 / BSD-2-Clause / ISC).
⇒ the Apache-2.0 library can redistribute its runtime deps with no copyleft conflict. This audit is
wired into CI (a `license-checker` gate) so a future copyleft dependency fails the build.

> Before each release (Phase 4b / Phase 9): re-run the audit, confirm the published surface stays
> **core-only**, and confirm no GPL-licensed source is compiled into `dist/src`.
