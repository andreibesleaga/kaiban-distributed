import { describe, it, expect } from "vitest";
import {
  resolveLogLevel,
  createStructuredLogger,
  buildPinoOptions,
  logger,
} from "../../../src/shared/structured-logger";

describe("structured-logger", () => {
  describe("resolveLogLevel", () => {
    it("uses LOG_LEVEL when explicitly set", () => {
      expect(resolveLogLevel({ LOG_LEVEL: "debug" })).toBe("debug");
    });
    it("is silent under VITEST", () => {
      expect(resolveLogLevel({ VITEST: "true" })).toBe("silent");
    });
    it("is silent under NODE_ENV=test", () => {
      expect(resolveLogLevel({ NODE_ENV: "test" })).toBe("silent");
    });
    it("defaults to info otherwise", () => {
      expect(resolveLogLevel({})).toBe("info");
    });
  });

  describe("buildPinoOptions", () => {
    it("returns JSON options with no transport by default", () => {
      const opts = buildPinoOptions({});
      expect(opts.transport).toBeUndefined();
      expect(opts.level).toBe("info");
    });
    it("adds the pino-pretty transport when LOG_PRETTY=true", () => {
      const opts = buildPinoOptions({ LOG_PRETTY: "true" });
      expect(opts.transport).toMatchObject({ target: "pino-pretty" });
    });
    it("redacts sensitive fields", () => {
      const opts = buildPinoOptions({});
      expect(opts.redact).toMatchObject({ censor: "[redacted]" });
    });
  });

  it("createStructuredLogger returns a child logger carrying the bindings", () => {
    const child = createStructuredLogger({ component: "unit-test" });
    expect(typeof child.info).toBe("function");
    expect(child.bindings()).toMatchObject({ component: "unit-test" });
  });

  it("exports a base logger", () => {
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });
});
