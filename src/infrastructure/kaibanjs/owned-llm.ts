// SPDX-License-Identifier: Apache-2.0
/**
 * Owned LangChain LLM instance — the abort seam for Finding #2 (ADR-014).
 *
 * KaibanJS 0.24.2 exposes no AbortSignal on `team.start()`. The bridge stops the
 * team (`team.stop()`) when the signal aborts, but the agent loop only checks
 * that stop at iteration boundaries, so an in-flight LLM call is not itself
 * cancelled by it. KaibanJS *does* accept a pre-built
 * LangChain model via `Agent({ llmInstance })` and uses it verbatim.
 *
 * So we build the `ChatOpenAI` instance ourselves and wrap its `.invoke` /
 * `.stream` so the per-task `AbortSignal` from the actor is merged into the
 * LangChain `RunnableConfig.signal`. When the actor aborts (timeout / shutdown),
 * the underlying provider request aborts and stops burning tokens.
 *
 * Scope: this project resolves every provider as the OpenAI-compatible
 * `provider: "openai"` (OpenAI / OpenRouter / any OpenAI-compatible base URL —
 * see `build-llm-config.ts`). For any other provider we return `undefined` and
 * the bridge falls back to letting KaibanJS construct the instance (in which
 * case the actor releases the job at once and the bridge stops the team, but an
 * in-flight call only ends at the next agent-loop boundary; see ADR-014).
 */
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

/** The resolved LLM config shape (subset of KaibanJS `LLMConfig` we rely on). */
export interface OwnedLlmConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  apiBaseUrl?: string;
  /** Retries of a failed provider request; unset behaves as in KaibanJS (1). */
  maxRetries?: number;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  n?: number;
  stream?: boolean;
  configuration?: { baseURL: string };
}

/** A LangChain config object that may carry an AbortSignal. */
type RunnableConfigLike = { signal?: AbortSignal } & Record<string, unknown>;

/**
 * Combine the actor's signal with any signal KaibanJS itself passes, so aborting
 * either source aborts the call. `AbortSignal.any` is standard on Node >= 22
 * (this package's declared runtime — see `engines.node`).
 */
function combineSignals(
  external: AbortSignal,
  inner?: AbortSignal,
): AbortSignal {
  return inner ? AbortSignal.any([external, inner]) : external;
}

/**
 * Wrap a LangChain chat model so every `.invoke` / `.stream` call carries the
 * external abort signal. Returns the SAME model instance (KaibanJS reads its
 * `lc_kwargs` / `lc_namespace`, so we mutate in place rather than proxy).
 */
function attachSignal(
  model: BaseChatModel,
  signal: AbortSignal,
): BaseChatModel {
  const m = model as unknown as {
    invoke: (input: unknown, config?: RunnableConfigLike) => unknown;
    stream: (input: unknown, config?: RunnableConfigLike) => unknown;
  };
  const origInvoke = m.invoke.bind(m);
  const origStream = m.stream.bind(m);
  const withSignal = (config?: RunnableConfigLike): RunnableConfigLike => ({
    ...config,
    signal: combineSignals(signal, config?.signal),
  });
  m.invoke = (input: unknown, config?: RunnableConfigLike): unknown =>
    origInvoke(input, withSignal(config));
  m.stream = (input: unknown, config?: RunnableConfigLike): unknown =>
    origStream(input, withSignal(config));
  return model;
}

/**
 * Build an owned, abort-wired `ChatOpenAI` from the resolved LLM config.
 *
 * Returns `undefined` when:
 *  - no config is provided, or
 *  - the provider is not the OpenAI-compatible `"openai"` provider
 *    (the only provider this runtime resolves — see module doc).
 */
export function buildOwnedLlm(
  config: OwnedLlmConfig | undefined,
  signal: AbortSignal,
): BaseChatModel | undefined {
  if (!config) return undefined;
  const provider = config.provider ?? "openai";
  if (provider !== "openai") return undefined;

  // KaibanJS hands the whole llmConfig to its own OpenAI constructor, so pass
  // every field (temperature, topP, penalties, n, …) through, with the same two
  // defaults it applies: model gpt-4o-mini and maxRetries 1 (LangChain's own
  // default would be 6). An empty apiKey is dropped so the environment applies.
  const { apiBaseUrl, apiKey } = config;
  const fields: Record<string, unknown> = {
    ...config,
    model: config.model || "gpt-4o-mini",
    maxRetries: config.maxRetries ?? 1,
  };
  delete fields["provider"];
  delete fields["apiBaseUrl"];
  delete fields["apiKey"];
  if (apiKey) fields["apiKey"] = apiKey;
  // KaibanJS maps apiBaseUrl → configuration.baseURL for the openai provider;
  // mirror that so OpenRouter / OpenAI-compatible endpoints work identically.
  if (apiBaseUrl) {
    fields["configuration"] = { baseURL: apiBaseUrl };
  }

  const model = new ChatOpenAI(fields) as unknown as BaseChatModel;
  return attachSignal(model, signal);
}
