# ADR-008: Env-gated JWT authentication for A2A and board

- Status: Accepted
- Date: 2026-06

## Context
The A2A RPC endpoint and the Socket.io board are network surfaces. Some deployments
are fully trusted/internal; others are exposed. Auth must be enforceable without
breaking the zero-config local demo.

## Decision
JWT (HS256) auth is implemented for both surfaces (`a2a-auth.ts`, `board-auth.ts`)
and **activated by presence of a secret** (`A2A_JWT_SECRET`, `BOARD_JWT_SECRET`).
When the secret is unset, the surface behaves exactly as before (no auth) — so the
control is `additive`/backward-compatible. Token lifetimes are fixed in code
(board 3600 s, A2A 86400 s).

## Consequences
- **+** Opt-in: trusted deployments stay simple; exposed ones harden with one env var.
- **+** Pairs with HMAC channel signing (ADR for state integrity) for defense in depth.
- **−** "Off by default" means operators must remember to enable it in production
  (called out in the production-readiness checklist and SECURITY.md).
