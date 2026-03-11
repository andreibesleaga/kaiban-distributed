import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { trace } from '@opentelemetry/api';

export interface TelemetryConfig {
  serviceName: string;
  exporterEndpoint?: string;
}

let sdk: NodeSDK | null = null;

export function initTelemetry(config: TelemetryConfig): void {
  const exporter = config.exporterEndpoint
    ? new OTLPTraceExporter({ url: config.exporterEndpoint })
    : new ConsoleSpanExporter();

  sdk = new NodeSDK({
    serviceName: config.serviceName,
    traceExporter: exporter,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();

  process.on('SIGTERM', () => {
    sdk?.shutdown().catch(console.error);
  });
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
