/**
 * Owned LLM instance — Finding #2 (ADR-014): own the LangChain ChatOpenAI so the
 * actor's AbortSignal reaches `.invoke(input, { signal })`. KaibanJS 0.24.2
 * exposes no AbortSignal on `team.start()`, so abort is plumbed at the LangChain
 * layer by wrapping the model we hand to KaibanJS as `llmInstance`.
 */
import { describe, it, expect, vi } from "vitest";

const invokeSpy = vi.fn();
const streamSpy = vi.fn();

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    fields: Record<string, unknown>,
  ) {
    this.lc_kwargs = fields;
    this.lc_namespace = ["langchain", "chat_models", "openai"];
    this.fields = fields;
    this.invoke = invokeSpy;
    this.stream = streamSpy;
    return this;
  }),
}));

import { ChatOpenAI } from "@langchain/openai";
import { buildOwnedLlm } from "../../../src/infrastructure/kaibanjs/owned-llm";

const ChatOpenAIMock = ChatOpenAI as unknown as ReturnType<typeof vi.fn>;

describe("buildOwnedLlm", () => {
  it("returns undefined for a non-openai provider (cannot own — documented limitation)", () => {
    const llm = buildOwnedLlm(
      { provider: "anthropic", model: "claude-3-haiku", apiKey: "k" },
      new AbortController().signal,
    );
    expect(llm).toBeUndefined();
  });

  it("returns undefined when no llmConfig is given", () => {
    expect(buildOwnedLlm(undefined, new AbortController().signal)).toBeUndefined();
  });

  it("builds a ChatOpenAI for the openai provider with apiKey + model", () => {
    buildOwnedLlm(
      { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test" },
      new AbortController().signal,
    );
    expect(ChatOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o-mini", apiKey: "sk-test" }),
    );
  });

  it("defaults to the openai provider and gpt-4o-mini model when omitted", () => {
    ChatOpenAIMock.mockClear();
    const llm = buildOwnedLlm({ apiKey: "k" }, new AbortController().signal);
    expect(llm).toBeDefined();
    expect(ChatOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o-mini" }),
    );
  });

  it("maps apiBaseUrl → configuration.baseURL (OpenRouter / compatible endpoints)", () => {
    ChatOpenAIMock.mockClear();
    buildOwnedLlm(
      {
        provider: "openai",
        model: "openai/gpt-4o-mini",
        apiKey: "sk-or",
        apiBaseUrl: "https://openrouter.ai/api/v1",
      },
      new AbortController().signal,
    );
    expect(ChatOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: { baseURL: "https://openrouter.ai/api/v1" },
      }),
    );
  });

  it("injects the external signal into invoke() config", async () => {
    invokeSpy.mockClear();
    invokeSpy.mockResolvedValue("ok");
    const controller = new AbortController();
    const llm = buildOwnedLlm(
      { provider: "openai", model: "gpt-4o-mini", apiKey: "k" },
      controller.signal,
    )!;
    await llm.invoke("hello");
    const config = invokeSpy.mock.calls[0][1];
    expect(config.signal).toBe(controller.signal);
  });

  it("preserves a caller-supplied config while still injecting the signal", async () => {
    invokeSpy.mockClear();
    invokeSpy.mockResolvedValue("ok");
    const controller = new AbortController();
    const llm = buildOwnedLlm(
      { provider: "openai", model: "gpt-4o-mini", apiKey: "k" },
      controller.signal,
    )!;
    await llm.invoke("hi", { configurable: { sessionId: "s1" } });
    const config = invokeSpy.mock.calls[0][1];
    expect(config.signal).toBe(controller.signal);
    expect(config.configurable).toEqual({ sessionId: "s1" });
  });

  it("aborts the call if KaibanJS supplies its own signal but ours fires first (combined)", async () => {
    invokeSpy.mockClear();
    invokeSpy.mockResolvedValue("ok");
    const ours = new AbortController();
    const theirs = new AbortController();
    const llm = buildOwnedLlm(
      { provider: "openai", model: "gpt-4o-mini", apiKey: "k" },
      ours.signal,
    )!;
    await llm.invoke("hi", { signal: theirs.signal });
    const config = invokeSpy.mock.calls[0][1];
    // A combined signal is passed; aborting either source aborts it.
    expect(config.signal).toBeInstanceOf(AbortSignal);
    ours.abort();
    expect(config.signal.aborted).toBe(true);
  });

  it("threads the signal into stream() config as well", async () => {
    streamSpy.mockClear();
    streamSpy.mockResolvedValue("stream");
    const controller = new AbortController();
    const llm = buildOwnedLlm(
      { provider: "openai", model: "gpt-4o-mini", apiKey: "k" },
      controller.signal,
    )!;
    await llm.stream("hi");
    const config = streamSpy.mock.calls[0][1];
    expect(config.signal).toBe(controller.signal);
  });
});
