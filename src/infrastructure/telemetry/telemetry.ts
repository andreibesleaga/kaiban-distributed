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

export interface TelemetryConfig {
  serviceName: string;
  exporterEndpoint?: string;
}

let sdk: NodeSDK | null = null;

export function initTelemetry(config: TelemetryConfig): void {
  if (!config.exporterEndpoint) {
    console.warn(
      "[Telemetry] No OTEL_EXPORTER_OTLP_ENDPOINT configured — using ConsoleSpanExporter (dev only)",
    );
  }
  const exporter = config.exporterEndpoint
    ? new OTLPTraceExporter({ url: config.exporterEndpoint })
    : new ConsoleSpanExporter();

  const metricExporter = config.exporterEndpoint
    ? new OTLPMetricExporter({ url: config.exporterEndpoint })
    : new ConsoleMetricExporter();

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60000,
  });

  sdk = new NodeSDK({
    serviceName: config.serviceName,
    traceExporter: exporter,
    metricReader,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();

  process.on("SIGTERM", () => {
    sdk?.shutdown().catch(console.error);
  });
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
