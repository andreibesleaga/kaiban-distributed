import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockTelemetry = vi.hoisted(() => ({
  shutdownTelemetry: vi.fn().mockResolvedValue(undefined),
  deferTelemetryShutdown: vi.fn(),
}));
vi.mock(
  "../../../src/infrastructure/telemetry/telemetry-shutdown",
  () => mockTelemetry,
);

import {
  registerNodeDrain,
  resetProcessDrain,
} from "../../../src/shared/process-drain";

describe("process drain", () => {
  let listeners: Record<string, Array<() => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetProcessDrain();
    listeners = {};
    vi.spyOn(process, "on").mockImplementation((event, handler) => {
      (listeners[String(event)] ??= []).push(handler as () => void);
      return process;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("takes the telemetry flush from the SDK's own listener on first registration", () => {
    registerNodeDrain(() => Promise.resolve(true));
    registerNodeDrain(() => Promise.resolve(true));
    expect(mockTelemetry.deferTelemetryShutdown).toHaveBeenCalledTimes(1);
    expect(listeners["SIGTERM"]?.length).toBe(1);
    expect(listeners["SIGINT"]?.length).toBe(1);
  });

  it("a drain that rejects counts as unclean and the process still flushes and exits 1", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        (_code?: number | string | null) => undefined as never,
      );
    registerNodeDrain(() => Promise.resolve(true));
    registerNodeDrain(() => Promise.reject(new Error("drain broke")));
    listeners["SIGINT"]![0]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(mockTelemetry.shutdownTelemetry).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
