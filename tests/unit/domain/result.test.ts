import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, type Result } from "../../../src/domain/result";

describe("Result<T,E>", () => {
  it("ok() creates a success result", () => {
    const result: Result<number, string> = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it("err() creates a failure result", () => {
    const result: Result<number, string> = err("something failed");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("something failed");
  });

  it("isOk() returns true for success results", () => {
    expect(isOk(ok("hello"))).toBe(true);
    expect(isOk(err("oops"))).toBe(false);
  });

  it("isErr() returns true for failure results", () => {
    expect(isErr(err("oops"))).toBe(true);
    expect(isErr(ok("hello"))).toBe(false);
  });

  it("value is not accessible on error result via type narrowing", () => {
    const result: Result<string, Error> = err(new Error("fail"));
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe("fail");
    }
  });
});
