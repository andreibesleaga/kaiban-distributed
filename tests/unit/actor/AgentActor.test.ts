import { describe, it, expect, vi } from "vitest";
import { AgentActor } from "../../../src/application/actor/AgentActor";
import {
  IMessagingDriver,
  MessagePayload,
} from "../../../src/infrastructure/messaging/interfaces";

describe("AgentActor", () => {
  it("subscribes to the correct queue on start", async () => {
    const mockDriver: IMessagingDriver = {
      publish: vi.fn(),
      subscribe: vi.fn(),
      disconnect: vi.fn(),
    };

    const actor = new AgentActor("agent-1", mockDriver, "agent-1-queue");
    await actor.start();

    expect(mockDriver.subscribe).toHaveBeenCalledWith(
      "agent-1-queue",
      expect.any(Function),
    );
  });

  it("processes a matching task and publishes completion", async () => {
    let capturedHandler!: (payload: Record<string, unknown>) => Promise<void>;
    const mockDriver: IMessagingDriver = {
      publish: vi.fn(),
      subscribe: vi.fn(
        (_q: string, handler: (payload: MessagePayload) => Promise<void>) => {
          capturedHandler = handler as unknown as (
            payload: Record<string, unknown>,
          ) => Promise<void>;
          return Promise.resolve();
        },
      ),
      disconnect: vi.fn(),
    };

    const actor = new AgentActor("agent-1", mockDriver, "agent-1-queue");
    await actor.start();

    expect(capturedHandler).toBeDefined();

    // Trigger handler
    await capturedHandler({
      taskId: "task-abc",
      agentId: "agent-1",
      timestamp: Date.now(),
      data: { cmd: "doWork" },
    });

    // Check completion publish
    expect(mockDriver.publish).toHaveBeenCalledWith(
      "kaiban:events:completed",
      expect.objectContaining({
        taskId: "task-abc",
        agentId: "agent-1",
        data: expect.objectContaining({ status: "success" }),
      }),
    );
  });
});
