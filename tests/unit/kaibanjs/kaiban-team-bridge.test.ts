import { describe, it, expect, vi, beforeEach } from "vitest";
import { KaibanTeamBridge } from "../../../src/infrastructure/kaibanjs/kaiban-team-bridge";
import type { IStateMiddleware } from "../../../src/infrastructure/kaibanjs/kaiban-team-bridge";

const mockGetStore = vi.fn().mockReturnValue({
  setState: vi.fn(),
  getState: vi.fn().mockReturnValue({ teamWorkflowStatus: "INITIAL" }),
  subscribe: vi.fn().mockReturnValue(() => {}),
});
const mockStart = vi
  .fn()
  .mockResolvedValue({ status: "FINISHED", result: "blog post", stats: null });
const mockSubscribeToChanges = vi.fn().mockReturnValue(() => {});

vi.mock("kaibanjs", () => ({
  Team: vi.fn().mockImplementation(function () {
    return {
      getStore: mockGetStore,
      start: mockStart,
      subscribeToChanges: mockSubscribeToChanges,
    };
  }),
  Agent: vi.fn().mockImplementation(function (params: Record<string, unknown>) {
    return params;
  }),
  Task: vi.fn().mockImplementation(function (params: Record<string, unknown>) {
    return params;
  }),
}));

function makeMockMiddleware(): IStateMiddleware & {
  attach: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  return {
    attach: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
  } as unknown as IStateMiddleware & {
    attach: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
}

describe("KaibanTeamBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls team.getStore() to attach DistributedStateMiddleware", () => {
    const mw = makeMockMiddleware();
    const bridge = new KaibanTeamBridge(
      { name: "Blog Team", agents: [], tasks: [] },
      mw,
    );
    expect(bridge).toBeDefined();
    expect(mockGetStore).toHaveBeenCalledOnce();
    expect(mw.attach).toHaveBeenCalledOnce();
  });

  it("works without middleware (no state sync)", () => {
    const bridge = new KaibanTeamBridge({ name: "T", agents: [], tasks: [] });
    expect(bridge).toBeDefined();
    expect(mockGetStore).not.toHaveBeenCalled();
  });

  it("getTeam() returns the underlying KaibanJS Team", () => {
    const bridge = new KaibanTeamBridge({ name: "T", agents: [], tasks: [] });
    const team = bridge.getTeam();
    expect(team).toBeDefined();
    expect(typeof team.start).toBe("function");
  });

  it("start() delegates to team.start() with inputs", async () => {
    const bridge = new KaibanTeamBridge({ name: "T", agents: [], tasks: [] });
    const result = await bridge.start({ topic: "AI trends" });
    expect(mockStart).toHaveBeenCalledWith({ topic: "AI trends" });
    expect(result.status).toBe("FINISHED");
  });

  it("start() with no inputs passes empty object", async () => {
    const bridge = new KaibanTeamBridge({ name: "T", agents: [], tasks: [] });
    await bridge.start();
    expect(mockStart).toHaveBeenCalledWith({});
  });

  it("subscribeToChanges() sets up a store listener", () => {
    const bridge = new KaibanTeamBridge({ name: "T", agents: [], tasks: [] });
    const listener = vi.fn();
    bridge.subscribeToChanges(listener, ["teamWorkflowStatus"]);
    expect(mockSubscribeToChanges).toHaveBeenCalledWith(listener, [
      "teamWorkflowStatus",
    ]);
  });

  it("disconnect() calls middleware disconnect when middleware provided", async () => {
    const mw = makeMockMiddleware();
    const bridge = new KaibanTeamBridge(
      { name: "T", agents: [], tasks: [] },
      mw,
    );
    await bridge.disconnect();
    expect(mw.disconnect).toHaveBeenCalled();
  });

  it("disconnect() is safe when no middleware provided", async () => {
    const bridge = new KaibanTeamBridge({ name: "T", agents: [], tasks: [] });
    await expect(bridge.disconnect()).resolves.not.toThrow();
  });
});
