# ADR-012 — Dependency policy: latest-stable, security-fixed, fix-forward

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Andrei Besleaga (maintainer), with Claude
- **Refs:** `KAIBAN-v2.0-MASTER-PLAN.md` §B7 / §B8 Phase 7eq; maintainer directive 2026-06-18

## Decision
Use the **best latest STABLE, security-fixed** version of every dependency where we can. Fall back only
on a *complete* breaking change — and even then, attempt the upgrade and **fix-forward** (adapt our code)
before holding. **Every upgrade is verified against the full gate** (typecheck · lint · build · 100%-cov
test · `npm audit --audit-level=high`) before it lands; majors get a fix-forward pass + diff-review.
Keep `engines.node: ">=22"` (Node 22 = maintenance LTS; Node 24 = active LTS; wider consumer compat).
This supersedes the master plan's narrower "pin conservative known-good" framing for KaibanJS (§B0).

## Adoption (verified online 2026-06-18 — versions/dates confirmed vs registry.npmjs.org)
**DONE:** `kaibanjs` 0.23.1 → **0.24.2** (full gate green, no bridge drift, 0 high/critical).

**ADOPT — low/no fix (backend):** `bullmq` 5.79.0 (drop-in) · `@opentelemetry/sdk-node` + `exporter-{trace,metrics}-otlp-http` **0.219.0** + `auto-instrumentations-node` **0.77.0** (bump together; `api` 1.9.x compatible; **host-metrics now default-on — verify**) · `dotenv` **17.4.2** (+ `quiet:true` so the lib doesn't log into consumers) · `happy-dom` (board) **20.10.6** (patch).

**ADOPT-WITH-FIXES — majors (fix-forward + verify):**
- `typescript` **6.0.3** (stable GA 2026-03; last JS-based TS before the TS7 Go rewrite). Pin tsconfig values explicitly; add `"types":[...]` if relying on the old implicit default; optionally `"ignoreDeprecations":"6.0"`. **Conditional hold** only if `vitest`/`typescript-eslint`/`api-extractor` lack TS6 peer support — verify first.
- `react` + `react-dom` **19.2.7** + `@types/react` **19.2.17** + `@types/react-dom` **19.2.3** (board). createRoot already required; new JSX transform satisfied by Vite plugin; run `react/19` + `types-react-codemod`.
- `zustand` **5.0.14** (board): named `{ create }` import; `shallow` → `useShallow`; add `use-sync-external-store` peer.
- `tailwindcss` **4.3.1** (board): CSS-first `@theme` config + `@import "tailwindcss"`; `@tailwindcss/vite` plugin; `npx @tailwindcss/upgrade`; review `border`/gradient default changes. Vite 8 + React 19 + Tailwind 4 compose cleanly (verified: `@tailwindcss/vite@4.3.1` peers `vite ^8`).

No HOLDs on security grounds (no open CVEs in any current line).

## Sequence (each = a verified increment under per-phase diff-review)
1. Backend safe drop-ins: bullmq + OTel (together) + dotenv(+quiet) → full gate.
2. happy-dom (board) → board test.
3. TypeScript 6.0.3 (root + board) after tooling TS6 peer-support check → full gate.
4. Board majors, one at a time: React 19 (+types) → zustand 5 → Tailwind 4 — each fix-forward + board build/test/a11y (and Playwright visual once added in v2.0 Phase V).

## Consequences
- (+) Latest security fixes + modern stack (React 19 / Tailwind 4 / TS 6) before the v2.0 feature work.
- (−) Several majors to fix-forward; do them incrementally with the gate as the guard, not in one big bang.
