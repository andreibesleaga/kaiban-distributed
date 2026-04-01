import { describe, it, expect, vi } from "vitest";
import {
  A2AConnector,
  type AgentCard,
  type JsonRpcError,
} from "../../../src/infrastructure/federation/a2a-connector";
import type { IMessagingDriver } from "../../../src/infrastructure/messaging/interfaces";

const testCard: AgentCard = {
  name: "coverage-worker",
  version: "1.0.0",
  description: "coverage",
  capabilities: ["tasks.create"],
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

interface A2AConnectorPrivate {
  validateCreateParams(
    params: Record<string, unknown> | undefined,
  ): { agentId: string } | { error: JsonRpcError };
  handleTasksCreate(
    params: Record<string, unknown> | undefined,
  ): Promise<{ result: unknown } | { error: JsonRpcError }>;
}

describe("A2AConnector — unreachable fallback coverage", () => {
  it("publishes an empty data object when params is undefined after validation succeeds", async () => {
    const driver = makeMockDriver();
    const connector = new A2AConnector(testCard, driver);
    const privateConnector = connector as unknown as A2AConnectorPrivate;

    vi.spyOn(privateConnector, "validateCreateParams").mockReturnValue({
      agentId: "researcher",
    });

    const result = await privateConnector.handleTasksCreate(undefined);

    expect(driver.publish).toHaveBeenCalledWith(
      "kaiban-agents-researcher",
      expect.objectContaining({ data: {} }),
    );
    expect("result" in result).toBe(true);
  });
});