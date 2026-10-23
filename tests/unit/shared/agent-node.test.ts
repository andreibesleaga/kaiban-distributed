import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

const mockFlushTelemetry = vi.hoisted(() => vi.fn());
vi.mock("../../../src/infrastructure/telemetry/telemetry-shutdown", () => ({
  shutdownTelemetry: mockFlushTelemetry,
  deferTelemetryShutdown: vi.fn(),
}));

import { startAgentNode, createAgentStatePublisher } from "../../../src/shared";
import { resetProcessDrain } from "../../../src/shared/process-drain";
import { AgentActor } from "../../../src/application/actor/AgentActor";

// ── Mock all heavy dependencies ──────────────────────────────────────────────

const {
  mockActorStart,
  mockActorStop,
  mockActorInstance,
  mockHandlerFn,
  mockPublishIdle,
  mockStateDisconnect,
  mockStatePublisherInstance,
  mockDriverDisconnect,
  mockDriverInstance,
} = vi.hoisted(() => {
  const mockActorStart = vi.fn().mockResolvedValue(undefined);
  const mockActorStop = vi.fn().mockResolvedValue(undefined);
  const mockActorInstance = { start: mockActorStart, stop: mockActorStop };

  const mockHandlerFn = vi.fn();

  const mockPublishIdle = vi.fn();
  const mockWrapHandler = vi.fn().mockReturnValue(mockHandlerFn);
  const mockStateDisconnect = vi.fn().mockResolvedValue(undefined);
  const mockStatePublisherInstance = {
    publishIdle: mockPublishIdle,
    wrapHandler: mockWrapHandler,
    disconnect: mockStateDisconnect,
  };

  const mockDriverDisconnect = vi.fn().mockResolvedValue(undefined);
  const mockDriverInstance = {
    publish: vi.fn(),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: mockDriverDisconnect,
  };

  return {
    mockActorStart,
    mockActorStop,
    mockActorInstance,
    mockHandlerFn,
    mockPublishIdle,
    mockWrapHandler,
    mockStateDisconnect,
    mockStatePublisherInstance,
    mockDriverDisconnect,
    mockDriverInstance,
  };
});

vi.mock("../../../src/application/actor/AgentActor", () => ({
  AgentActor: vi.fn().mockImplementation(function () {
    return mockActorInstance;
  }),
}));

vi.mock("../../../src/infrastructure/kaibanjs/kaiban-agent-bridge", () => ({
  createKaibanTaskHandler: vi.fn().mockReturnValue(mockHandlerFn),
}));

vi.mock("../../../src/adapters/state/agent-state-publisher", () => ({
  AgentStatePublisher: vi.fn().mockImplementation(function () {
    return mockStatePublisherInstance;
  }),
}));

vi.mock("../../../src/shared/driver-factory", () => ({
  createDriver: vi.fn().mockReturnValue(mockDriverInstance),
}));

vi.mock("../../../src/shared/build-security-deps", () => ({
  buildSecurityDeps: vi.fn().mockReturnValue({
    actorDeps: {},
    tokenProvider: undefined,
  }),
}));

