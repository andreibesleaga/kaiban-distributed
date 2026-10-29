// SPDX-License-Identifier: Apache-2.0
import { createStructuredLogger } from "../../shared/structured-logger";

const log = createStructuredLogger({ component: "Telemetry" });

/**
 * Longest (ms) a shutdown waits for the exporters to flush before giving up.
 * A worker flushes after its 25 s drain, so 3 s keeps the exit inside the
 * default 30 s Kubernetes termination grace period.
 */
export const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 3_000;

/** The one method of the OpenTelemetry SDK that the shutdown path needs. */
interface FlushableSdk {
  shutdown(): Promise<void>;
}

interface TrackedSdk {
  sdk: FlushableSdk;
  /** The flush in flight (or done): every caller gets this same promise. */
  flush: Promise<void> | null;
}

let tracked: TrackedSdk | null = null;
/** Set by a process that flushes telemetry itself, last in its own shutdown. */
let ownedByShutdown = false;

/** Remember the SDK started by `initTelemetry`, so a shutdown can flush it. */
export function trackTelemetrySdk(sdk: FlushableSdk): void {
  tracked = { sdk, flush: null };
}

async function flushBounded(sdk: FlushableSdk): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log.warn(
        { timeoutMs: TELEMETRY_SHUTDOWN_TIMEOUT_MS },
        "Telemetry flush timed out — exiting without it",
      );
      resolve();
    }, TELEMETRY_SHUTDOWN_TIMEOUT_MS);
  });
  const flush = sdk
    .shutdown()
    .catch((err: unknown) =>
      log.error({ err }, "Telemetry SDK shutdown failed"),
    );
  await Promise.race([flush, bound]);
  clearTimeout(timer);
}

/**
 * Flush and stop telemetry once. Safe to call from any number of exit paths
 * (the SDK's own SIGTERM listener and a worker's drain): the first call starts
 * the flush, later calls get the same promise. It never rejects and never waits
 * longer than `TELEMETRY_SHUTDOWN_TIMEOUT_MS`, so a hung exporter cannot block exit.
 * Resolves at once when telemetry was never started.
 */
export function shutdownTelemetry(): Promise<void> {
  if (!tracked) return Promise.resolve();
  tracked.flush ??= flushBounded(tracked.sdk);
  return tracked.flush;
}

/**
 * Called by a process with its own ordered shutdown (a worker's drain, the
 * gateway): it flushes telemetry itself as the last step, so the SDK's own
 * SIGTERM listener must stand down — otherwise it starts the once-only flush
 * at the signal, before the drain's spans and metrics exist.
 */
export function deferTelemetryShutdown(): void {
  ownedByShutdown = true;
}

/** The SDK's own SIGTERM listener: flushes only when no ordered shutdown owns the flush. */
export function onTelemetrySigterm(): void {
  if (!ownedByShutdown) void shutdownTelemetry();
}

/** Test seam: forget the tracked SDK and who owns the flush. */
export function resetTelemetryShutdown(): void {
  tracked = null;
  ownedByShutdown = false;
}
