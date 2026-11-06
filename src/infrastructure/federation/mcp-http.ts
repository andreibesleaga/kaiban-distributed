// SPDX-License-Identifier: Apache-2.0
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
 * Sessions are bounded: one idle for `idleTimeoutMs` (default 30 min) is closed
 * the next time a session is opened, and above `maxSessions` (default 200) an
 * `initialize` is refused with 503. Clients that never send DELETE therefore
 * cannot grow the gateway's memory without limit.
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
/** A session with no request for this long is closed when the next one opens. */
export const MCP_SESSION_IDLE_MS = 30 * 60_000;
/** Live sessions at most; above it `initialize` gets 503. */
export const MCP_MAX_SESSIONS = 200;

interface McpSession {
  transport: StreamableHTTPServerTransport;
  close(): Promise<void>;
  /** Epoch ms of the session's last request. */
  lastSeenAt: number;
}

export interface McpSessionLimits {
  idleTimeoutMs?: number;
  maxSessions?: number;
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

  private readonly idleTimeoutMs: number;
  private readonly maxSessions: number;

  constructor(
    private readonly deps: McpServerDeps,
    limits: McpSessionLimits = {},
  ) {
    this.idleTimeoutMs = limits.idleTimeoutMs ?? MCP_SESSION_IDLE_MS;
    this.maxSessions = limits.maxSessions ?? MCP_MAX_SESSIONS;
  }

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
      existing.lastSeenAt = Date.now();
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
    existing.lastSeenAt = Date.now();
    return existing.transport.handleRequest(req, res);
  }

  private async openSession(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody: unknown,
  ): Promise<void> {
    await this.closeIdleSessions();
    if (this.sessions.size >= this.maxSessions) {
      log.warn({ max: this.maxSessions }, "MCP session limit reached");
      return jsonRpcError(res, 503, "Too many MCP sessions");
    }
    const server = buildMcpServer(this.deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: (): string => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId): void => {
        this.sessions.set(sessionId, {
          transport,
          close: (): Promise<void> => server.close(),
          lastSeenAt: Date.now(),
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

  /** Close every session that has been idle for `idleTimeoutMs`. */
  private async closeIdleSessions(): Promise<void> {
    const cutoff = Date.now() - this.idleTimeoutMs;
    for (const [id, session] of [...this.sessions]) {
      if (session.lastSeenAt >= cutoff) continue;
      this.sessions.delete(id);
      log.info({ sessionId: id }, "MCP session closed (idle)");
      try {
        await session.transport.close();
        await session.close();
      } catch (err) {
        log.warn({ err, sessionId: id }, "Closing an idle MCP session failed");
      }
    }
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
export function createMcpHttpHandler(
  deps: McpServerDeps,
  limits?: McpSessionLimits,
): McpHttpHandler {
  return new StreamableMcpHandler(deps, limits);
}
