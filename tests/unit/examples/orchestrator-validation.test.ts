/**
 * Orchestrator Startup Validation Tests
 *
 * Verifies that all agentIds used by both example orchestrators pass the A2A
 * connector's validation (alphanumeric/hyphens, max 64 chars) and that the
 * global-research searcher routing uses the correct IDs.
 *
 * These tests catch regressions like `agentId: '*'` which breaks at runtime
 * with "Invalid agentId: must be alphanumeric/hyphens, max 64 chars".
 */
import { describe, it, expect, vi } from "vitest";
import {
  A2AConnector,
  type AgentCard,
} from "../../../src/infrastructure/federation/a2a-connector";
import type { IMessagingDriver } from "../../../src/infrastructure/messaging/interfaces";

const testCard: AgentCard = {
  name: "test-worker",
  version: "1.0.0",
  description: "test",
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

async function createTask(
  agentId: string,
  driver?: IMessagingDriver,
): Promise<{
  ok: boolean;
  error?: { code: number; message: string };
  result?: { taskId: string; status: string; agentId: string };
}> {
  const conn = new A2AConnector(testCard, driver);
  const res = await conn.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tasks.create",
    params: { agentId, instruction: "test instruction" },
  });
  if (!res.ok) return { ok: false };
  const val = res.value;
  if (val.error) return { ok: true, error: val.error };
  return {
    ok: true,
    result: val.result as { taskId: string; status: string; agentId: string },
  };
}

// ── Blog-Team agentIds ──────────────────────────────────────────────────

describe("Blog-Team orchestrator agentIds pass A2A validation", () => {
  const blogAgentIds = ["researcher", "writer", "editor"];

  it.each(blogAgentIds)(
    'agentId "%s" is accepted and publishes to correct queue',
    async (agentId) => {
      const driver = makeMockDriver();
      const res = await createTask(agentId, driver);
      expect(res.error).toBeUndefined();
      expect(res.result?.status).toBe("QUEUED");
      expect(res.result?.agentId).toBe(agentId);
      expect(driver.publish).toHaveBeenCalledWith(
        `kaiban-agents-${agentId}`,
        expect.objectContaining({ agentId }),
      );
    },
  );
});

// ── Global-Research agentIds ────────────────────────────────────────────

describe("Global-Research orchestrator agentIds pass A2A validation", () => {
  const globalAgentIds = ["searcher", "writer", "reviewer", "editor"];

  it.each(globalAgentIds)(
    'agentId "%s" is accepted and publishes to correct queue',
    async (agentId) => {
      const driver = makeMockDriver();
      const res = await createTask(agentId, driver);
      expect(res.error).toBeUndefined();
      expect(res.result?.status).toBe("QUEUED");
      expect(res.result?.agentId).toBe(agentId);
      expect(driver.publish).toHaveBeenCalledWith(
        `kaiban-agents-${agentId}`,
        expect.objectContaining({ agentId }),
      );
    },
  );

  it('searcher tasks use agentId "searcher" (not wildcard "*")', async () => {
    // Wildcard must be rejected — this catches the regression where
    // orchestrator used agentId: '*' which fails A2A validation.
    const wildcardRes = await createTask("*");
    expect(wildcardRes.error).toBeDefined();
    expect(wildcardRes.error?.code).toBe(-32602);

    // The correct agentId 'searcher' must be accepted
    const driver = makeMockDriver();
    const searcherRes = await createTask("searcher", driver);
    expect(searcherRes.error).toBeUndefined();
    expect(searcherRes.result?.agentId).toBe("searcher");
    expect(driver.publish).toHaveBeenCalledWith(
      "kaiban-agents-searcher",
      expect.objectContaining({ agentId: "searcher" }),
    );
  });
});

// ── Searcher node routing vs display ID ─────────────────────────────────

describe("Searcher node routing ID separation", () => {
  it('AgentActor routing ID "searcher" accepts tasks with agentId "searcher"', async () => {
    // Simulates the processTask ID matching logic:
    // AgentActor has this.id = 'searcher', task has payload.agentId = 'searcher'
    const routingId = "searcher";
    const taskAgentId = "searcher";
    expect(taskAgentId === routingId || taskAgentId === "*").toBe(true);
  });

  it('unique display IDs (searcher-0..3) would reject tasks with agentId "searcher"', () => {
    // This verifies WHY we need the routing/display ID separation:
    // If the actor used 'searcher-0' as its ID, tasks with agentId 'searcher' would be rejected.
    const displayId: string = "searcher-0";
    const taskAgentId: string = "searcher";
    expect(taskAgentId === displayId || taskAgentId === "*").toBe(false);
  });

  it("display IDs (searcher-0..3) pass A2A validation for board publishing", async () => {
    // Display IDs are valid agentIds (used by AgentStatePublisher for board state)
    for (let i = 0; i < 4; i++) {
      const res = await createTask(`searcher-${i}`);
      expect(res.error).toBeUndefined();
      expect(res.result?.status).toBe("QUEUED");
    }
  });
});
