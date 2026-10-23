/**
 * KaibanJS bridge — Finding #2 (ADR-014): when the actor passes an AbortSignal,
 * the bridge builds an OWNED LangChain LLM and hands it to the Agent as
 * `llmInstance`, so the signal reaches the underlying `.invoke(input,{signal})`.
 *
 * Verifies:
 *   - the Agent is constructed with an `llmInstance` when a signal + openai
 *     llmConfig are present
 *   - the owned instance carries the actor's signal (aborting it aborts invoke)
 *   - with no signal (legacy direct call) NO llmInstance is injected — KaibanJS
 *     builds its own from env (unchanged behavior)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeSpy, AgentMock, mockTeamStart, mockTeamStop } = vi.hoisted(
  () => ({
    mockTeamStop: vi.fn().mockResolvedValue(undefined),
    invokeSpy: vi.fn().mockResolvedValue("ok"),
    AgentMock: vi.fn().mockImplementation(function (
      this: Record<string, unknown>,
      params: Record<string, unknown>,
    ) {
      this.params = params;
      return this;
    }),
    mockTeamStart: vi
      .fn()
      .mockResolvedValue({ status: "FINISHED", result: "done", stats: null }),
  }),
);

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    fields: Record<string, unknown>,
  ) {
    this.lc_kwargs = fields;
    this.lc_namespace = ["langchain", "chat_models", "openai"];
    this.invoke = invokeSpy;
    this.stream = vi.fn();
    return this;
  }),
}));

vi.mock("kaibanjs", () => ({
  Agent: AgentMock,
  Task: vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    params: Record<string, unknown>,
  ) {
    Object.assign(this, params);
    return this;
  }),
  Team: vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    params: Record<string, unknown>,
  ) {
    this.start = mockTeamStart;
    this.stop = mockTeamStop;
    Object.assign(this, params);
    return this;
  }),
}));

import { createKaibanTaskHandler } from "../../../src/infrastructure/kaibanjs/kaiban-agent-bridge";
import type {
  IMessagingDriver,
  MessagePayload,
} from "../../../src/infrastructure/messaging/interfaces";

function makeMockDriver(): IMessagingDriver {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

const payload: MessagePayload = {
  taskId: "t1",
  agentId: "researcher",
  timestamp: 0,
  data: {},
};

const openaiConfig = {
  name: "Ava",
  role: "R",
  goal: "G",
  background: "B",
  llmConfig: { provider: "openai" as const, model: "gpt-4o-mini" },
};

describe("createKaibanTaskHandler — owned LLM + AbortSignal", () => {
  beforeEach(() => {
    AgentMock.mockClear();
    invokeSpy.mockClear();
    mockTeamStop.mockReset().mockResolvedValue(undefined);
    mockTeamStart.mockReset().mockResolvedValue({
      status: "FINISHED",
      result: "done",
      stats: null,
    });
  });

  it("injects an llmInstance when a signal and openai config are present", async () => {
    const h = createKaibanTaskHandler(openaiConfig, makeMockDriver());
    await h(payload, new AbortController().signal);
    const agentArgs = AgentMock.mock.calls[0][0];
    expect(agentArgs.llmInstance).toBeDefined();
  });

  it("the owned instance carries the actor signal (abort reaches invoke)", async () => {
    const h = createKaibanTaskHandler(openaiConfig, makeMockDriver());
    const controller = new AbortController();
    await h(payload, controller.signal);
    const agentArgs = AgentMock.mock.calls[0][0];
    // Driving the owned model's invoke threads the actor's signal into config.
    await agentArgs.llmInstance.invoke("hi");
    expect(invokeSpy.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("does NOT inject an llmInstance when no signal is passed (legacy path)", async () => {
    const h = createKaibanTaskHandler(openaiConfig, makeMockDriver());
    await h(payload);
    const agentArgs = AgentMock.mock.calls[0][0];
    expect(agentArgs.llmInstance).toBeUndefined();
  });

  it("does NOT inject an llmInstance for a non-openai provider (documented limitation)", async () => {
    const h = createKaibanTaskHandler(
      {
        ...openaiConfig,
        llmConfig: { provider: "anthropic" as const, model: "claude-3-haiku" },
      },
      makeMockDriver(),
    );
    await h(payload, new AbortController().signal);
    const agentArgs = AgentMock.mock.calls[0][0];
    expect(agentArgs.llmInstance).toBeUndefined();
  });
});

describe("createKaibanTaskHandler — team.stop() on abort", () => {
  beforeEach(() => {
    AgentMock.mockClear();
    mockTeamStop.mockReset().mockResolvedValue(undefined);
    mockTeamStart.mockReset();
  });

  const hang = (): void => {
    mockTeamStart.mockReturnValue(new Promise(() => {}));
  };

  it("throws the reason and builds nothing when already aborted", async () => {
    const reason = new Error("pre-aborted");
    const controller = new AbortController();
    controller.abort(reason);
    const h = createKaibanTaskHandler(openaiConfig, makeMockDriver());
    await expect(h(payload, controller.signal)).rejects.toBe(reason);
    expect(AgentMock).not.toHaveBeenCalled();
    expect(mockTeamStart).not.toHaveBeenCalled();
    expect(mockTeamStop).not.toHaveBeenCalled();
  });

  it.each(["task_timeout", "actor_stopped"])(
    "stops the team and rejects with the %s reason on a mid-run abort",
    async (code) => {
      hang();
      const reason = new Error(code);
      const controller = new AbortController();
      const h = createKaibanTaskHandler(openaiConfig, makeMockDriver());
      const run = h(payload, controller.signal);
      await vi.waitFor(() => expect(mockTeamStart).toHaveBeenCalled());
      controller.abort(reason);
      await expect(run).rejects.toBe(reason);
      expect(mockTeamStop).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores a rejecting team.stop()", async () => {
    hang();
    mockTeamStop.mockRejectedValue(new Error("not running"));
    const reason = new Error("timeout");
    const controller = new AbortController();
    const h = createKaibanTaskHandler(openaiConfig, makeMockDriver());
    const run = h(payload, controller.signal);
    await vi.waitFor(() => expect(mockTeamStart).toHaveBeenCalled());
    controller.abort(reason);
    await expect(run).rejects.toBe(reason);
    expect(mockTeamStop).toHaveBeenCalledTimes(1);
  });

  it("does not stop the team after a normal completion (listener removed)", async () => {
    mockTeamStart.mockResolvedValue({
      status: "FINISHED",
      result: "done",
      stats: null,
    });
    const controller = new AbortController();
    const h = createKaibanTaskHandler(openaiConfig, makeMockDriver());
    await h(payload, controller.signal);
    controller.abort(new Error("late"));
    expect(mockTeamStop).not.toHaveBeenCalled();
  });

  it("does not leave an unhandled rejection when start() rejects after the abort", async () => {
    let rejectStart!: (e: Error) => void;
    mockTeamStart.mockReturnValue(
      new Promise((_, rej) => {
        rejectStart = rej;
      }),
    );
    const reason = new Error("timeout");
    const controller = new AbortController();
    const h = createKaibanTaskHandler(openaiConfig, makeMockDriver());
    const run = h(payload, controller.signal);
    await vi.waitFor(() => expect(mockTeamStart).toHaveBeenCalled());
    controller.abort(reason);
    await expect(run).rejects.toBe(reason);
    rejectStart(new Error("late LLM abort"));
    await Promise.resolve();
  });

  it("aborts between token fetch and team build when the signal fires during buildEnv", async () => {
    const reason = new Error("during-env");
    const controller = new AbortController();
    const tokenProvider = {
      getToken: vi.fn().mockImplementation(async () => {
        controller.abort(reason);
        return "k";
      }),
    };
    const h = createKaibanTaskHandler(
      openaiConfig,
      makeMockDriver(),
      tokenProvider as never,
    );
    await expect(h(payload, controller.signal)).rejects.toBe(reason);
    expect(AgentMock).not.toHaveBeenCalled();
  });
});
