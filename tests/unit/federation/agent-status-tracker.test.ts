import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentStatusTracker } from "../../../src/infrastructure/federation/agent-status-tracker";
import { STATE_CHANNEL } from "../../../src/infrastructure/messaging/channels";
import { wrapSigned } from "../../../src/infrastructure/security/channel-signing";

// Capture the on('message') handler so tests can drive Redis pub/sub by hand.
let messageHandler: ((channel: string, message: string) => void) | undefined;
const mockSubscribe = vi.fn().mockResolvedValue(1);
const mockOn = vi.fn((event: string, cb: typeof messageHandler) => {
  if (event === "message") messageHandler = cb;
});
const mockQuit = vi.fn().mockResolvedValue(undefined);

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { subscribe: mockSubscribe, on: mockOn, quit: mockQuit };
  }),
}));

function emit(payload: Record<string, unknown>): void {
  messageHandler?.(STATE_CHANNEL, wrapSigned(payload));
}

describe("AgentStatusTracker", () => {
  beforeEach(() => {
    messageHandler = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env["CHANNEL_SIGNING_SECRET"];
  });

  it("subscribes to the state channel on start()", async () => {
    const t = new AgentStatusTracker("redis://localhost:6379");
    await t.start();
    expect(mockSubscribe).toHaveBeenCalledWith(STATE_CHANNEL);
  });

  it("returns IDLE for an unknown agent (default)", async () => {
    const t = new AgentStatusTracker("redis://localhost:6379");
    await t.start();
    expect(t.getStatus("nobody")).toBe("IDLE");
  });

  it("tracks the latest published status per agent", async () => {
    const t = new AgentStatusTracker("redis://localhost:6379");
    await t.start();
    emit({ agents: [{ agentId: "writer", status: "EXECUTING" }] });
    expect(t.getStatus("writer")).toBe("EXECUTING");
    emit({ agents: [{ agentId: "writer", status: "IDLE" }] });
    expect(t.getStatus("writer")).toBe("IDLE");
  });

  it("tracks multiple agents independently", async () => {
    const t = new AgentStatusTracker("redis://localhost:6379");
    await t.start();
    emit({
      agents: [
        { agentId: "a", status: "THINKING" },
        { agentId: "b", status: "ERROR" },
      ],
    });
    expect(t.getStatus("a")).toBe("THINKING");
    expect(t.getStatus("b")).toBe("ERROR");
  });

  it("ignores messages on other channels", async () => {
    const t = new AgentStatusTracker("redis://localhost:6379");
    await t.start();
    messageHandler?.(
      "some-other-channel",
      wrapSigned({ agents: [{ agentId: "x", status: "EXECUTING" }] }),
    );
    expect(t.getStatus("x")).toBe("IDLE");
  });

  it("ignores malformed / unverifiable payloads", async () => {
    const t = new AgentStatusTracker("redis://localhost:6379");
    await t.start();
    messageHandler?.(STATE_CHANNEL, "{not-json");
    expect(t.getStatus("x")).toBe("IDLE");
  });

  it("ignores deltas without an agents array", async () => {
    const t = new AgentStatusTracker("redis://localhost:6379");
    await t.start();
    emit({ tasks: [{ taskId: "t" }] });
    expect(t.getStatus("x")).toBe("IDLE");
  });

  it("ignores agent entries missing an id or status", async () => {
    const t = new AgentStatusTracker("redis://localhost:6379");
    await t.start();
    emit({ agents: [{ status: "EXECUTING" }, { agentId: "y" }] });
    expect(t.getStatus("y")).toBe("IDLE");
  });

  it("ignores null / non-object entries in the agents array", async () => {
    const t = new AgentStatusTracker("redis://localhost:6379");
    await t.start();
    emit({ agents: [null, 42, { agentId: "ok", status: "EXECUTING" }] });
    expect(t.getStatus("ok")).toBe("EXECUTING");
  });

  it("coerces an unknown status string to IDLE", async () => {
    const t = new AgentStatusTracker("redis://localhost:6379");
    await t.start();
    emit({ agents: [{ agentId: "z", status: "BOGUS" }] });
    expect(t.getStatus("z")).toBe("IDLE");
  });

  it("knows whether it has ever seen an agent", async () => {
    const t = new AgentStatusTracker("redis://localhost:6379");
    await t.start();
    expect(t.hasSeen("seen")).toBe(false);
    emit({ agents: [{ agentId: "seen", status: "IDLE" }] });
    expect(t.hasSeen("seen")).toBe(true);
  });

  it("stop() quits the subscriber", async () => {
    const t = new AgentStatusTracker("redis://localhost:6379");
    await t.start();
    await t.stop();
    expect(mockQuit).toHaveBeenCalledTimes(1);
  });

  it("accepts an injected Redis subscriber and does not quit it on stop()", async () => {
    const injected = { subscribe: mockSubscribe, on: mockOn, quit: mockQuit };
    const t = new AgentStatusTracker(injected as never);
    await t.start();
    await t.stop();
    expect(mockQuit).not.toHaveBeenCalled();
  });
});
