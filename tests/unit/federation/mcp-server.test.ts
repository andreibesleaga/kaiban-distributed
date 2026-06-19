/**
 * MCP server capabilities (master plan §B5.1 Phase M, ADR-017).
 *
 * Drives `buildMcpServer` with a REAL SDK `Client` over an in-memory linked
 * transport pair — a genuine protocol round-trip with zero brokers. Verifies the
 * allow-listed Tools / Resources / Prompts, and the elicitation consent gate in
 * front of `dispatch_task` (accept / decline / form-reject / fail-closed).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ElicitRequestSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  buildMcpServer,
  type McpServerDeps,
  MCP_TOOL_DISPATCH,
} from "../../../src/infrastructure/federation/mcp-server";

interface Harness {
  client: Client;
  dispatchTask: ReturnType<typeof vi.fn>;
  listAgents: ReturnType<typeof vi.fn>;
  getAgentStatus: ReturnType<typeof vi.fn>;
}

const openHarnesses: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (openHarnesses.length) await openHarnesses.pop()!();
});

async function connect(opts: {
  deps?: Partial<McpServerDeps>;
  /** Client-side elicitation responder; omit to advertise NO elicitation support. */
  elicit?: (message: string) => ElicitResult;
}): Promise<Harness> {
  const dispatchTask = vi.fn(async () => ({ taskId: "task-1", status: "DOING" }));
  const listAgents = vi.fn(() => [
    { id: "researcher", status: "IDLE" },
    { id: "writer", status: "THINKING" },
  ]);
  const getAgentStatus = vi.fn((agentId: string) => ({
    agentId,
    status: "EXECUTING",
    seen: true,
  }));

  const deps: McpServerDeps = {
    dispatchTask,
    listAgents,
    getAgentStatus,
    ...opts.deps,
  };
  const server = buildMcpServer(deps);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: opts.elicit ? { elicitation: {} } : {} },
  );
  if (opts.elicit) {
    const responder = opts.elicit;
    client.setRequestHandler(ElicitRequestSchema, (request) =>
      responder(request.params.message),
    );
  }
  await client.connect(clientTransport);

  openHarnesses.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, dispatchTask, listAgents, getAgentStatus };
}

describe("buildMcpServer — discovery", () => {
  it("exposes the curated tools, resources and prompts by default", async () => {
    const { client } = await connect({});

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([MCP_TOOL_DISPATCH]);

    const resources = await client.listResources();
    const uris = resources.resources.map((r) => r.uri);
    expect(uris).toContain("kaiban://agents");
    // The template's list callback enumerates one status resource per agent.
    expect(uris).toContain("kaiban://agents/researcher/status");
    expect(uris).toContain("kaiban://agents/writer/status");

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toContain(
      "kaiban://agents/{agentId}/status",
    );

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(["delegate_task"]);
  });

  it("advertises no tool/resource/prompt capabilities when the allow-list is empty", async () => {
    const { client } = await connect({
      deps: { allow: { tools: [], resources: [], prompts: [] } },
    });
    // Least-privilege: nothing registered ⇒ those capabilities aren't advertised
    // at all (the SDK would answer list calls with -32601 Method Not Found).
    const caps = client.getServerCapabilities();
    expect(caps?.tools).toBeUndefined();
    expect(caps?.resources).toBeUndefined();
    expect(caps?.prompts).toBeUndefined();
  });

  it("can allow a subset of resources independently", async () => {
    const { client } = await connect({
      deps: { allow: { resources: ["agents"] } },
    });
    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toEqual(["kaiban://agents"]);
    expect(
      (await client.listResourceTemplates()).resourceTemplates,
    ).toHaveLength(0);
  });
});

describe("buildMcpServer — resources", () => {
  it("serves the agents list resource", async () => {
    const { client, listAgents } = await connect({});
    const result = await client.readResource({ uri: "kaiban://agents" });
    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((result.contents[0] as { text: string }).text),
    ).toEqual([
      { id: "researcher", status: "IDLE" },
      { id: "writer", status: "THINKING" },
    ]);
  });

  it("serves a single agent's status via the URI template", async () => {
    const { client, getAgentStatus } = await connect({});
    const result = await client.readResource({
      uri: "kaiban://agents/writer/status",
    });
    expect(getAgentStatus).toHaveBeenCalledWith("writer");
    expect(
      JSON.parse((result.contents[0] as { text: string }).text),
    ).toEqual({
      agentId: "writer",
      status: "EXECUTING",
      seen: true,
    });
  });
});

