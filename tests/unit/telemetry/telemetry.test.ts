/**
 * telemetry.ts — full coverage tests
 *
 * Covers: initTelemetry (both exporter branches), SIGTERM handler (success + error),
 * NodeSDK construction, SDK start, and OTEL console-fallback warning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Plain vi.fn() — no implementation — used with `new` safely
vi.mock('@opentelemetry/sdk-node', () => ({ NodeSDK: vi.fn() }));
vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: vi.fn().mockReturnValue([]),
}));
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({ OTLPTraceExporter: vi.fn() }));
vi.mock('@opentelemetry/sdk-trace-node', () => ({ ConsoleSpanExporter: vi.fn() }));
vi.mock('@opentelemetry/api', () => ({
  trace: { getActiveSpan: vi.fn().mockReturnValue(null) },
  propagation: { inject: vi.fn(), extract: vi.fn().mockReturnValue({}) },
  context: { active: vi.fn().mockReturnValue({}) },
  ROOT_CONTEXT: {},
}));

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { initTelemetry } from '../../../src/infrastructure/telemetry/telemetry';

/** Attach start/shutdown spies to the NodeSDK mock via prototype (avoids arrow fn constructor issue) */
function buildSDKSpies(shutdownPromise: Promise<void> = Promise.resolve()): { startSpy: ReturnType<typeof vi.fn>; shutdownSpy: ReturnType<typeof vi.fn> } {
  const startSpy    = vi.fn();
  const shutdownSpy = vi.fn().mockReturnValue(shutdownPromise);
  // Use a regular (non-arrow) function so `new NodeSDK()` works; attach methods to `this`
  vi.mocked(NodeSDK).mockImplementation(
    /* eslint-disable @typescript-eslint/no-explicit-any */
    function (this: any) {
      this.start    = startSpy;
      this.shutdown = shutdownSpy;
    } as unknown as typeof NodeSDK,
    /* eslint-enable @typescript-eslint/no-explicit-any */
  );
  return { startSpy, shutdownSpy };
}

describe('initTelemetry — exporter selection', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.removeAllListeners('SIGTERM');
    buildSDKSpies();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.removeAllListeners('SIGTERM');
  });

  it('uses OTLPTraceExporter when exporterEndpoint is provided', () => {
    initTelemetry({ serviceName: 'svc', exporterEndpoint: 'http://otel:4318/v1/traces' });
    expect(OTLPTraceExporter).toHaveBeenCalledWith({ url: 'http://otel:4318/v1/traces' });
    expect(ConsoleSpanExporter).not.toHaveBeenCalled();
  });

  it('does NOT log a warning when OTLP endpoint is provided', () => {
    initTelemetry({ serviceName: 'svc', exporterEndpoint: 'http://otel:4318/v1/traces' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('uses ConsoleSpanExporter when exporterEndpoint is undefined', () => {
    initTelemetry({ serviceName: 'svc' });
    expect(ConsoleSpanExporter).toHaveBeenCalledOnce();
    expect(OTLPTraceExporter).not.toHaveBeenCalled();
  });

  it('logs a dev-only warning when ConsoleSpanExporter fallback is used', () => {
    initTelemetry({ serviceName: 'svc' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ConsoleSpanExporter'));
  });

  it('constructs NodeSDK with the correct serviceName', () => {
    initTelemetry({ serviceName: 'my-service', exporterEndpoint: 'http://x' });
    expect(NodeSDK).toHaveBeenCalledWith(expect.objectContaining({ serviceName: 'my-service' }));
  });

  it('constructs NodeSDK with auto-instrumentations result', () => {
    initTelemetry({ serviceName: 'svc', exporterEndpoint: 'http://x' });
    expect(getNodeAutoInstrumentations).toHaveBeenCalledOnce();
    const sdkArgs = vi.mocked(NodeSDK).mock.calls[0][0] as Record<string, unknown>;
    expect(Array.isArray(sdkArgs['instrumentations'])).toBe(true);
  });

  it('calls sdk.start() after construction', () => {
    const { startSpy } = buildSDKSpies();
    initTelemetry({ serviceName: 'svc', exporterEndpoint: 'http://x' });
    expect(startSpy).toHaveBeenCalledOnce();
  });

  it('each call creates a NEW NodeSDK instance', () => {
    initTelemetry({ serviceName: 'a', exporterEndpoint: 'http://a' });
    initTelemetry({ serviceName: 'b', exporterEndpoint: 'http://b' });
    expect(NodeSDK).toHaveBeenCalledTimes(2);
  });
});

describe('initTelemetry — SIGTERM handler', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy  = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.removeAllListeners('SIGTERM');
    buildSDKSpies();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    process.removeAllListeners('SIGTERM');
  });

  it('registers a SIGTERM listener', () => {
    const before = process.listenerCount('SIGTERM');
    initTelemetry({ serviceName: 'svc', exporterEndpoint: 'http://x' });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
  });

  it('SIGTERM handler calls sdk.shutdown()', async () => {
    const { shutdownSpy } = buildSDKSpies();
    initTelemetry({ serviceName: 'svc', exporterEndpoint: 'http://x' });
    process.emit('SIGTERM');
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(shutdownSpy).toHaveBeenCalledOnce();
  });

  it('SIGTERM handler catches shutdown rejection and logs via console.error', async () => {
    const shutdownError = new Error('sdk shutdown failed');
    const { shutdownSpy } = buildSDKSpies(Promise.reject(shutdownError));
    initTelemetry({ serviceName: 'svc', exporterEndpoint: 'http://x' });
    process.emit('SIGTERM');
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(shutdownSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(shutdownError);
  });

  it('multiple calls each register their own SIGTERM listener', () => {
    const before = process.listenerCount('SIGTERM');
    initTelemetry({ serviceName: 'a', exporterEndpoint: 'http://a' });
    initTelemetry({ serviceName: 'b', exporterEndpoint: 'http://b' });
    expect(process.listenerCount('SIGTERM')).toBe(before + 2);
  });
});
