import { describe, it, expect, vi, afterEach } from "vitest";

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
  hitlDecisionTtlSeconds,
  DEFAULT_HITL_DECISION_TTL_SECONDS,
  MAX_HITL_DECISION_TTL_SECONDS,
} from "../../../src/shared/hitl-retention";

const read = (v?: string): number =>
  hitlDecisionTtlSeconds(v === undefined ? {} : { HITL_DECISION_TTL_SECONDS: v });

describe("hitlDecisionTtlSeconds", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to exactly 300 seconds when unset or blank, without a warning", () => {
    mockLog.warn.mockClear();
    expect(DEFAULT_HITL_DECISION_TTL_SECONDS).toBe(300);
    expect(read()).toBe(300);
    expect(read("  ")).toBe(300);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it("reads process.env when no environment is passed", () => {
    vi.stubEnv("HITL_DECISION_TTL_SECONDS", "900");
    expect(hitlDecisionTtlSeconds()).toBe(900);
  });

  it("accepts a whole number from 1 up to seven days", () => {
    expect(read("1")).toBe(1);
    expect(read(" 3600 ")).toBe(3600);
    expect(read(String(MAX_HITL_DECISION_TTL_SECONDS))).toBe(604_800);
  });

  it.each(["0", "-5", "5m", "1.5", "abc"])(
    "rejects %s and falls back to 300",
    (v) => {
      mockLog.warn.mockClear();
      expect(read(v)).toBe(300);
      expect(mockLog.warn).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a value above seven days with a warning", () => {
    mockLog.warn.mockClear();
    expect(read(String(MAX_HITL_DECISION_TTL_SECONDS + 1))).toBe(300);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
  });
});
