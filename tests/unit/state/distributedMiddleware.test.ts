import { describe, it, expect, vi } from "vitest";

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

import { DistributedStateMiddleware, toBoardDelta } from "../../../src/adapters/state/distributedMiddleware";
import { Agent, Task, Team } from "kaibanjs";

const mockRedis = {
  publish: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn(),
  quit: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  options: {},
};

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    return mockRedis;
  }),
}));

type State = Record<string, unknown>;
type Listener = (state: State, prev: State) => void;

/** A minimal Zustand-style store: `set` notifies subscribers with (state, prev). */
function makeStore(initial: State = {}): {
  set: (partial: State) => void;
  subscribe: (l: Listener) => () => void;
  listeners: Set<Listener>;
} {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    listeners,
    set(partial: State): void {
      const prev = state;
      state = { ...state, ...partial };
      listeners.forEach((l) => l(state, prev));
    },
    subscribe(l: Listener): () => void {
      listeners.add(l);
      return (): void => {
        listeners.delete(l);
      };
    },
  };
}

function published(): Record<string, unknown> {
  return JSON.parse(mockRedis.publish.mock.calls.at(-1)![1] as string);
}

describe("toBoardDelta", () => {
  it("returns only the parts that changed", () => {
    const agents = [{ id: "a1", name: "Kai", role: "writer", status: "THINKING" }];
    expect(toBoardDelta({ teamWorkflowStatus: "RUNNING", agents }, { agents })).toEqual({
      teamWorkflowStatus: "RUNNING",
    });
    expect(toBoardDelta({ agents }, { agents })).toEqual({});
  });

  it("maps agents to the board shape and KaibanJS statuses to the board's four", () => {
    const statuses: Array<[string, string]> = [
      ["INITIAL", "IDLE"], ["THINKING", "THINKING"], ["THINKING_END", "IDLE"],
      ["EXECUTING_ACTION", "EXECUTING"], ["USING_TOOL", "EXECUTING"],
      ["ISSUES_PARSING_LLM_OUTPUT", "ERROR"], ["AGENTIC_LOOP_ERROR", "ERROR"], ["FINAL_ANSWER", "IDLE"],
    ];
    for (const [from, to] of statuses) {
      const d = toBoardDelta({ agents: [{ id: "a", name: "N", role: "R", status: from }] }, {});
      expect(d["agents"]).toEqual([{ agentId: "a", name: "N", role: "R", status: to, currentTaskId: null }]);
    }
  });

  it("skips agents and tasks without a string id, and fills missing names", () => {
    const d = toBoardDelta({ agents: [{ id: 1 }, { id: "a" }], tasks: [{ title: "x" }, { id: "t" }] }, {});
    expect(d["agents"]).toEqual([{ agentId: "a", name: "a", role: "", status: "IDLE", currentTaskId: null }]);
    expect(d["tasks"]).toEqual([{ taskId: "t", title: "t", status: "TODO", assignedToAgentId: "" }]);
  });

  it("maps tasks: statuses, assignee and result (object results are stringified and bounded)", () => {
    const tasks = [
      { id: "t1", title: "Write", status: "VALIDATED", result: "done", agent: { id: "a1" } },
      { id: "t2", title: "Fix", status: "REVISE", result: { k: 1 } },
      { id: "t3", title: "Big", status: "DOING", result: "x".repeat(30_000) },
      { id: "t4", title: "Weird", status: "PAUSED", result: null },
    ];
    const out = toBoardDelta({ tasks }, {})["tasks"] as Array<Record<string, unknown>>;
    expect(out[0]).toMatchObject({ taskId: "t1", status: "DONE", assignedToAgentId: "a1", result: "done" });
    expect(out[1]).toMatchObject({ status: "DOING", result: '{"k":1}' });
    expect((out[2]!["result"] as string).length).toBe(20_000);
    expect(out[3]).not.toHaveProperty("result");
    expect(out[3]).toMatchObject({ status: "TODO" });
  });

  it("ignores non-array agents/tasks and an undefined workflow status", () => {
    expect(toBoardDelta({ agents: "x" as never, tasks: undefined }, {})).toEqual({});
  });
});

