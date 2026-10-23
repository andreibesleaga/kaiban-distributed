import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../../src/shared/structured-logger", () => ({
  createStructuredLogger: (): typeof mockLog => mockLog,
  logger: mockLog,
  resolveLogLevel: (): string => "silent",
}));

import {
  TELEMETRY_SHUTDOWN_TIMEOUT_MS,
  deferTelemetryShutdown,
  onTelemetrySigterm,
  resetTelemetryShutdown,
  shutdownTelemetry,
  trackTelemetrySdk,
} from "../../../src/infrastructure/telemetry/telemetry-shutdown";

describe("shutdownTelemetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes the tracked SDK once and hands every caller the same promise", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    trackTelemetrySdk({ shutdown });
    const first = shutdownTelemetry();
    const second = shutdownTelemetry();
    expect(second).toBe(first);
    await first;
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it("waits for a slow flush that finishes inside the bound", async () => {
    let finish!: () => void;
    const shutdown = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    trackTelemetrySdk({ shutdown });
    let settled = false;
    const p = shutdownTelemetry().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(TELEMETRY_SHUTDOWN_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    finish();
    await p;
    expect(settled).toBe(true);
  });

  it("gives up after the bound when the exporter hangs", async () => {
    trackTelemetrySdk({ shutdown: () => new Promise<void>(() => {}) });
    const p = shutdownTelemetry();
    await vi.advanceTimersByTimeAsync(TELEMETRY_SHUTDOWN_TIMEOUT_MS);
    await p;
    expect(mockLog.warn).toHaveBeenCalledWith(
      { timeoutMs: TELEMETRY_SHUTDOWN_TIMEOUT_MS },
      "Telemetry flush timed out — exiting without it",
    );
  });

  it("logs a failed flush and still resolves", async () => {
    const err = new Error("export failed");
    trackTelemetrySdk({ shutdown: () => Promise.reject(err) });
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    expect(mockLog.error).toHaveBeenCalledWith(
      { err },
      "Telemetry SDK shutdown failed",
    );
  });

  it("a newly tracked SDK gets its own flush", async () => {
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);
    trackTelemetrySdk({ shutdown: a });
    await shutdownTelemetry();
    trackTelemetrySdk({ shutdown: b });
    await shutdownTelemetry();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("resolves at once when telemetry was never started", async () => {
    vi.resetModules();
    const fresh =
      await import("../../../src/infrastructure/telemetry/telemetry-shutdown");
    await expect(fresh.shutdownTelemetry()).resolves.toBeUndefined();
  });
});

describe("onTelemetrySigterm", () => {
  beforeEach(() => {
    resetTelemetryShutdown();
  });

  it("flushes when no ordered shutdown owns the flush", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    trackTelemetrySdk({ shutdown });
    onTelemetrySigterm();
    await shutdownTelemetry();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("does nothing once a worker drain or the gateway has deferred it", () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    trackTelemetrySdk({ shutdown });
    deferTelemetryShutdown();
    onTelemetrySigterm();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("reset forgets the tracked SDK: a later shutdown resolves without flushing", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    trackTelemetrySdk({ shutdown });
    resetTelemetryShutdown();
    await shutdownTelemetry();
    expect(shutdown).not.toHaveBeenCalled();
  });
});
