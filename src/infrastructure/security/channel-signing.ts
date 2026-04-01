/**
 * HMAC-SHA256 message signing for Redis pub/sub channels.
 *
 * Env-var gated on CHANNEL_SIGNING_SECRET:
 * - When unset: wrapSigned returns plain JSON, unwrapVerified parses plain JSON (legacy mode).
 * - When set: wrapSigned wraps payload in a signed envelope, unwrapVerified validates the
 *   HMAC and rejects messages with clock skew > 30 s (replay protection).
 *
 * All publishers (AgentStatePublisher, OrchestratorStatePublisher) use wrapSigned.
 * The SocketGateway consumer uses unwrapVerified.
 */
import { createHmac, timingSafeEqual } from "crypto";

/** Maximum age of a signed message before it is considered a replay attack. */
const MAX_CLOCK_SKEW_MS = 30_000;

interface SignedEnvelope {
  payload: Record<string, unknown>;
  sig: string;
  ts: number;
}

/**
 * Wrap a state delta in a signed envelope.
 * Returns plain JSON when CHANNEL_SIGNING_SECRET is not set.
 */
export function wrapSigned(payload: Record<string, unknown>): string {
  const secret = process.env["CHANNEL_SIGNING_SECRET"];
  if (!secret) return JSON.stringify(payload);
  const ts = Date.now();
  const body = `${ts}.${JSON.stringify(payload)}`;
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  const envelope: SignedEnvelope = { payload, sig, ts };
  return JSON.stringify(envelope);
}

/**
 * Verify and unwrap a signed envelope from a Redis channel.
 * Returns the inner payload on success, or null if:
 *   - HMAC validation fails (tampering)
 *   - Clock skew > 30 s (replay)
 *   - Envelope fields are missing or malformed
 *
 * When CHANNEL_SIGNING_SECRET is not set, parses as plain JSON (legacy pass-through).
 * Returns null on any JSON parse error regardless of mode.
 */
export function unwrapVerified(raw: string): Record<string, unknown> | null {
  const secret = process.env["CHANNEL_SIGNING_SECRET"];
  if (!secret) {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  let envelope: Partial<SignedEnvelope>;
  try {
    envelope = JSON.parse(raw) as Partial<SignedEnvelope>;
  } catch {
    return null;
  }

  if (
    !envelope.payload ||
    typeof envelope.sig !== "string" ||
    typeof envelope.ts !== "number"
  ) {
    return null;
  }

  // Replay protection: reject messages older than MAX_CLOCK_SKEW_MS
  if (Math.abs(Date.now() - envelope.ts) > MAX_CLOCK_SKEW_MS) return null;

  const body = `${envelope.ts}.${JSON.stringify(envelope.payload)}`;
  const expected = createHmac("sha256", secret).update(body).digest("hex");

  try {
    if (
      !timingSafeEqual(
        Buffer.from(expected, "hex"),
        Buffer.from(envelope.sig, "hex"),
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return envelope.payload;
}