describe("DistributedStateMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["CHANNEL_SIGNING_SECRET"];
  });

  it("publishes a board delta for every store change (not the old stateUpdate wrapper)", () => {
    const mw = new DistributedStateMiddleware("redis://localhost");
    const store = makeStore();
    expect(mw.attach(store)).toBe(store);
    store.set({ teamWorkflowStatus: "RUNNING" });
    expect(mockRedis.publish).toHaveBeenCalledWith("kaiban-state-events", expect.any(String));
    expect(published()).toEqual({ teamWorkflowStatus: "RUNNING" });
  });

  it("does not publish a change that has nothing for the board", () => {
    const mw = new DistributedStateMiddleware("redis://localhost");
    const store = makeStore();
    mw.attach(store);
    store.set({ inputs: { a: 1 } });
    expect(mockRedis.publish).not.toHaveBeenCalled();
  });

  it("signs the delta when CHANNEL_SIGNING_SECRET is set", () => {
    process.env["CHANNEL_SIGNING_SECRET"] = "s3cret-s3cret-s3cret-s3cret";
    const mw = new DistributedStateMiddleware("redis://localhost");
    const store = makeStore();
    mw.attach(store);
    store.set({ teamWorkflowStatus: "FINISHED" });
    const env = published();
    expect(env["sig"]).toEqual(expect.any(String));
    expect(env["payload"]).toEqual({ teamWorkflowStatus: "FINISHED" });
  });

  it("publish error is caught and logged without throwing", async () => {
    mockRedis.publish.mockRejectedValueOnce(new Error("redis down"));
    const mw = new DistributedStateMiddleware("redis://localhost");
    const store = makeStore();
    mw.attach(store);
    expect(() => store.set({ teamWorkflowStatus: "RUNNING" })).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(mockLog.error).toHaveBeenCalled();
  });

  it("streams a REAL KaibanJS team's store actions (WF-01 regression)", () => {
    process.env["KAIBAN_TELEMETRY_OPT_OUT"] = "1";
    const agent = new Agent({
      name: "Kai", role: "writer", goal: "g", background: "b",
      llmConfig: { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-fake" },
    });
    const task = new Task({ description: "d", expectedOutput: "o", agent });
    const team = new Team({ name: "t", agents: [agent], tasks: [task], env: { OPENAI_API_KEY: "sk-fake" } });
    const mw = new DistributedStateMiddleware("redis://localhost");
    mw.attach(team.getStore() as never);
    team.getStore().getState().setTeamWorkflowStatus("RUNNING" as never);
    expect(published()).toEqual({ teamWorkflowStatus: "RUNNING" });
  });

  it("listen() delivers board deltas via the callback", async () => {
    let capturedHandler!: (channel: string, message: string) => void;
    mockRedis.on.mockImplementation((event, handler) => {
      if (event === "message") capturedHandler = handler;
    });
    const mw = new DistributedStateMiddleware("redis://localhost");
    const onStateChange = vi.fn();
    await mw.listen(onStateChange);
    expect(mockRedis.subscribe).toHaveBeenCalledWith("kaiban-state-events");
    capturedHandler("kaiban-state-events", JSON.stringify({ teamWorkflowStatus: "RUNNING" }));
    expect(onStateChange).toHaveBeenCalledWith({ teamWorkflowStatus: "RUNNING" });
  });

  it("listen() verifies the signature and rejects a forged envelope", async () => {
    process.env["CHANNEL_SIGNING_SECRET"] = "s3cret-s3cret-s3cret-s3cret";
    let capturedHandler!: (channel: string, message: string) => void;
    mockRedis.on.mockImplementation((event, handler) => {
      if (event === "message") capturedHandler = handler;
    });
    const mw = new DistributedStateMiddleware("redis://localhost");
    const onStateChange = vi.fn();
    await mw.listen(onStateChange);
    capturedHandler("kaiban-state-events", JSON.stringify({ payload: { a: 1 }, sig: "00", ts: Date.now() }));
    expect(onStateChange).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalled();
  });

  it("listen() ignores messages from other channels", async () => {
    let capturedHandler!: (channel: string, message: string) => void;
    mockRedis.on.mockImplementation((event, handler) => {
      if (event === "message") capturedHandler = handler;
    });
    const mw = new DistributedStateMiddleware("redis://localhost");
    const onStateChange = vi.fn();
    await mw.listen(onStateChange);
    capturedHandler("some-other-channel", JSON.stringify({ x: 1 }));
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("listen() logs an error on an unparsable message", async () => {
    let capturedHandler!: (channel: string, message: string) => void;
    mockRedis.on.mockImplementation((event, handler) => {
      if (event === "message") capturedHandler = handler;
    });
    const mw = new DistributedStateMiddleware("redis://localhost");
    const onStateChange = vi.fn();
    await mw.listen(onStateChange);
    capturedHandler("kaiban-state-events", "invalid json");
    expect(onStateChange).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalled();
  });

  it("disconnect() unsubscribes from the store and quits the publisher and the listen() subscriber", async () => {
    const mw = new DistributedStateMiddleware("redis://localhost");
    const store = makeStore();
    mw.attach(store);
    await mw.listen(vi.fn());
    await mw.disconnect();
    expect(store.listeners.size).toBe(0);
    expect(mockRedis.quit).toHaveBeenCalledTimes(2);
  });

  it("disconnect() without listen() quits only the publisher", async () => {
    const mw = new DistributedStateMiddleware("redis://localhost");
    await mw.disconnect();
    expect(mockRedis.quit).toHaveBeenCalledTimes(1);
  });
});
