import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildLLMConfig } from "../../../src/shared";

describe("buildLLMConfig", () => {
  beforeEach(() => {
    delete process.env["OPENROUTER_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    delete process.env["OPENAI_BASE_URL"];
    delete process.env["LLM_MODEL"];
  });

  afterEach(() => {
    delete process.env["OPENROUTER_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    delete process.env["OPENAI_BASE_URL"];
    delete process.env["LLM_MODEL"];
  });

  it("returns undefined when no API key env vars are set", () => {
    expect(buildLLMConfig()).toBeUndefined();
  });

  it("uses OPENROUTER_API_KEY with openrouter base URL and default model", () => {
    process.env["OPENROUTER_API_KEY"] = "sk-or-v1-test";
    const config = buildLLMConfig();
    expect(config).toBeDefined();
    expect((config as Record<string, unknown>)["provider"]).toBe("openai");
    expect((config as Record<string, unknown>)["apiKey"]).toBe("sk-or-v1-test");
    expect((config as Record<string, unknown>)["apiBaseUrl"]).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect((config as Record<string, unknown>)["model"]).toBe(
      "openai/gpt-4o-mini",
    );
  });

  it("uses custom LLM_MODEL with OPENROUTER_API_KEY", () => {
    process.env["OPENROUTER_API_KEY"] = "sk-or-v1-test";
    process.env["LLM_MODEL"] = "openai/gpt-4o";
    const config = buildLLMConfig();
    expect((config as Record<string, unknown>)["model"]).toBe("openai/gpt-4o");
  });

  it("uses OPENAI_API_KEY with default model when no OPENAI_BASE_URL", () => {
    process.env["OPENAI_API_KEY"] = "sk-openai-test";
    const config = buildLLMConfig();
    expect(config).toBeDefined();
    expect((config as Record<string, unknown>)["provider"]).toBe("openai");
    expect((config as Record<string, unknown>)["apiKey"]).toBe(
      "sk-openai-test",
    );
    expect((config as Record<string, unknown>)["model"]).toBe("gpt-4o-mini");
    expect((config as Record<string, unknown>)["apiBaseUrl"]).toBeUndefined();
  });

  it("includes OPENAI_BASE_URL when set alongside OPENAI_API_KEY", () => {
    process.env["OPENAI_API_KEY"] = "sk-openai-test";
    process.env["OPENAI_BASE_URL"] = "https://my-proxy.example.com/v1";
    const config = buildLLMConfig();
    expect((config as Record<string, unknown>)["apiBaseUrl"]).toBe(
      "https://my-proxy.example.com/v1",
    );
  });

  it("uses custom LLM_MODEL with OPENAI_API_KEY", () => {
    process.env["OPENAI_API_KEY"] = "sk-openai-test";
    process.env["LLM_MODEL"] = "gpt-4-turbo";
    const config = buildLLMConfig();
    expect((config as Record<string, unknown>)["model"]).toBe("gpt-4-turbo");
  });

  it("OPENROUTER_API_KEY takes priority over OPENAI_API_KEY", () => {
    process.env["OPENROUTER_API_KEY"] = "sk-or-v1-test";
    process.env["OPENAI_API_KEY"] = "sk-openai-test";
    const config = buildLLMConfig();
    expect((config as Record<string, unknown>)["apiKey"]).toBe("sk-or-v1-test");
    expect((config as Record<string, unknown>)["apiBaseUrl"]).toBe(
      "https://openrouter.ai/api/v1",
    );
  });
});
