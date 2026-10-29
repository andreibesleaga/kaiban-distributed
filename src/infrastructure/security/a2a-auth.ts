// SPDX-License-Identifier: Apache-2.0
/**
 * A2A service-to-service authentication — JWT issue/verify for agent/orchestrator callers.
 *
 * Env-var gated: when A2A_JWT_SECRET is not set, verifyA2AToken throws and the
 * GatewayApp middleware skips auth (backwards-compatible).  When set, all callers
 * must present a valid Bearer token on POST /a2a/rpc.
 */
import jwt from "jsonwebtoken";

const A2A_ROLE = "a2a-client";

function getSecret(): string {
  const s = process.env["A2A_JWT_SECRET"];
  if (!s) throw new Error("A2A_JWT_SECRET not set");
  return s;
}

/**
 * Issue a long-lived service-to-service token.
 * Called by workers/orchestrators at startup.
 */
export function issueA2AToken(
  serviceId: string,
  expiresInSeconds = 86400,
): string {
  return jwt.sign({ sub: serviceId, role: A2A_ROLE }, getSecret(), {
    algorithm: "HS256",
    expiresIn: expiresInSeconds,
  });
}

/**
 * Verify an Authorization: Bearer <token> header.
 * Throws on missing header, invalid format, bad signature, expiry, wrong role (e.g. a board token signed
 * with the same secret), or missing A2A_JWT_SECRET.
 */
export function verifyA2AToken(authHeader: string | undefined): jwt.JwtPayload {
  if (!authHeader?.startsWith("Bearer "))
    throw new Error("Missing Authorization header");
  const payload = jwt.verify(authHeader.slice(7), getSecret(), {
    algorithms: ["HS256"],
  }) as jwt.JwtPayload;
  if (payload["role"] !== A2A_ROLE) throw new Error("Wrong token role");
  return payload;
}
