import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  RequestContext,
  ExecutionEventBus,
  AgentExecutionEvent,
} from "@a2a-js/sdk/server";
import type { Message } from "@a2a-js/sdk";

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../../src/shared/structured-logger", () => ({
  createStructuredLogger: (): typeof mockLog => mockLog,
  logger: mockLog,
  resolveLogLevel: (): string => "silent",
}));

import { KaibanAgentExecutor } from "../../../src/infrastructure/federation/a2a-executor";

// ── Fakes ────────────────────────────────────────────────────────────────────

function makeEventBus(): {
  bus: ExecutionEventBus;
  events: AgentExecutionEvent[];
  finished: ReturnType<typeof vi.fn>;
} {
  const events: AgentExecutionEvent[] = [];
  const finished = vi.fn();
  const bus = {
    publish: (e: AgentExecutionEvent) => events.push(e),
    finished,
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
  } as unknown as ExecutionEventBus;
  return { bus, events, finished };
}

function makeContext(
  opts: {
    taskId?: string;
    contextId?: string;
    agentId?: string;
    text?: string;
    metadata?: Record<string, unknown>;
  } = {},
): RequestContext {
  const message: Message = {
    kind: "message",
    role: "user",
    messageId: "m-1",
    parts: opts.text ? [{ kind: "text", text: opts.text }] : [],
    metadata: {
      ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
      ...(opts.metadata ?? {}),
    },
  };
  return {
    userMessage: message,
    taskId: opts.taskId ?? "task-1",
    contextId: opts.contextId ?? "ctx-1",
  } as RequestContext;
}

function makeDeps(
  routerWait: () => Promise<string> = () => Promise.resolve("RESULT"),
): {
  deps: ConstructorParameters<typeof KaibanAgentExecutor>[0];
  publish: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
} {
  const publish = vi.fn().mockResolvedValue(undefined);
  const wait = vi.fn(routerWait);
  const save = vi.fn().mockResolvedValue(undefined);
  return {
    deps: {
      driver: { publish } as never,
      router: { wait } as never,
      taskStore: { save, load: vi.fn() } as never,
      timeoutMs: 1000,
    },
    publish,
    wait,
    save,
  };
}

const states = (events: AgentExecutionEvent[]): string[] =>
  events
    .filter((e) => e.kind === "status-update")
    .map((e) => (e as { status: { state: string } }).status.state);

