/**
 * Board viewer authentication — JWT issue/verify for Socket.io board clients.
 *
 * Env-var gated: when BOARD_JWT_SECRET is not set, both functions throw, and the
 * SocketGateway middleware skips auth (backwards-compatible with deployments that
 * have not set up auth yet).  When set, tokens are signed/verified with HS256.
 */
import jwt from "jsonwebtoken";

function getSecret(): string {
  const s = process.env["BOARD_JWT_SECRET"];
  if (!s) throw new Error("BOARD_JWT_SECRET not set");
  return s;
}

/**
 * Issue a short-lived board viewer token.
 * Call from an admin CLI or CI step to hand out to board operators.
 */
export function issueBoardToken(
  subject: string,
  expiresInSeconds = 3600,
): string {
  return jwt.sign({ sub: subject, role: "board-viewer" }, getSecret(), {
    algorithm: "HS256",
    expiresIn: expiresInSeconds,
  });
}

/**
 * Verify and decode a board viewer token.
 * Throws on invalid signature, expiry, or missing BOARD_JWT_SECRET.
 */
export function verifyBoardToken(token: string): jwt.JwtPayload {
  return jwt.verify(token, getSecret(), {
    algorithms: ["HS256"],
  }) as jwt.JwtPayload;
}