describe("startAgentNode", () => {
  const baseConfig = {
    agentId: "researcher",
    queue: "kaiban-agents-researcher",
    agentConfig: {
      name: "Ava",
      role: "Researcher",
      goal: "Research",
      background: "Expert",
    },
    displayName: "Ava",
    role: "News Researcher",
    label: "[Researcher]",
  };

  let sigTermListeners: Array<() => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetProcessDrain();
    // Capture SIGTERM listeners so we can invoke them
    sigTermListeners = [];
    vi.spyOn(process, "on").mockImplementation((event, handler) => {
      if (event === "SIGTERM") sigTermListeners.push(handler as () => void);
      return process;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sigTermListeners = [];
  });

  it("calls actor.start() and publishIdle() on startup", async () => {
    await startAgentNode(baseConfig);
    expect(mockActorStart).toHaveBeenCalled();
    expect(mockPublishIdle).toHaveBeenCalled();
  });

  it("logs a startup message with displayName and queue", async () => {
    await startAgentNode(baseConfig);
    expect(JSON.stringify(mockLog.info.mock.calls)).toContain("Ava");
  });

  it("creates driver with agentId as suffix", async () => {
    const { createDriver } = await import("../../../src/shared/driver-factory");
    await startAgentNode(baseConfig);
    expect(createDriver).toHaveBeenCalledWith("researcher");
  });

  it("creates AgentStatePublisher with agentId, displayName and role", async () => {
    const { AgentStatePublisher } =
      await import("../../../src/adapters/state/agent-state-publisher");
    await startAgentNode(baseConfig);
    expect(AgentStatePublisher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        agentId: "researcher",
        name: "Ava",
        role: "News Researcher",
      }),
      expect.any(Object),
    );
  });

  it("uses config.redisUrl when explicitly provided", async () => {
    const { AgentStatePublisher } =
      await import("../../../src/adapters/state/agent-state-publisher");
    vi.clearAllMocks();
    await startAgentNode({
      ...baseConfig,
      redisUrl: "redis://custom:6380",
    });
    expect(AgentStatePublisher).toHaveBeenCalledWith(
      "redis://custom:6380",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("falls back to REDIS_URL env var when redisUrl not provided", async () => {
    process.env["REDIS_URL"] = "redis://envhost:6379";
    const { AgentStatePublisher } =
      await import("../../../src/adapters/state/agent-state-publisher");
    vi.clearAllMocks();
    await startAgentNode(baseConfig);
    expect(AgentStatePublisher).toHaveBeenCalledWith(
      "redis://envhost:6379",
      expect.any(Object),
      expect.any(Object),
    );
    delete process.env["REDIS_URL"];
  });

  it("forwards MAX_TOKEN_BUDGET env to the AgentStatePublisher", async () => {
    process.env["MAX_TOKEN_BUDGET"] = "50000";
    const { AgentStatePublisher } =
      await import("../../../src/adapters/state/agent-state-publisher");
    vi.clearAllMocks();
    await startAgentNode(baseConfig);
    expect(AgentStatePublisher).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ maxTokenBudget: 50000 }),
    );
    delete process.env["MAX_TOKEN_BUDGET"];
  });

  it("registers SIGTERM handler", async () => {
    await startAgentNode(baseConfig);
    expect(process.on).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  it("SIGTERM handler stops actor, disconnects driver and state publisher, then exits", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        (_code?: number | string | null) => undefined as never,
      );

    await startAgentNode(baseConfig);

    expect(sigTermListeners.length).toBeGreaterThan(0);
    // Trigger SIGTERM
    sigTermListeners[0]!();
    // Wait for async cleanup
    await new Promise((r) => setTimeout(r, 10));

    expect(mockActorStop).toHaveBeenCalled();
    expect(mockDriverDisconnect).toHaveBeenCalled();
    expect(mockStateDisconnect).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it("SIGTERM handler exits non-zero when a drain step fails", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        (_code?: number | string | null) => undefined as never,
      );
    mockActorStop.mockRejectedValueOnce(new Error("actor stop failed"));

    await startAgentNode(baseConfig);
    sigTermListeners[0]!();
    await new Promise((r) => setTimeout(r, 10));

    // The drain continued best-effort, but the failed step → non-zero exit.
    expect(mockDriverDisconnect).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe("createAgentStatePublisher — the shared, capped publisher for custom worker entry points", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes both resolved token caps (defaults 200 000 / 50 000 when unset)", async () => {
    const { AgentStatePublisher } =
      await import("../../../src/adapters/state/agent-state-publisher");
    const info = {
      agentId: "searcher-2",
      name: "Zara-2",
      role: "Web Research Specialist",
    };
    const publisher = createAgentStatePublisher("redis://r:6379", info, {});
    expect(publisher).toBe(mockStatePublisherInstance);
    expect(AgentStatePublisher).toHaveBeenCalledWith("redis://r:6379", info, {
      maxTokenBudget: 200_000,
      maxTaskTokenBudget: 50_000,
    });
  });

  it("reads MAX_TOKEN_BUDGET / MAX_TASK_TOKEN_BUDGET (process.env by default; `unlimited` removes a cap)", async () => {
    const { AgentStatePublisher } =
      await import("../../../src/adapters/state/agent-state-publisher");
    const info = { agentId: "a", name: "A", role: "R" };
    process.env["MAX_TOKEN_BUDGET"] = "unlimited";
    process.env["MAX_TASK_TOKEN_BUDGET"] = "1234";
    try {
      createAgentStatePublisher("redis://r", info);
    } finally {
      delete process.env["MAX_TOKEN_BUDGET"];
      delete process.env["MAX_TASK_TOKEN_BUDGET"];
    }
    expect(AgentStatePublisher).toHaveBeenCalledWith("redis://r", info, {
      maxTokenBudget: Number.POSITIVE_INFINITY,
      maxTaskTokenBudget: 1234,
    });
  });
});

