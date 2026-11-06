// SPDX-License-Identifier: Apache-2.0
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

/** True when the parsed value has the signed-envelope shape (any JSON may arrive). */
function isEnvelope(value: unknown): value is SignedEnvelope {
  if (value === null || typeof value !== "object") return false;
  const v = value as Partial<SignedEnvelope>;
  return Boolean(v.payload) && typeof v.sig === "string" && typeof v.ts === "number";
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

export interface UnwrapOptions {
  /**
   * Largest accepted difference between the envelope time and this node's clock
   * (default 30 000 ms). `Infinity` checks the signature only. The control
   * channel uses that: a STOP ALL must not be lost to clock skew, and a replayed
   * older stop is already a no-op there (ES-8).
   */
  maxSkewMs?: number;
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
export function unwrapVerified(
  raw: string,
  opts: UnwrapOptions = {},
): Record<string, unknown> | null {
  const secret = process.env["CHANNEL_SIGNING_SECRET"];
  if (!secret) {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isEnvelope(envelope)) return null;

  // Replay protection: reject messages older than MAX_CLOCK_SKEW_MS
  const maxSkew = opts.maxSkewMs ?? MAX_CLOCK_SKEW_MS;
  if (Math.abs(Date.now() - envelope.ts) > maxSkew) return null;

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
