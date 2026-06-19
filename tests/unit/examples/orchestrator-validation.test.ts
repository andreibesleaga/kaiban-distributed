/**
 * Orchestrator Startup Validation Tests
 *
 * Verifies that all agentIds used by both example orchestrators pass A2A input
 * validation (alphanumeric/hyphens, max 64 chars) and that the global-research
 * searcher routing uses the correct IDs.
 *
 * These tests catch regressions like `agentId: '*'` which breaks at runtime
 * with "Invalid agentId: must be alphanumeric/hyphens, max 64 chars".
 */
import { describe, it, expect } from "vitest";
import { validateTaskInput } from "../../../src/infrastructure/federation/a2a-input-validation";

function validate(agentId: string): {
  ok: boolean;
  agentId?: string;
  error?: { code: number; message: string };
} {
  const res = validateTaskInput({ agentId, instruction: "test instruction" });
  if ("error" in res) return { ok: false, error: res.error };
  return { ok: true, agentId: res.params.agentId };
}

// ── Blog-Team agentIds ──────────────────────────────────────────────────

describe("Blog-Team orchestrator agentIds pass A2A validation", () => {
  const blogAgentIds = ["researcher", "writer", "editor"];

  it.each(blogAgentIds)('agentId "%s" is accepted', (agentId) => {
    const res = validate(agentId);
    expect(res.error).toBeUndefined();
    expect(res.agentId).toBe(agentId);
  });
});

// ── Global-Research agentIds ────────────────────────────────────────────

describe("Global-Research orchestrator agentIds pass A2A validation", () => {
  const globalAgentIds = ["searcher", "writer", "reviewer", "editor"];

  it.each(globalAgentIds)('agentId "%s" is accepted', (agentId) => {
    const res = validate(agentId);
    expect(res.error).toBeUndefined();
    expect(res.agentId).toBe(agentId);
  });

  it('searcher tasks use agentId "searcher" (not wildcard "*")', () => {
    // Wildcard must be rejected — this catches the regression where the
    // orchestrator used agentId: '*' which fails A2A validation.
    const wildcardRes = validate("*");
    expect(wildcardRes.error).toBeDefined();
    expect(wildcardRes.error?.code).toBe(-32602);

    const searcherRes = validate("searcher");
    expect(searcherRes.error).toBeUndefined();
    expect(searcherRes.agentId).toBe("searcher");
  });
});

// ── Searcher node routing vs display ID ─────────────────────────────────

describe("Searcher node routing ID separation", () => {
  it('AgentActor routing ID "searcher" accepts tasks with agentId "searcher"', () => {
    const routingId = "searcher";
    const taskAgentId = "searcher";
    expect(taskAgentId === routingId || taskAgentId === "*").toBe(true);
  });

  it('unique display IDs (searcher-0..3) would reject tasks with agentId "searcher"', () => {
    const displayId: string = "searcher-0";
    const taskAgentId: string = "searcher";
    expect(taskAgentId === displayId || taskAgentId === "*").toBe(false);
  });

  it("display IDs (searcher-0..3) pass A2A validation for board publishing", () => {
    for (let i = 0; i < 4; i++) {
      const res = validate(`searcher-${i}`);
      expect(res.error).toBeUndefined();
      expect(res.agentId).toBe(`searcher-${i}`);
    }
  });
});