describe("startAgentNode — 2.0.1: timeout and signals", () => {
  const cfg = {
    agentId: "researcher",
    queue: "kaiban-agents-researcher",
    agentConfig: {
      name: "Ava",
      role: "Researcher",
      goal: "Research",
      background: "Expert",
    },
    displayName: "Ava",
    role: "News Researcher",
    label: "[Researcher]",
  };
  let listeners: Record<string, Array<() => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetProcessDrain();
    listeners = {};
    vi.spyOn(process, "on").mockImplementation((event, handler) => {
      (listeners[String(event)] ??= []).push(handler as () => void);
      return process;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["AGENT_TIMEOUT_MS"];
    delete process.env["RETRY_ON_TIMEOUT"];
  });

  it("passes AGENT_TIMEOUT_MS to the actor as taskTimeoutMs", async () => {
    process.env["AGENT_TIMEOUT_MS"] = "45000";
    await startAgentNode(cfg);
    const deps = vi.mocked(AgentActor).mock.calls.at(-1)?.[4] as {
      taskTimeoutMs?: number;
    };
    expect(deps.taskTimeoutMs).toBe(45_000);
  });

  it("leaves the actor default when AGENT_TIMEOUT_MS is unset or not a positive number", async () => {
    for (const v of [undefined, "abc", "0", "-5"]) {
      if (v === undefined) delete process.env["AGENT_TIMEOUT_MS"];
      else process.env["AGENT_TIMEOUT_MS"] = v;
      await startAgentNode(cfg);
      const deps = vi.mocked(AgentActor).mock.calls.at(-1)?.[4] as {
        taskTimeoutMs?: number;
      };
      expect(deps.taskTimeoutMs).toBeUndefined();
    }
  });

  it("SIGINT drains like SIGTERM, and the drain runs once when both arrive", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        (_code?: number | string | null) => undefined as never,
      );
    await startAgentNode(cfg);
    expect(listeners["SIGINT"]?.length).toBe(1);
    listeners["SIGINT"]![0]!();
    listeners["SIGTERM"]![0]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(mockActorStop).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    exitSpy.mockRestore();
  });

  it("one signal drains every node of the process, then exits once (multi-agent worker)", async () => {
    const order: string[] = [];
    const releases: Array<() => void> = [];
    mockActorStop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releases.push(() => {
            order.push("node-drained");
            resolve();
          });
        }),
    );
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        order.push("exit");
        return undefined as never;
      });
    await startAgentNode(cfg);
    await startAgentNode({
      ...cfg,
      agentId: "writer",
      queue: "kaiban-agents-writer",
    });
    // Listeners are registered once per process, not once per node.
    expect(listeners["SIGTERM"]?.length).toBe(1);
    listeners["SIGTERM"]![0]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(mockActorStop).toHaveBeenCalledTimes(2);
    releases[0]!();
    await new Promise((r) => setTimeout(r, 10));
    // The first node to finish no longer exits while the other still drains.
    expect(exitSpy).not.toHaveBeenCalled();
    releases[1]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["node-drained", "node-drained", "exit"]);
    expect(exitSpy).toHaveBeenCalledWith(0);
    mockActorStop.mockReset().mockResolvedValue(undefined);
    exitSpy.mockRestore();
  });

  it("exits non-zero when any node of the process fails to drain cleanly", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        (_code?: number | string | null) => undefined as never,
      );
    mockActorStop
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second node stop failed"));
    await startAgentNode(cfg);
    await startAgentNode({
      ...cfg,
      agentId: "writer",
      queue: "kaiban-agents-writer",
    });
    listeners["SIGTERM"]![0]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("RETRY_ON_TIMEOUT=true or 1 turns retryOnTimeout on; anything else leaves it off", async () => {
    for (const [v, on] of [
      ["true", true],
      ["1", true],
      [undefined, false],
      ["false", false],
      ["yes", false],
    ] as const) {
      if (v === undefined) delete process.env["RETRY_ON_TIMEOUT"];
      else process.env["RETRY_ON_TIMEOUT"] = v;
      await startAgentNode(cfg);
      const deps = vi.mocked(AgentActor).mock.calls.at(-1)?.[4] as {
        retryOnTimeout?: boolean;
      };
      expect(deps.retryOnTimeout === true).toBe(on);
    }
  });

  it("the drain awaits the telemetry flush before it exits", async () => {
    const order: string[] = [];
    let finishFlush!: () => void;
    mockFlushTelemetry.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFlush = (): void => {
            order.push("flushed");
            resolve();
          };
        }),
    );
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        order.push("exit");
        return undefined as never;
      });
    await startAgentNode(cfg);
    listeners["SIGTERM"]![0]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFlushTelemetry).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    finishFlush();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["flushed", "exit"]);
    exitSpy.mockRestore();
  });
});
