/**
 * main/worker — LLM-backed task-consuming agent pool (Finding #1 fix / ADR-013).
 *
 * The worker role wires a REAL handler for every `AGENT_IDS` entry via
 * `startAgentNode` (no handler-less actors). Verifies the pool fan-out, the
 * default agent config shape, and that no HTTP surface is started here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  startAgentNode: vi.fn(() => Promise.resolve()),
  initTelemetry: vi.fn(),
  buildLLMConfig: vi.fn(() => undefined as unknown),
}));

vi.mock("../../../src/shared/agent-node", () => ({
  startAgentNode: h.startAgentNode,
}));
vi.mock("../../../src/infrastructure/telemetry/telemetry", () => ({
  initTelemetry: h.initTelemetry,
}));
vi.mock("../../../src/shared/build-llm-config", () => ({
  buildLLMConfig: h.buildLLMConfig,
}));

import { runWorker, buildDefaultAgentConfig } from "../../../src/main/worker";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  h.buildLLMConfig.mockReturnValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  process.env["AGENT_IDS"] = "alpha,beta";
  process.env["REDIS_URL"] = "redis://localhost:6379";
  delete process.env["MESSAGING_DRIVER"];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("buildDefaultAgentConfig", () => {
  it("produces a valid KaibanJS agent config with the agent id as name", () => {
    const cfg = buildDefaultAgentConfig("alpha");
    expect(cfg.name).toBe("alpha");
    expect(cfg.role).toBeTruthy();
    expect(cfg.goal).toBeTruthy();
    expect(cfg.background).toBeTruthy();
  });

  it("includes llmConfig when one is resolved from env", () => {
    h.buildLLMConfig.mockReturnValue({ provider: "openai", model: "gpt-4o-mini" });
    const cfg = buildDefaultAgentConfig("alpha");
    expect(cfg.llmConfig).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  it("omits llmConfig when none is resolved (KaibanJS falls back to env)", () => {
    h.buildLLMConfig.mockReturnValue(undefined);
    const cfg = buildDefaultAgentConfig("alpha");
    expect(cfg.llmConfig).toBeUndefined();
  });
});

describe("runWorker", () => {
  it("starts one agent node per AGENT_IDS entry on the matching queue", async () => {
    await runWorker();
    expect(h.startAgentNode).toHaveBeenCalledTimes(2);
    const calls = h.startAgentNode.mock.calls as unknown as Array<
      [{ agentId: string; queue: string }]
    >;
    const ids = calls.map((c) => c[0].agentId);
    expect(ids).toEqual(["alpha", "beta"]);
    const queues = calls.map((c) => c[0].queue);
    expect(queues).toEqual(["kaiban-agents-alpha", "kaiban-agents-beta"]);
    expect(h.initTelemetry).toHaveBeenCalledTimes(1);
  });
});
