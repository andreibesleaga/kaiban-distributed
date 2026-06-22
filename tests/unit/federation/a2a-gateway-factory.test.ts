import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildA2AStack } from "../../../src/infrastructure/federation/a2a-gateway-factory";
import { CompletionRouter } from "../../../src/shared/completion-router";

const mockSet = vi.fn().mockResolvedValue("OK");
const mockGet = vi.fn().mockResolvedValue(null);
const mockSubscribe = vi.fn().mockResolvedValue(1);
const mockOn = vi.fn();
const mockQuit = vi.fn().mockResolvedValue(undefined);

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    return {
      set: mockSet,
      get: mockGet,
      subscribe: mockSubscribe,
      on: mockOn,
      quit: mockQuit,
    };
  }),
}));

function makeRouter(): CompletionRouter {
  const driver = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return new CompletionRouter(driver as never);
}

describe("buildA2AStack", () => {
  beforeEach(() => vi.clearAllMocks());

  const base = {
    driver: { publish: vi.fn().mockResolvedValue(undefined) } as never,
    router: makeRouter(),
    redisUrl: "redis://localhost:6379",
    name: "kaiban-worker",
    version: "2.0.0",
    baseUrl: "http://localhost:3000",
    agentIds: ["writer"],
    timeoutMs: 1000,
  };

  it("returns a request handler whose card matches the built AgentCard", async () => {
    const stack = buildA2AStack(base);
    const card = await stack.requestHandler.getAgentCard();
    expect(card.protocolVersion).toBe("0.3.0");
    expect(card.name).toBe("kaiban-worker");
    expect(card.url).toBe("http://localhost:3000/a2a/rpc");
  });

  it("starts the status tracker (subscribes to the state channel)", async () => {
    const stack = buildA2AStack(base);
    await stack.start();
    expect(mockSubscribe).toHaveBeenCalledWith("kaiban-state-events");
  });

  it("advertises JWT security when jwtEnabled is true", async () => {
    const stack = buildA2AStack({ ...base, jwtEnabled: true });
    const card = await stack.requestHandler.getAgentCard();
    expect(card.securitySchemes?.["bearerAuth"]).toBeDefined();
  });

  it("forwards pushNotifications + provider onto the card", async () => {
    const stack = buildA2AStack({
      ...base,
      pushNotifications: true,
      provider: { organization: "Kaiban", url: "http://kaiban.example" },
    });
    const card = await stack.requestHandler.getAgentCard();
    expect(card.capabilities.pushNotifications).toBe(true);
    expect(card.provider?.organization).toBe("Kaiban");
  });

  it("exposes a status tracker and a close() that tears down owned clients", async () => {
    const stack = buildA2AStack(base);
    await stack.start();
    expect(stack.statusTracker.getStatus("writer")).toBe("IDLE");
    await stack.close();
    expect(mockQuit).toHaveBeenCalled();
  });
});
