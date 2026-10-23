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
  (called out in SECURITY.md).

## Addendum (2.0.2, additive)
The two token kinds are now told apart by the `role` claim the issuers already set
(`board-viewer` from `issueBoardToken`, `a2a-client` from `issueA2AToken`).
`verifyBoardToken` rejects any token whose role is not `board-viewer`, and
`verifyA2AToken` rejects any token whose role is not `a2a-client`, after the
signature and expiry checks. Before this, separation rested only on the two secrets
being different; with `BOARD_JWT_SECRET` equal to `A2A_JWT_SECRET` a board token
opened `/a2a/rpc` and the MCP routes. No claim was added, so tokens from the existing
issue helpers keep working; hand-signed tokens must carry the right `role`.
Strict `iss`/`aud` checks are not part of this change (planned for 2.1).
