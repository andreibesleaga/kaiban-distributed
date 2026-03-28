/**
 * A2A service-to-service authentication — JWT issue/verify for agent/orchestrator callers.
 *
 * Env-var gated: when A2A_JWT_SECRET is not set, verifyA2AToken throws and the
 * GatewayApp middleware skips auth (backwards-compatible).  When set, all callers
 * must present a valid Bearer token on POST /a2a/rpc.
 */
import jwt from 'jsonwebtoken';

function getSecret(): string {
  const s = process.env['A2A_JWT_SECRET'];
  if (!s) throw new Error('A2A_JWT_SECRET not set');
  return s;
}

/**
 * Issue a long-lived service-to-service token.
 * Called by workers/orchestrators at startup.
 */
export function issueA2AToken(serviceId: string, expiresInSeconds = 86400): string {
  return jwt.sign({ sub: serviceId, role: 'a2a-client' }, getSecret(), {
    algorithm: 'HS256',
    expiresIn: expiresInSeconds,
  });
}

/**
 * Verify an Authorization: Bearer <token> header.
 * Throws on missing header, invalid format, bad signature, expiry, or missing A2A_JWT_SECRET.
 */
export function verifyA2AToken(authHeader: string | undefined): jwt.JwtPayload {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing Authorization header');
  return jwt.verify(authHeader.slice(7), getSecret(), { algorithms: ['HS256'] }) as jwt.JwtPayload;
}
