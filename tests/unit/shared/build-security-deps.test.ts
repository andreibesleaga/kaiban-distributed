import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getBoolEnv, buildSecurityDeps } from "../../../src/shared";

// Mock the infrastructure dependencies used by buildSecurityDeps
const { mockFirewall, mockBreaker, mockTokenProvider } = vi.hoisted(() => ({
  mockFirewall: { inspect: vi.fn() },
  mockBreaker: { allow: vi.fn() },
  mockTokenProvider: { getToken: vi.fn() },
}));

vi.mock("../../../src/infrastructure/security/heuristic-firewall", () => ({
  HeuristicFirewall: vi.fn().mockImplementation(function () {
    return mockFirewall;
  }),
}));

vi.mock("../../../src/infrastructure/security/sliding-window-breaker", () => ({
  SlidingWindowBreaker: vi.fn().mockImplementation(function () {
    return mockBreaker;
  }),
}));

vi.mock("../../../src/infrastructure/security/env-token-provider", () => ({
  EnvTokenProvider: vi.fn().mockImplementation(function () {
    return mockTokenProvider;
  }),
}));

describe("getBoolEnv", () => {
  afterEach(() => {
    delete process.env["TEST_BOOL"];
  });

  it("returns defaultValue when env var is not set", () => {
    delete process.env["TEST_BOOL"];
    expect(getBoolEnv("TEST_BOOL", false)).toBe(false);
    expect(getBoolEnv("TEST_BOOL", true)).toBe(true);
  });

  it("returns true when env var is 'true'", () => {
    process.env["TEST_BOOL"] = "true";
    expect(getBoolEnv("TEST_BOOL", false)).toBe(true);
  });

  it("returns true when env var is '1'", () => {
    process.env["TEST_BOOL"] = "1";
    expect(getBoolEnv("TEST_BOOL", false)).toBe(true);
  });

  it("returns false when env var is 'false'", () => {
    process.env["TEST_BOOL"] = "false";
    expect(getBoolEnv("TEST_BOOL", true)).toBe(false);
  });

  it("returns false when env var is any other string", () => {
    process.env["TEST_BOOL"] = "yes";
    expect(getBoolEnv("TEST_BOOL", true)).toBe(false);
  });
});

describe("buildSecurityDeps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["SEMANTIC_FIREWALL_ENABLED"];
    delete process.env["CIRCUIT_BREAKER_ENABLED"];
    delete process.env["JIT_TOKENS_ENABLED"];
    delete process.env["CIRCUIT_BREAKER_THRESHOLD"];
    delete process.env["CIRCUIT_BREAKER_WINDOW_MS"];
  });

  afterEach(() => {
    delete process.env["SEMANTIC_FIREWALL_ENABLED"];
    delete process.env["CIRCUIT_BREAKER_ENABLED"];
    delete process.env["JIT_TOKENS_ENABLED"];
    delete process.env["CIRCUIT_BREAKER_THRESHOLD"];
    delete process.env["CIRCUIT_BREAKER_WINDOW_MS"];
  });

  it("returns empty actorDeps and no tokenProvider when all flags disabled", () => {
    const { actorDeps, tokenProvider } = buildSecurityDeps();
    expect(actorDeps.firewall).toBeUndefined();
    expect(actorDeps.circuitBreaker).toBeUndefined();
    expect(tokenProvider).toBeUndefined();
  });

  it("creates HeuristicFirewall when SEMANTIC_FIREWALL_ENABLED=true", async () => {
    process.env["SEMANTIC_FIREWALL_ENABLED"] = "true";
    const { HeuristicFirewall } =
      await import("../../../src/infrastructure/security/heuristic-firewall");
    const { actorDeps } = buildSecurityDeps();
    expect(HeuristicFirewall).toHaveBeenCalled();
    expect(actorDeps.firewall).toBe(mockFirewall);
  });

  it("creates SlidingWindowBreaker when CIRCUIT_BREAKER_ENABLED=true with defaults", async () => {
    process.env["CIRCUIT_BREAKER_ENABLED"] = "true";
    const { SlidingWindowBreaker } =
      await import("../../../src/infrastructure/security/sliding-window-breaker");
    vi.clearAllMocks();
    const { actorDeps } = buildSecurityDeps();
    expect(SlidingWindowBreaker).toHaveBeenCalledWith(10, 60000);
    expect(actorDeps.circuitBreaker).toBe(mockBreaker);
  });

  it("respects CIRCUIT_BREAKER_THRESHOLD and CIRCUIT_BREAKER_WINDOW_MS", async () => {
    process.env["CIRCUIT_BREAKER_ENABLED"] = "true";
    process.env["CIRCUIT_BREAKER_THRESHOLD"] = "5";
    process.env["CIRCUIT_BREAKER_WINDOW_MS"] = "30000";
    const { SlidingWindowBreaker } =
      await import("../../../src/infrastructure/security/sliding-window-breaker");
    vi.clearAllMocks();
    buildSecurityDeps();
    expect(SlidingWindowBreaker).toHaveBeenCalledWith(5, 30000);
  });

  it("creates EnvTokenProvider when JIT_TOKENS_ENABLED=true", async () => {
    process.env["JIT_TOKENS_ENABLED"] = "true";
    const { EnvTokenProvider } =
      await import("../../../src/infrastructure/security/env-token-provider");
    vi.clearAllMocks();
    const { tokenProvider } = buildSecurityDeps();
    expect(EnvTokenProvider).toHaveBeenCalled();
    expect(tokenProvider).toBe(mockTokenProvider);
  });

  it("enables all three when all flags are set", async () => {
    process.env["SEMANTIC_FIREWALL_ENABLED"] = "true";
    process.env["CIRCUIT_BREAKER_ENABLED"] = "true";
    process.env["JIT_TOKENS_ENABLED"] = "true";
    const { actorDeps, tokenProvider } = buildSecurityDeps();
    expect(actorDeps.firewall).toBeDefined();
    expect(actorDeps.circuitBreaker).toBeDefined();
    expect(tokenProvider).toBeDefined();
  });
});
