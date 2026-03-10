import { describe, it, expect, vi } from "vitest";
import { MCPFederationClient } from "../../../src/infrastructure/federation/mcp-client";

// Mock the core Client and Transport from the SDK
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  return {
    Client: vi.fn().mockImplementation(function () {
      return {
        connect: vi.fn().mockResolvedValue(undefined),
        listTools: vi
          .fn()
          .mockResolvedValue({ tools: [{ name: "test-tool" }] }),
        callTool: vi
          .fn()
          .mockResolvedValue({ content: [{ text: "tool result" }] }),
        close: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  return {
    StdioClientTransport: vi.fn().mockImplementation(function () {
      return {
        start: vi.fn(),
        close: vi.fn(),
      };
    }),
  };
});

describe("MCPFederationClient", () => {
  it("connects to an MCP server and queries tools", async () => {
    const client = new MCPFederationClient("npx", [
      "-y",
      "@modelcontextprotocol/server-everything",
    ]);

    await client.connect();

    const tools = (await client.listTools()) as { tools: { name: string }[] };
    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0].name).toBe("test-tool");

    const result = (await client.callTool("test-tool", { arg1: "val1" })) as {
      content: { text: string }[];
    };
    expect(result.content[0].text).toBe("tool result");

    await client.disconnect();
  });
});
