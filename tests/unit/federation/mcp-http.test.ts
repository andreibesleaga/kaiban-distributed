/**
 * MCP Streamable-HTTP session handler (master plan §B5.1 Phase M, ADR-017).
 *
 * Stands the handler up behind a real Express app on an ephemeral port and drives
 * it with the official `StreamableHTTPClientTransport` — a genuine session
 * lifecycle (initialize → call → terminate) with zero brokers — then exercises the
 * rejection paths (unknown / missing session) with raw HTTP, and `close()` teardown.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createMcpHttpHandler,
  type McpHttpHandler,
} from "../../../src/infrastructure/federation/mcp-http";
import type { McpServerDeps } from "../../../src/infrastructure/federation/mcp-server";

const PATH = "/mcp";

function makeDeps(): McpServerDeps {
  return {
    dispatchTask: vi.fn(async () => ({ taskId: "t1", status: "DOING" })),
    listAgents: vi.fn(() => [{ id: "researcher", status: "IDLE" }]),
    getAgentStatus: vi.fn((agentId: string) => ({
      agentId,
      status: "IDLE",
      seen: false,
    })),
  };
}

interface Stack {
  handler: McpHttpHandler;
  baseUrl: string;
  server: Server;
}

const stacks: Stack[] = [];

afterEach(async () => {
  while (stacks.length) {
    const s = stacks.pop()!;
    await s.handler.close();
    await new Promise<void>((resolve) => s.server.close(() => resolve()));
  }
});

async function startStack(deps = makeDeps()): Promise<Stack> {
  const handler = createMcpHttpHandler(deps);
  const app = express();
  app.use(express.json());
  app.post(PATH, (req, res) => void handler.handlePost(req, res, req.body));
  app.get(PATH, (req, res) => void handler.handleSession(req, res));
  app.delete(PATH, (req, res) => void handler.handleSession(req, res));

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const stack = { handler, server, baseUrl: `http://127.0.0.1:${port}` };
  stacks.push(stack);
  return stack;
}

describe("createMcpHttpHandler — session lifecycle", () => {
  it("initializes, serves a request, and terminates a session over HTTP", async () => {
    const stack = await startStack();
    const client = new Client({ name: "c", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${stack.baseUrl}${PATH}`),
    );

    await client.connect(transport);
    expect(stack.handler.sessionCount()).toBe(1);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("dispatch_task");

    // Explicit termination sends DELETE → onsessionclosed → the session is reaped.
    await transport.terminateSession();
    expect(stack.handler.sessionCount()).toBe(0);
    await client.close().catch(() => undefined);
  });

  it("rejects a POST that carries an unknown session id with 404", async () => {
    const stack = await startStack();
    const res = await fetch(`${stack.baseUrl}${PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": "does-not-exist",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toContain("Unknown MCP session");
  });

  it("rejects a sessionless non-initialize POST with 400", async () => {
    const stack = await startStack();
    const res = await fetch(`${stack.baseUrl}${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("Missing mcp-session-id");
  });

  it("rejects a GET/DELETE without a session with 404", async () => {
    const stack = await startStack();
    const getRes = await fetch(`${stack.baseUrl}${PATH}`, { method: "GET" });
    expect(getRes.status).toBe(404);
    const delRes = await fetch(`${stack.baseUrl}${PATH}`, {
      method: "DELETE",
      headers: { "mcp-session-id": "nope" },
    });
    expect(delRes.status).toBe(404);
  });

  it("reads the session id from an array-valued header", async () => {
    const stack = await startStack();
    // Node can surface a repeated header as an array; exercise that branch directly.
    const req = { headers: { "mcp-session-id": ["ghost", "extra"] } };
    let status = 0;
    const sink = { end: (): void => undefined };
    const res = {
      writeHead: (code: number): { end: () => void } => {
        status = code;
        return sink;
      },
    };
    await stack.handler.handlePost(
      req as never,
      res as never,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
    );
    // 'ghost' is not a live session → 404 (proves the array element was read).
    expect(status).toBe(404);
  });

  it("close() tears down a live session", async () => {
    const stack = await startStack();
    const client = new Client({ name: "c", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${stack.baseUrl}${PATH}`),
    );
    await client.connect(transport);
    expect(stack.handler.sessionCount()).toBe(1);

    await stack.handler.close();
    expect(stack.handler.sessionCount()).toBe(0);
    await client.close().catch(() => undefined);
  });
});
