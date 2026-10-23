/**
 * 2.0.1 security defaults — in production, a secret that IS set must be strong
 * (at least 32 bytes) and distinct from the other secrets; boot fails otherwise.
 * A missing secret refuses boot too, unless ALLOW_INSECURE_PRODUCTION=true
 * (which warns on every start). Outside production nothing changes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../../src/main/config";

const STRONG_A = "a".repeat(32);
const STRONG_B = "b".repeat(40);

describe("loadConfig — production secret strength", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { AGENT_IDS: "agent-1", NODE_ENV: "production" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const setAll = (): void => {
    process.env["BOARD_JWT_SECRET"] = STRONG_A;
    process.env["A2A_JWT_SECRET"] = STRONG_B;
    process.env["CHANNEL_SIGNING_SECRET"] = "c".repeat(32);
  };

  it("refuses to boot when a secret is missing, naming it", () => {
    process.env["BOARD_JWT_SECRET"] = STRONG_A;
    expect(() => loadConfig()).toThrow(
      /A2A_JWT_SECRET.*required in production/,
    );
  });

  it("ALLOW_INSECURE_PRODUCTION=true boots without secrets", () => {
    process.env["ALLOW_INSECURE_PRODUCTION"] = "true";
    expect(() => loadConfig()).not.toThrow();
  });

  it("boots with all three secrets strong and distinct", () => {
    setAll();
    expect(() => loadConfig()).not.toThrow();
  });

  it("refuses a secret shorter than 32 bytes, naming it but not printing it", () => {
    setAll();
    process.env["A2A_JWT_SECRET"] = "changeme";
    expect(() => loadConfig()).toThrow(/A2A_JWT_SECRET.*32 bytes/);
    try {
      loadConfig();
    } catch (e) {
      expect(String(e)).not.toContain("changeme");
    }
  });

  it("refuses the same value in two secrets", () => {
    setAll();
    process.env["BOARD_JWT_SECRET"] = STRONG_A;
    process.env["A2A_JWT_SECRET"] = STRONG_A;
    expect(() => loadConfig()).toThrow(
      /BOARD_JWT_SECRET.*A2A_JWT_SECRET.*distinct/,
    );
  });

  it("outside production a short secret is allowed (local development)", () => {
    process.env["NODE_ENV"] = "development";
    process.env["BOARD_JWT_SECRET"] = "dev";
    expect(() => loadConfig()).not.toThrow();
  });
});
