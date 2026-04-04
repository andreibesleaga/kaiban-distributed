import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "../../../src/shared";

describe("createLogger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("info() calls console.log with [tag] prefix", () => {
    const log = createLogger("MyTag");
    log.info("hello world");
    expect(logSpy).toHaveBeenCalledWith("[MyTag] hello world");
  });

  it("warn() calls console.warn with [tag] prefix", () => {
    const log = createLogger("MyTag");
    log.warn("something is off");
    expect(warnSpy).toHaveBeenCalledWith("[MyTag] something is off");
  });

  it("error() calls console.error with [tag] prefix and message (no cause)", () => {
    const log = createLogger("MyTag");
    log.error("fatal error");
    expect(errorSpy).toHaveBeenCalledWith("[MyTag] fatal error");
  });

  it("error() includes cause when provided", () => {
    const log = createLogger("MyTag");
    const cause = new Error("root cause");
    log.error("outer error", cause);
    expect(errorSpy).toHaveBeenCalledWith("[MyTag] outer error", cause);
  });

  it("separator() prints a line of repeated default char (─) at default length 60", () => {
    const log = createLogger("MyTag");
    log.separator();
    expect(logSpy).toHaveBeenCalledWith("─".repeat(60));
  });

  it("separator() accepts custom char and length", () => {
    const log = createLogger("MyTag");
    log.separator("-", 20);
    expect(logSpy).toHaveBeenCalledWith("-".repeat(20));
  });

  it("header() prints three lines: blank+line, title, line", () => {
    const log = createLogger("MyTag");
    log.header("STEP 1", 40);
    const calls = logSpy.mock.calls;
    expect(calls[0]?.[0]).toBe("\n" + "=".repeat(40));
    expect(calls[1]?.[0]).toBe(" STEP 1");
    expect(calls[2]?.[0]).toBe("=".repeat(40));
  });

  it("header() uses default length 60", () => {
    const log = createLogger("T");
    log.header("start");
    expect(logSpy.mock.calls[0]?.[0]).toBe("\n" + "=".repeat(60));
  });

  it("different tags produce independent loggers", () => {
    const log1 = createLogger("A");
    const log2 = createLogger("B");
    log1.info("from A");
    log2.info("from B");
    expect(logSpy).toHaveBeenCalledWith("[A] from A");
    expect(logSpy).toHaveBeenCalledWith("[B] from B");
  });
});