describe("KaibanAgentExecutor.execute", () => {
  beforeEach(() => vi.clearAllMocks());

  it("publishes the task to kaiban-agents-{id} with a MessagePayload", async () => {
    const { deps, publish } = makeDeps();
    const ex = new KaibanAgentExecutor(deps);
    const { bus } = makeEventBus();
    await ex.execute(
      makeContext({ agentId: "writer", text: "Write a poem" }),
      bus,
    );
    expect(publish).toHaveBeenCalledWith(
      "kaiban-agents-writer",
      expect.objectContaining({
        taskId: "task-1",
        agentId: "writer",
        data: expect.objectContaining({ instruction: "Write a poem" }),
      }),
    );
  });

  it("emits submitted → working → completed and a final event on success", async () => {
    const { deps } = makeDeps(() => Promise.resolve("THE RESULT"));
    const ex = new KaibanAgentExecutor(deps);
    const { bus, events, finished } = makeEventBus();
    await ex.execute(makeContext({ agentId: "writer", text: "go" }), bus);
    expect(states(events)).toEqual(["working", "completed"]);
    // first published event is the initial Task (submitted)
    const first = events[0] as { kind: string; status: { state: string } };
    expect(first.kind).toBe("task");
    expect(first.status.state).toBe("submitted");
    // final status-update carries final=true and the result text
    const last = events.at(-1) as {
      final: boolean;
      status: { message?: { parts: { text: string }[] } };
    };
    expect(last.final).toBe(true);
    expect(last.status.message?.parts[0]?.text).toBe("THE RESULT");
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("emits a completed artifact carrying the result", async () => {
    const { deps } = makeDeps(() => Promise.resolve("ARTIFACT BODY"));
    const ex = new KaibanAgentExecutor(deps);
    const { bus, events } = makeEventBus();
    await ex.execute(makeContext({ agentId: "writer", text: "go" }), bus);
    const artifact = events.find((e) => e.kind === "artifact-update") as {
      artifact: { parts: { text: string }[] };
    };
    expect(artifact.artifact.parts[0]?.text).toBe("ARTIFACT BODY");
  });

  it("persists the task to the store on completion", async () => {
    const { deps, save } = makeDeps();
    const ex = new KaibanAgentExecutor(deps);
    const { bus } = makeEventBus();
    await ex.execute(makeContext({ agentId: "writer", text: "go" }), bus);
    const saved = save.mock.calls.map((c) => c[0].status.state);
    expect(saved).toContain("submitted");
    expect(saved).toContain("completed");
  });

  it("rejects invalid input with a terminal 'rejected' task (never publishes)", async () => {
    const { deps, publish } = makeDeps();
    const ex = new KaibanAgentExecutor(deps);
    const { bus, events, finished } = makeEventBus();
    await ex.execute(makeContext({ agentId: "bad id!", text: "go" }), bus);
    expect(publish).not.toHaveBeenCalled();
    expect(states(events).at(-1)).toBe("rejected");
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("derives the instruction from text parts when metadata has none", async () => {
    const { deps, publish } = makeDeps();
    const ex = new KaibanAgentExecutor(deps);
    const { bus } = makeEventBus();
    await ex.execute(
      makeContext({ agentId: "writer", text: "hello from text" }),
      bus,
    );
    expect(publish.mock.calls[0]?.[1].data.instruction).toBe("hello from text");
  });

  it("forwards expectedOutput / context / inputs from message metadata", async () => {
    const { deps, publish } = makeDeps();
    const ex = new KaibanAgentExecutor(deps);
    const { bus } = makeEventBus();
    await ex.execute(
      makeContext({
        agentId: "writer",
        text: "go",
        metadata: {
          expectedOutput: "an essay",
          context: "background",
          inputs: { tone: "formal" },
        },
      }),
      bus,
    );
    const data = publish.mock.calls[0]?.[1].data as Record<string, unknown>;
    expect(data.expectedOutput).toBe("an essay");
    expect(data.context).toBe("background");
    expect(data.inputs).toEqual({ tone: "formal" });
  });

  it("rejects a message with no metadata at all (missing agentId)", async () => {
    const { deps } = makeDeps();
    const ex = new KaibanAgentExecutor(deps);
    const { bus, events } = makeEventBus();
    const ctx = {
      userMessage: {
        kind: "message",
        role: "user",
        messageId: "m-x",
        parts: [{ kind: "text", text: "hi" }],
      },
      taskId: "no-meta",
      contextId: "ctx-x",
    } as unknown as RequestContext;
    await ex.execute(ctx, bus);
    expect(states(events).at(-1)).toBe("rejected");
  });

  it("rejects when there is neither instruction metadata nor text parts", async () => {
    const { deps, publish } = makeDeps();
    const ex = new KaibanAgentExecutor(deps);
    const { bus } = makeEventBus();
    // Empty instruction is allowed by validation (optional), so this still
    // publishes — but with no instruction field present.
    await ex.execute(makeContext({ agentId: "writer" }), bus);
    const data = publish.mock.calls[0]?.[1].data as Record<string, unknown>;
    expect(data.instruction).toBeUndefined();
  });

  it("prefers explicit instruction metadata over text parts", async () => {
    const { deps, publish } = makeDeps();
    const ex = new KaibanAgentExecutor(deps);
    const { bus } = makeEventBus();
    await ex.execute(
      makeContext({
        agentId: "writer",
        text: "text body",
        metadata: { instruction: "explicit" },
      }),
      bus,
    );
    expect(publish.mock.calls[0]?.[1].data.instruction).toBe("explicit");
  });

  it("emits a terminal 'failed' status when the task fails", async () => {
    const { deps } = makeDeps(() => Promise.reject(new Error("boom")));
    const ex = new KaibanAgentExecutor(deps);
    const { bus, events, finished } = makeEventBus();
    await ex.execute(makeContext({ agentId: "writer", text: "go" }), bus);
    expect(states(events).at(-1)).toBe("failed");
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("logs the error server-side on failure (observability) without leaking it to the wire", async () => {
    mockLog.warn.mockClear();
    const err = new Error("internal stacktrace path");
    const { deps } = makeDeps(() => Promise.reject(err));
    const ex = new KaibanAgentExecutor(deps);
    const { bus, events } = makeEventBus();
    await ex.execute(makeContext({ agentId: "writer", text: "go" }), bus);
    // Server-side log carries the real error...
    expect(mockLog.warn).toHaveBeenCalledWith(
      { err },
      "A2A execute failed",
    );
    // ...but the wire terminal message stays generic.
    const last = events.at(-1) as {
      status: { message?: { parts: { text: string }[] } };
    };
    expect(last.status.message?.parts[0]?.text).toBe("Task execution failed");
    expect(last.status.message?.parts[0]?.text).not.toContain("stacktrace");
  });

  it("does not leak internal error detail into the failed message", async () => {
    const { deps } = makeDeps(() =>
      Promise.reject(new Error("secret stacktrace path")),
    );
    const ex = new KaibanAgentExecutor(deps);
    const { bus, events } = makeEventBus();
    await ex.execute(makeContext({ agentId: "writer", text: "go" }), bus);
    const last = events.at(-1) as {
      status: { message?: { parts: { text: string }[] } };
    };
    expect(last.status.message?.parts[0]?.text).not.toContain("secret");
  });

  it("is idempotent: a duplicate execute for an in-flight taskId does not double-publish", async () => {
    let resolve: ((v: string) => void) | undefined;
    const { deps, publish } = makeDeps(
      () => new Promise<string>((r) => (resolve = r)),
    );
    const ex = new KaibanAgentExecutor(deps);
    const first = ex.execute(
      makeContext({ taskId: "dup", agentId: "writer", text: "go" }),
      makeEventBus().bus,
    );
    // Wait until the first execute has reached router.wait() and is in-flight.
    await vi.waitFor(() => expect(resolve).toBeDefined());
    await ex.execute(
      makeContext({ taskId: "dup", agentId: "writer", text: "go" }),
      makeEventBus().bus,
    );
    resolve?.("done");
    await first;
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe("KaibanAgentExecutor.cancelTask", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits a final 'canceled' status update", async () => {
    const { deps } = makeDeps();
    const ex = new KaibanAgentExecutor(deps);
    const { bus, events, finished } = makeEventBus();
    await ex.cancelTask("task-9", bus);
    const last = events.at(-1) as { final: boolean; status: { state: string } };
    expect(last.status.state).toBe("canceled");
    expect(last.final).toBe(true);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("persists the canceled task to the store", async () => {
    const { deps, save } = makeDeps();
    const ex = new KaibanAgentExecutor(deps);
    const { bus } = makeEventBus();
    await ex.cancelTask("task-9", bus);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "task-9",
        status: expect.objectContaining({ state: "canceled" }),
      }),
    );
  });

  it("aborts an in-flight task so it can stop work", async () => {
    let captured: AbortSignal | undefined;
    const wait = vi.fn(
      (_id: string, _ms: number, _label: string, signal?: AbortSignal) => {
        captured = signal;
        return new Promise<string>((_res, rej) => {
          signal?.addEventListener("abort", () => rej(new Error("aborted")));
        });
      },
    );
    const publish = vi.fn().mockResolvedValue(undefined);
    const save = vi.fn().mockResolvedValue(undefined);
    const ex = new KaibanAgentExecutor({
      driver: { publish } as never,
      router: { wait } as never,
      taskStore: { save, load: vi.fn() } as never,
      timeoutMs: 1000,
    });
    const { bus } = makeEventBus();
    const running = ex.execute(
      makeContext({ taskId: "cancelme", agentId: "writer", text: "go" }),
      bus,
    );
    // Let execute() reach router.wait() (where the abort signal is registered).
    await vi.waitFor(() => expect(captured).toBeDefined());
    await ex.cancelTask("cancelme", makeEventBus().bus);
    expect(captured?.aborted).toBe(true);
    await running; // should settle without throwing
  });
});
