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
  type McpSessionLimits,
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

async function startStack(
  deps = makeDeps(),
  limits?: McpSessionLimits,
): Promise<Stack> {
  const handler = createMcpHttpHandler(deps, limits);
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

describe("createMcpHttpHandler — bounded sessions (SEC-07)", () => {
  const initialize = (baseUrl: string): Promise<Response> =>
    fetch(`${baseUrl}${PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "c", version: "0" },
        },
      }),
    });

  afterEach(() => vi.restoreAllMocks());

  it("refuses an initialize above maxSessions with 503", async () => {
    const stack = await startStack(makeDeps(), { maxSessions: 2 });
    expect((await initialize(stack.baseUrl)).status).toBe(200);
    expect((await initialize(stack.baseUrl)).status).toBe(200);
    const third = await initialize(stack.baseUrl);
    expect(third.status).toBe(503);
    expect((await third.json()).error.message).toBe("Too many MCP sessions");
    expect(stack.handler.sessionCount()).toBe(2);
  });

  it("closes sessions idle past the timeout when the next one opens", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const stack = await startStack(makeDeps(), { idleTimeoutMs: 1_000, maxSessions: 2 });
    await initialize(stack.baseUrl);
    await initialize(stack.baseUrl);
    now += 1_500;
    expect((await initialize(stack.baseUrl)).status).toBe(200);
    expect(stack.handler.sessionCount()).toBe(1); // both idle ones went, the new one is live
  });

  it("a request on a session keeps it alive (POST and GET both count as use)", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const stack = await startStack(makeDeps(), { idleTimeoutMs: 1_000 });
    const first = await initialize(stack.baseUrl);
    const sid = first.headers.get("mcp-session-id")!;
    now += 800;
    const del = await fetch(`${stack.baseUrl}${PATH}`, {
      method: "GET",
      headers: { "mcp-session-id": sid, accept: "text/event-stream" },
      signal: AbortSignal.timeout(300),
    }).catch(() => undefined);
    void del;
    await fetch(`${stack.baseUrl}${PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sid,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    now += 800; // 1600 ms since opening, 800 since the last request
    await initialize(stack.baseUrl);
    expect(stack.handler.sessionCount()).toBe(2);
  });

  it("an error while closing an idle session is logged, not thrown", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const stack = await startStack(makeDeps(), { idleTimeoutMs: 1_000 });
    await initialize(stack.baseUrl);
    const sessions = (stack.handler as unknown as { sessions: Map<string, { transport: { close: () => Promise<void> } }> }).sessions;
    for (const s of sessions.values()) s.transport.close = (): Promise<void> => Promise.reject(new Error("boom"));
    now += 2_000;
    expect((await initialize(stack.baseUrl)).status).toBe(200);
    expect(stack.handler.sessionCount()).toBe(1);
  });
});
