import { describe, it, expect } from "vitest";
import * as SharedAPI from "../../../src/shared";

describe("src/shared barrel exports", () => {
  it("exports all public symbols", () => {
    expect(typeof SharedAPI.createLogger).toBe("function");
    expect(typeof SharedAPI.getDriverType).toBe("function");
    expect(typeof SharedAPI.createDriver).toBe("function");
    expect(typeof SharedAPI.getBoolEnv).toBe("function");
    expect(typeof SharedAPI.buildSecurityDeps).toBe("function");
    expect(typeof SharedAPI.buildLLMConfig).toBe("function");
    expect(typeof SharedAPI.parseHandlerResult).toBe("function");
    expect(typeof SharedAPI.parseRecommendation).toBe("function");
    expect(typeof SharedAPI.parseScore).toBe("function");
    expect(typeof SharedAPI.normaliseEditorialText).toBe("function");
    expect(typeof SharedAPI.CompletionRouter).toBe("function");
    expect(typeof SharedAPI.createRpcClient).toBe("function");
    expect(typeof SharedAPI.waitForHITLDecision).toBe("function");
    expect(typeof SharedAPI.OrchestratorStatePublisher).toBe("function");
    expect(typeof SharedAPI.startAgentNode).toBe("function");
  });
});
