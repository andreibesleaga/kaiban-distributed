import { describe, it, expect } from "vitest";
import { timeoutMsFromEnv, MAX_TIMER_MS } from "../../../src/shared/timeout-env";

const read = (v?: string): number | undefined =>
  timeoutMsFromEnv("T", v === undefined ? {} : { T: v });

describe("timeoutMsFromEnv", () => {
  it("returns undefined when unset or blank", () => {
    expect(read()).toBeUndefined();
    expect(read("  ")).toBeUndefined();
  });

  it("accepts whole numbers from 1 to the Node timer limit", () => {
    expect(read("1")).toBe(1);
    expect(read(" 45000 ")).toBe(45_000);
    expect(read(String(MAX_TIMER_MS))).toBe(MAX_TIMER_MS);
  });

  it.each(["0", "-5", "5m", "1e6", "1.5", "abc", "3000000000", String(MAX_TIMER_MS + 1)])(
    "rejects %s (the caller's default applies)",
    (v) => {
      expect(read(v)).toBeUndefined();
    },
  );
});

import { positiveIntFromEnv } from "../../../src/shared/timeout-env";

describe("positiveIntFromEnv", () => {
  const get = (v?: string): number =>
    positiveIntFromEnv("N", 10, v === undefined ? {} : { N: v });
  it("uses the fallback when unset or blank", () => {
    expect(get()).toBe(10);
    expect(get(" ")).toBe(10);
  });
  it("accepts a whole number >= 1", () => {
    expect(get("3")).toBe(3);
  });
  it.each(["0", "-1", "ten", "2.5", "1e3"])("falls back for %s", (v) => {
    expect(get(v)).toBe(10);
  });
});
