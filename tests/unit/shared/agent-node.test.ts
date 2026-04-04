import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startAgentNode } from "../../../src/shared";

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

  let logSpy: ReturnType<typeof vi.spyOn>;
  let sigTermListeners: Array<() => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
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
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Ava"));
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
    );
    delete process.env["REDIS_URL"];
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
});
