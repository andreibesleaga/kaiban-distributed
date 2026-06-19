/**
 * MCP Streamable-HTTP session handler (master plan §B5.1 Phase M, ADR-017).
 *
 * Bridges the gateway's Express surface to the MCP `StreamableHTTPServerTransport`.
 * Runs in STATEFUL mode (one transport + `McpServer` per session) so server→client
 * requests — notably elicitation consent — can round-trip within a session:
 *   - POST   with an `initialize` body and no session  → create a session
 *   - POST   with a known `mcp-session-id`             → route to that session
 *   - GET    with a known session                      → open the notification stream
 *   - DELETE with a known session                      → terminate the session
 * Unknown / missing sessions are rejected with a JSON-RPC error. `enableJsonResponse`
 * keeps responses plain JSON (no lingering SSE) — this is an internal RPC surface,
 * not a streaming one. Mounted behind the gateway's helmet + rate-limit + JWT chain.
 *
 * Session lifecycle uses the transport's `onsessioninitialized` / `onsessionclosed`
 * callbacks (each handed a guaranteed session id) rather than the nullable
 * `transport.sessionId`, so registration and teardown are exact.
 */
import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer, type McpServerDeps } from "./mcp-server";
import { createStructuredLogger } from "../../shared/structured-logger";

const log = createStructuredLogger({ component: "McpHttp" });

const SESSION_HEADER = "mcp-session-id";

interface McpSession {
  transport: StreamableHTTPServerTransport;
  close(): Promise<void>;
}

export interface McpHttpHandler {
  /** Handle a POST (initialize → new session, or a routed request). */
  handlePost(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void>;
  /** Handle a GET (notification stream) or DELETE (terminate) on an existing session. */
  handleSession(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Number of live sessions (observability/tests). */
  sessionCount(): number;
  /** Tear down every live session (graceful shutdown). */
  close(): Promise<void>;
}

function sessionIdOf(req: IncomingMessage): string | undefined {
  const value = req.headers[SESSION_HEADER];
  return Array.isArray(value) ? value[0] : value;
}

function jsonRpcError(
  res: ServerResponse,
  status: number,
  message: string,
): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

class StreamableMcpHandler implements McpHttpHandler {
  private readonly sessions = new Map<string, McpSession>();

  constructor(private readonly deps: McpServerDeps) {}

  public sessionCount(): number {
    return this.sessions.size;
  }

  public async handlePost(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> {
    const sessionId = sessionIdOf(req);
    if (sessionId !== undefined) {
      const existing = this.sessions.get(sessionId);
      if (!existing) return jsonRpcError(res, 404, "Unknown MCP session");
      return existing.transport.handleRequest(req, res, parsedBody);
    }
    if (!isInitializeRequest(parsedBody)) {
      return jsonRpcError(
        res,
        400,
        "Missing mcp-session-id (only an initialize request may open a session)",
      );
    }
    await this.openSession(req, res, parsedBody);
  }

  public async handleSession(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const sessionId = sessionIdOf(req);
    const existing =
      sessionId !== undefined ? this.sessions.get(sessionId) : undefined;
    if (!existing) return jsonRpcError(res, 404, "Unknown MCP session");
    return existing.transport.handleRequest(req, res);
  }

  private async openSession(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody: unknown,
  ): Promise<void> {
    const server = buildMcpServer(this.deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: (): string => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId): void => {
        this.sessions.set(sessionId, {
          transport,
          close: (): Promise<void> => server.close(),
        });
        log.info({ sessionId }, "MCP session opened");
      },
      onsessionclosed: (sessionId): void => {
        this.sessions.delete(sessionId);
        log.info({ sessionId }, "MCP session closed");
      },
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  }

  public async close(): Promise<void> {
    const live = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of live) {
      await session.transport.close();
      await session.close();
    }
  }
}

/**
 * Create the gateway-mountable MCP Streamable-HTTP handler. The returned object's
 * `handlePost`/`handleSession` wire to Express routes; `close()` runs on drain.
 */
export function createMcpHttpHandler(deps: McpServerDeps): McpHttpHandler {
  return new StreamableMcpHandler(deps);
}
