import { describe, it, expect, vi } from "vitest";
import {
  A2AConnector,
  type AgentCard,
  type JsonRpcRequest,
} from "../../../src/infrastructure/federation/a2a-connector";
import type { IMessagingDriver } from "../../../src/infrastructure/messaging/interfaces";

const testCard: AgentCard = {
  name: "kaiban-worker",
  version: "1.0.0",
  description: "Test",
  capabilities: ["agent.status"],
  endpoints: { rpc: "/a2a/rpc" },
};

function makeMockDriver(): IMessagingDriver {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

describe("A2AConnector", () => {
  it("getAgentCard() returns the injected card", () => {
    expect(new A2AConnector(testCard).getAgentCard()).toEqual(testCard);
  });

  it("handleRpc() with agent.status returns success", async () => {
    const result = await new A2AConnector(testCard).handleRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "agent.status",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.result).toBeDefined();
  });

  it("handleRpc() with unknown method returns -32601", async () => {
    const result = await new A2AConnector(testCard).handleRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "x",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.error?.code).toBe(-32601);
  });

  it("handleRpc() without jsonrpc field returns -32600", async () => {
    const result = await new A2AConnector(testCard).handleRpc({
      id: 3,
      method: "agent.status",
    } as unknown as JsonRpcRequest);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.error?.code).toBe(-32600);
  });

  it("handleRpc() without id covers id ?? null branch", async () => {
    const result = await new A2AConnector(testCard).handleRpc({
      method: "agent.status",
    } as unknown as JsonRpcRequest);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBeNull();
  });

  it("handleRpc() with tasks.create without driver returns QUEUED but does not publish", async () => {
    const result = await new A2AConnector(testCard).handleRpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tasks.create",
      params: { agentId: "researcher", instruction: "research AI" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const r = result.value.result as {
        taskId: string;
        status: string;
        agentId: string;
      };
      expect(r.status).toBe("QUEUED");
      expect(r.agentId).toBe("researcher");
      expect(r.taskId).toMatch(/^[0-9a-f-]{36}$/); // UUID v4
    }
  });

  it("handleRpc() tasks.create with driver publishes to correct BullMQ queue", async () => {
    const driver = makeMockDriver();
    const connector = new A2AConnector(testCard, driver);
    await connector.handleRpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tasks.create",
      params: { agentId: "researcher", instruction: "research AI" },
    });
    expect(driver.publish).toHaveBeenCalledWith(
      "kaiban-agents-researcher",
      expect.objectContaining({
        agentId: "researcher",
        data: expect.objectContaining({ instruction: "research AI" }),
      }),
    );
  });

  it("handleRpc() tasks.create without agentId returns -32602 (wildcard removed)", async () => {
    const driver = makeMockDriver();
    const connector = new A2AConnector(testCard, driver);
    const result = await connector.handleRpc({
      jsonrpc: "2.0",
      id: 6,
      method: "tasks.create",
      params: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.error?.code).toBe(-32602);
    expect(driver.publish).not.toHaveBeenCalled();
  });

  it("handleRpc() with tasks.get with taskId param", async () => {
    const result = await new A2AConnector(testCard).handleRpc({
      jsonrpc: "2.0",
      id: 7,
      method: "tasks.get",
      params: { taskId: "task-1" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const r = result.value.result as { taskId: string };
      expect(r.taskId).toBe("task-1");
    }
  });

  it("handleRpc() with tasks.get without params returns null taskId", async () => {
    const result = await new A2AConnector(testCard).handleRpc({
      jsonrpc: "2.0",
      id: 8,
      method: "tasks.get",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const r = result.value.result as { taskId: null };
      expect(r.taskId).toBeNull();
    }
  });

  it("handleRpc() tasks.create with no params returns -32602 (agentId required)", async () => {
    const driver = makeMockDriver();
    const connector = new A2AConnector(testCard, driver);
    const result = await connector.handleRpc({
      jsonrpc: "2.0",
      id: 9,
      method: "tasks.create",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.error?.code).toBe(-32602);
    expect(driver.publish).not.toHaveBeenCalled();
  });

  it("handleRpc() tasks.create with explicit agentId publishes to correct queue", async () => {
    const driver = makeMockDriver();
    const connector = new A2AConnector(testCard, driver);
    const result = await connector.handleRpc({
      jsonrpc: "2.0",
      id: 10,
      method: "tasks.create",
      params: { agentId: "writer", instruction: "write the blog post" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const r = result.value.result as { taskId: string; agentId: string };
      expect(r.agentId).toBe("writer");
    }
    expect(driver.publish).toHaveBeenCalledWith(
      "kaiban-agents-writer",
      expect.objectContaining({
        agentId: "writer",
      }),
    );
  });
});
