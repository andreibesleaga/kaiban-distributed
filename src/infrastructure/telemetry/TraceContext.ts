import { propagation, context, ROOT_CONTEXT } from "@opentelemetry/api";

export function injectTraceContext(carrier: Record<string, string>): void {
  propagation.inject(context.active(), carrier);
}

export function extractTraceContext(
  carrier: Record<string, string>,
): ReturnType<typeof propagation.extract> {
  return propagation.extract(ROOT_CONTEXT, carrier);
}

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/**
 * Defensively coerce a possibly-untrusted `traceHeaders` value from a message
 * payload into a safe `string→string` map before `extractTraceContext`: drops
 * non-string keys/values and rejects a malformed W3C `traceparent`. Shared by
 * every messaging driver so crafted payloads can't inject bad trace headers.
 */
export function sanitizeTraceHeaders(raw: unknown): Record<string, string> {
  const safe: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null) return safe;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === "string" && typeof v === "string") {
      if (k === "traceparent" && !TRACEPARENT_RE.test(v)) continue;
      safe[k] = v;
    }
  }
  return safe;
}
