import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AgentActor,
  type AgentActorDeps,
} from "../../../src/application/actor/AgentActor";
import type {
  IMessagingDriver,
  MessagePayload,
} from "../../../src/infrastructure/messaging/interfaces";
import type { ISemanticFirewall } from "../../../src/domain/security/semantic-firewall";
import type { ICircuitBreaker } from "../../../src/domain/security/circuit-breaker";

function makePayload(agentId = "agent-1"): MessagePayload {
  return {
    taskId: "task-1",
    agentId,
    timestamp: Date.now(),
    data: { instruction: "test" },
  };
}

describe("AgentActor — Security deps", () => {
  let driver: IMessagingDriver;
  let subscribedHandler: (payload: MessagePayload) => Promise<void>;

  beforeEach(() => {
    driver = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi
        .fn()
        .mockImplementation(
          (_q: string, handler: (p: MessagePayload) => Promise<void>) => {
            subscribedHandler = handler;
            return Promise.resolve();
          },
        ),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("blocks task when circuit breaker is open", async () => {
    const breaker: ICircuitBreaker = {
      isOpen: vi.fn().mockReturnValue(true),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const deps: AgentActorDeps = { circuitBreaker: breaker };
    const actor = new AgentActor("agent-1", driver, "q", undefined, deps);
    await actor.start();
    await subscribedHandler(makePayload());

    expect(driver.publish).toHaveBeenCalledWith(
      "kaiban-events-failed",
      expect.objectContaining({
        data: expect.objectContaining({ error: "circuit_breaker_open" }),
      }),
    );
  });

  it("blocks task when firewall rejects it", async () => {
    const firewall: ISemanticFirewall = {
      evaluate: vi
        .fn()
        .mockResolvedValue({ allowed: false, reason: "test-blocked" }),
    };
    const deps: AgentActorDeps = { firewall };
    const actor = new AgentActor("agent-1", driver, "q", undefined, deps);
    await actor.start();
    await subscribedHandler(makePayload());

    expect(driver.publish).toHaveBeenCalledWith(
      "kaiban-events-failed",
      expect.objectContaining({
        data: expect.objectContaining({
          error: "blocked_by_semantic_firewall",
          reason: "test-blocked",
        }),
      }),
    );
  });

  it("allows task when firewall approves it", async () => {
    const firewall: ISemanticFirewall = {
      evaluate: vi.fn().mockResolvedValue({ allowed: true }),
    };
    const deps: AgentActorDeps = { firewall };
    const actor = new AgentActor("agent-1", driver, "q", undefined, deps);
    await actor.start();
    await subscribedHandler(makePayload());

    expect(driver.publish).toHaveBeenCalledWith(
      "kaiban-events-completed",
      expect.objectContaining({
        data: expect.objectContaining({ status: "success" }),
      }),
    );
  });

  it("records success on circuit breaker after successful task", async () => {
    const breaker: ICircuitBreaker = {
      isOpen: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const deps: AgentActorDeps = { circuitBreaker: breaker };
    const actor = new AgentActor("agent-1", driver, "q", undefined, deps);
    await actor.start();
    await subscribedHandler(makePayload());

    expect(breaker.recordSuccess).toHaveBeenCalled();
    expect(breaker.recordFailure).not.toHaveBeenCalled();
  });

  it("records failure on circuit breaker after exhausting retries", async () => {
    const breaker: ICircuitBreaker = {
      isOpen: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const failingHandler = vi.fn().mockRejectedValue(new Error("boom"));
    const deps: AgentActorDeps = { circuitBreaker: breaker };
    const actor = new AgentActor("agent-1", driver, "q", failingHandler, deps);
    await actor.start();
    await subscribedHandler(makePayload());

    expect(breaker.recordFailure).toHaveBeenCalled();
    expect(breaker.recordSuccess).not.toHaveBeenCalled();
  });

  it("works without any security deps (backwards compatible)", async () => {
    const actor = new AgentActor("agent-1", driver, "q");
    await actor.start();
    await subscribedHandler(makePayload());

    expect(driver.publish).toHaveBeenCalledWith(
      "kaiban-events-completed",
      expect.objectContaining({
        data: expect.objectContaining({ status: "success" }),
      }),
    );
  });
});
