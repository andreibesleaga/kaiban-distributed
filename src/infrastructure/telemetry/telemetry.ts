import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';

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
