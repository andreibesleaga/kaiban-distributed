// SPDX-License-Identifier: Apache-2.0
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";
import {
  PeriodicExportingMetricReader,
  ConsoleMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { metrics, trace } from "@opentelemetry/api";
import { createStructuredLogger } from "../../shared/structured-logger";
import { onTelemetrySigterm, trackTelemetrySdk } from "./telemetry-shutdown";

const log = createStructuredLogger({ component: "Telemetry" });

export interface TelemetryConfig {
  serviceName: string;
  /**
   * The OTLP/HTTP base endpoint (OpenTelemetry's `OTEL_EXPORTER_OTLP_ENDPOINT`
   * semantics), e.g. `http://otel-collector:4318`. Traces go to `<base>/v1/traces`
   * and metrics to `<base>/v1/metrics`. A value that already ends in one of the
   * signal paths (the older documented form `…/v1/traces`) is reduced to its base.
   */
  exporterEndpoint?: string;
}

/** Per-signal OTLP/HTTP URLs for a base endpoint (a trailing signal path is tolerated). */
export function otlpSignalUrls(endpoint: string): { traces: string; metrics: string } {
  // The signal path goes on the URL's pathname; a query string (tenant, key)
  // and fragment are kept. Plain string work, no regular expression.
  const url = new URL(endpoint);
  let base = url.pathname;
  while (base.endsWith("/")) base = base.slice(0, -1);
  for (const signal of ["/v1/traces", "/v1/metrics", "/v1/logs"]) {
    if (base.endsWith(signal)) {
      base = base.slice(0, -signal.length);
      break;
    }
  }
  const withPath = (signal: string): string => {
    const u = new URL(url.href);
    u.pathname = `${base}${signal}`;
    return u.href;
  };
  return { traces: withPath("/v1/traces"), metrics: withPath("/v1/metrics") };
}

export function initTelemetry(config: TelemetryConfig): void {
  if (!config.exporterEndpoint) {
    log.warn(
      "No OTEL_EXPORTER_OTLP_ENDPOINT configured — using Console exporters (dev only)",
    );
  }
  const urls = config.exporterEndpoint
    ? otlpSignalUrls(config.exporterEndpoint)
    : null;
  const exporter = urls
    ? new OTLPTraceExporter({ url: urls.traces })
    : new ConsoleSpanExporter();

  const metricExporter = urls
    ? new OTLPMetricExporter({ url: urls.metrics })
    : new ConsoleMetricExporter();

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60000,
  });

  const sdk = new NodeSDK({
    serviceName: config.serviceName,
    traceExporter: exporter,
    metricReader,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();
  trackTelemetrySdk(sdk);

  // Kept for 2.0.x so a process without its own shutdown still flushes. A worker
  // or the gateway defers it (deferTelemetryShutdown) and flushes last itself.
  process.on("SIGTERM", onTelemetrySigterm);
}

// ── Metrics instruments ──────────────────────────────────────────────────────
const meter = metrics.getMeter("kaiban-distributed");
const messageProcessedCounter = meter.createCounter("kaiban.message.processed", {
  description: "Count of agent tasks processed, labelled by terminal status",
});
const messageLatencyHistogram = meter.createHistogram(
  "kaiban.message.latency",
  { unit: "ms", description: "Agent task processing latency in milliseconds" },
);

/** Increment the processed-message counter for a terminal status (e.g. completed|failed). */
export function recordMessageProcessed(status: string): void {
  messageProcessedCounter.add(1, { status });
}

/** Record agent task processing latency (ms) for a terminal status. */
export function recordMessageLatency(ms: number, status: string): void {
  messageLatencyHistogram.record(ms, { status });
}

/**
 * Record a custom anomaly event on the current active span.
 * Used by CircuitBreaker and other security components to emit
 * observable events for downstream anomaly detection.
 */
export function recordAnomalyEvent(
  eventName: string,
  attributes: Record<string, string | number | boolean>,
): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.addEvent(eventName, attributes);
  }
}
