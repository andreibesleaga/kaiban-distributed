# ADR-005: Distributed Tracing — W3C TraceContext Propagation

**Date:** 2026-03-10
**Status:** Accepted
**Deciders:** Engineering Team

---

## Context

When a task travels from orchestrator → BullMQ → agent worker → completion event, each hop is a separate process. Without trace context propagation, distributed traces are broken — the span from the worker appears disconnected from the initiating request. GDPR/SOC2/ISO 27001 require comprehensive audit trails including execution provenance.

## Decision

Inject W3C `traceparent`/`tracestate` headers into every `MessagePayload.traceHeaders` field on publish, and extract them on subscribe to maintain trace continuity:

**`BullMQDriver.publish()`:**
```typescript
const headers: Record<string, string> = {};
injectTraceContext(headers);   // sets traceparent, tracestate
const enrichedPayload = { ...payload, traceHeaders: headers };
await queue.add(payload.taskId, enrichedPayload);
```

**`BullMQDriver.subscribe()` worker callback:**
```typescript
const ctx = extractTraceContext(job.data.traceHeaders ?? {});
await otelContext.with(ctx, () => handler(job.data));
```

The same pattern applies to `KafkaDriver`. `TraceContext.ts` wraps `@opentelemetry/api` `propagation.inject/extract`.

## Considered Alternatives

| Option | Pros | Cons |
|--------|------|------|
| No tracing across queue hops | Simpler | Broken distributed traces; unacceptable for SOC2 |
| Custom correlation ID header | Lightweight | Non-standard; not compatible with OTEL collectors |
| **W3C TraceContext via OTEL** ✓ | Standard; works with all OTEL backends; auto-instrumentation compatible | Slight payload size increase |

## Consequences

- `MessagePayload.traceHeaders?: Record<string, string>` field carries W3C headers across queue boundaries
- `TraceContext.ts` is no longer dead code — imported by both `BullMQDriver` and `KafkaDriver`
- OpenTelemetry auto-instrumentation picks up the extracted context automatically
- The `?? {}` fallback ensures backward compatibility with payloads published before this change
