/**
 * LLM configuration resolver — shared across all examples.
 *
 * Resolves LLM provider config from environment variables.
 *
 * Priority order:
 *   1. OPENROUTER_API_KEY  → OpenRouter (openai provider + apiBaseUrl override)
 *   2. OPENAI_API_KEY      → Standard OpenAI or custom compatible endpoint
 *                            (optionally with OPENAI_BASE_URL)
 *   3. undefined           → KaibanJS falls back to process.env.OPENAI_API_KEY
 *
 * Environment variables:
 *   OPENROUTER_API_KEY   — OpenRouter key (sk-or-v1-...)
 *   OPENAI_API_KEY       — OpenAI key (sk-...)
 *   OPENAI_BASE_URL      — Custom OpenAI-compatible endpoint base URL
 *   LLM_MODEL            — Model string (default: gpt-4o-mini or openai/gpt-4o-mini for OpenRouter)
 */
import type { KaibanAgentConfig } from "../infrastructure/kaibanjs/kaiban-agent-bridge";

type LLMConfig = KaibanAgentConfig["llmConfig"];

/**
 * Resolves LLM config from environment variables.
 * Returns undefined if no API key is set (KaibanJS falls back to process.env.OPENAI_API_KEY).
 */
export function buildLLMConfig(): LLMConfig | undefined {
  const openrouterKey = process.env["OPENROUTER_API_KEY"];
  if (openrouterKey) {
    return {
      provider: "openai",
      model: process.env["LLM_MODEL"] ?? "openai/gpt-4o-mini",
      apiKey: openrouterKey,
      apiBaseUrl: "https://openrouter.ai/api/v1",
    } as LLMConfig;
  }

  const openaiKey = process.env["OPENAI_API_KEY"];
  if (openaiKey) {
    const config: LLMConfig = {
      provider: "openai",
      model: process.env["LLM_MODEL"] ?? "gpt-4o-mini",
      apiKey: openaiKey,
    };
    const baseUrl = process.env["OPENAI_BASE_URL"];
    if (baseUrl) {
      return { ...config, apiBaseUrl: baseUrl } as LLMConfig;
    }
    return config;
  }

  return undefined;
}
