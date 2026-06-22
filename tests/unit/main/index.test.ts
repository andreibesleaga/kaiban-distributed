/**
 * main/index — role dispatcher (Finding #1 fix / ADR-013).
 *
 * The single image picks gateway vs worker at runtime from `ROLE`. Verifies:
 *   - resolveRole defaults to gateway and parses both roles case-insensitively
 *   - an unknown ROLE is rejected loudly
 *   - main(ROLE) dispatches to the correct entrypoint and NEVER to both
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  runGateway: vi.fn(() => Promise.resolve()),
  runWorker: vi.fn(() => Promise.resolve()),
}));

vi.mock("dotenv/config", () => ({}));
vi.mock("../../../src/main/gateway", () => ({ runGateway: h.runGateway }));
vi.mock("../../../src/main/worker", () => ({ runWorker: h.runWorker }));

import { resolveRole, main } from "../../../src/main/index";

describe("resolveRole", () => {
  it("defaults to gateway when ROLE is unset", () => {
    expect(resolveRole(undefined)).toBe("gateway");
  });

  it("parses gateway / worker case-insensitively and trimmed", () => {
    expect(resolveRole("worker")).toBe("worker");
    expect(resolveRole("  GATEWAY ")).toBe("gateway");
    expect(resolveRole("Worker")).toBe("worker");
  });

  it("throws on an unknown ROLE", () => {
    expect(() => resolveRole("orchestrator")).toThrow(/Invalid ROLE/);
  });
});

describe("main dispatcher", () => {
  beforeEach(() => {
    h.runGateway.mockClear();
    h.runWorker.mockClear();
  });

  it("runs ONLY the gateway for ROLE=gateway", async () => {
    await main("gateway");
    expect(h.runGateway).toHaveBeenCalledTimes(1);
    expect(h.runWorker).not.toHaveBeenCalled();
  });

  it("runs ONLY the worker for ROLE=worker", async () => {
    await main("worker");
    expect(h.runWorker).toHaveBeenCalledTimes(1);
    expect(h.runGateway).not.toHaveBeenCalled();
  });

  it("defaults to the gateway when ROLE is unset", async () => {
    await main(undefined);
    expect(h.runGateway).toHaveBeenCalledTimes(1);
    expect(h.runWorker).not.toHaveBeenCalled();
  });

  it("rejects an invalid ROLE", async () => {
    await expect(main("nope")).rejects.toThrow(/Invalid ROLE/);
  });
});