describe("buildMcpServer — prompts", () => {
  it("renders the delegate_task prompt with the supplied arguments", async () => {
    const { client } = await connect({});
    const result = await client.getPrompt({
      name: "delegate_task",
      arguments: { agentId: "researcher", goal: "survey the field" },
    });
    const text = (result.messages[0]!.content as { text: string }).text;
    expect(text).toContain('agent "researcher"');
    expect(text).toContain("survey the field");
    expect(text).toContain(MCP_TOOL_DISPATCH);
  });
});

describe("buildMcpServer — dispatch_task consent gate", () => {
  it("dispatches after the client accepts the elicitation", async () => {
    const { client, dispatchTask } = await connect({
      elicit: () => ({ action: "accept", content: { confirm: true } }),
    });
    const result = await client.callTool({
      name: MCP_TOOL_DISPATCH,
      arguments: {
        agentId: "researcher",
        instruction: "research X",
        expectedOutput: "a report",
      },
    });
    expect(dispatchTask).toHaveBeenCalledWith({
      agentId: "researcher",
      instruction: "research X",
      expectedOutput: "a report",
    });
    expect(result.structuredContent).toMatchObject({
      dispatched: true,
      taskId: "task-1",
      status: "DOING",
    });
    expect(result.isError).toBeFalsy();
  });

  it("omits expectedOutput when not provided", async () => {
    const { client, dispatchTask } = await connect({
      elicit: () => ({ action: "accept", content: { confirm: true } }),
    });
    await client.callTool({
      name: MCP_TOOL_DISPATCH,
      arguments: { agentId: "writer", instruction: "write it" },
    });
    expect(dispatchTask).toHaveBeenCalledWith({
      agentId: "writer",
      instruction: "write it",
    });
  });

  it("does NOT dispatch when the client declines", async () => {
    const { client, dispatchTask } = await connect({
      elicit: () => ({ action: "decline" }),
    });
    const result = await client.callTool({
      name: MCP_TOOL_DISPATCH,
      arguments: { agentId: "researcher", instruction: "research X" },
    });
    expect(dispatchTask).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      dispatched: false,
      reason: "consent decline",
    });
  });

  it("does NOT dispatch when the consent form is rejected", async () => {
    const { client, dispatchTask } = await connect({
      elicit: () => ({ action: "accept", content: { confirm: false } }),
    });
    const result = await client.callTool({
      name: MCP_TOOL_DISPATCH,
      arguments: { agentId: "researcher", instruction: "research X" },
    });
    expect(dispatchTask).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      dispatched: false,
      reason: "consent form rejected",
    });
  });

  it("fails closed when the client cannot be asked for consent", async () => {
    const { client, dispatchTask } = await connect({});
    const result = await client.callTool({
      name: MCP_TOOL_DISPATCH,
      arguments: { agentId: "researcher", instruction: "research X" },
    });
    expect(dispatchTask).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ dispatched: false });
    expect(
      (result.structuredContent as { reason: string }).reason,
    ).toContain("fail-closed");
  });

  it("truncates a long instruction in the consent prompt", async () => {
    let asked = "";
    const longInstruction = "x".repeat(250);
    const { client, dispatchTask } = await connect({
      elicit: (message) => {
        asked = message;
        return { action: "accept", content: { confirm: true } };
      },
    });
    await client.callTool({
      name: MCP_TOOL_DISPATCH,
      arguments: { agentId: "researcher", instruction: longInstruction },
    });
    expect(asked).toContain("…");
    expect(asked).not.toContain(longInstruction);
    expect(dispatchTask).toHaveBeenCalledTimes(1);
  });

  it("dispatches without consent when requireDispatchConsent is false", async () => {
    const { client, dispatchTask } = await connect({
      deps: { requireDispatchConsent: false },
    });
    const result = await client.callTool({
      name: MCP_TOOL_DISPATCH,
      arguments: { agentId: "researcher", instruction: "research X" },
    });
    expect(dispatchTask).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({ dispatched: true });
  });
});
