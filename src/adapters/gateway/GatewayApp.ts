import express, {
  type Application,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomUUID } from "crypto";
import helmet from "helmet";
import {
  jsonRpcHandler,
  agentCardHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";
import type { A2ARequestHandler } from "@a2a-js/sdk/server";
import { verifyA2AToken } from "../../infrastructure/security/a2a-auth";
import type { AgentStatusTracker } from "../../infrastructure/federation/agent-status-tracker";
import type { McpHttpHandler } from "../../infrastructure/federation/mcp-http";
import type { ProbeResult } from "../../resilience/health";
import { createStructuredLogger } from "../../shared/structured-logger";

const log = createStructuredLogger({ component: "GatewayApp" });

interface ApiResponse<T> {
  data: T | null;
  meta: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function apiOk<T>(data: T): ApiResponse<T> {
  return { data, meta: {}, errors: [] };
}

function apiError(message: string): ApiResponse<null> {
  return { data: null, meta: {}, errors: [{ message }] };
}

// ── In-memory sliding-window rate limiter (zero-dependency) ──────────

export class SlidingWindowRateLimiter {
  private windows = new Map<string, number[]>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly maxRequests = 100,
  ) {}

  isAllowed(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }
    // Evict expired entries
    while (timestamps.length > 0 && timestamps[0]! < cutoff) {
      timestamps.shift();
    }
    // Prune dead keys to prevent unbounded Map growth under IP-spray attacks.
    // Replace the stale array with a fresh one (also handles brand-new keys correctly).
    if (timestamps.length === 0) {
      const fresh = [now];
      this.windows.set(key, fresh);
      return true;
    }
    if (timestamps.length >= this.maxRequests) return false;
    timestamps.push(now);
    return true;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

export interface GatewayAppDeps {
  /** The SDK A2A request handler (e.g. DefaultRequestHandler) the JSON-RPC + card routes wrap. */
  requestHandler: A2ARequestHandler;
  /** Tracks the real, last-known status of each agent (de-stubs `agent.status`). */
  statusTracker: Pick<AgentStatusTracker, "getStatus" | "hasSeen">;
  /** Enable Express trust-proxy (correct req.ip behind a reverse proxy). */
  trustProxy?: boolean;
  /**
   * Readiness probe for `GET /ready` (k8s readiness — Phase R). Verifies Redis +
   * broker reachability; 200 when ready, 503 otherwise. Unset ⇒ always ready.
   */
  readinessProbe?: () => Promise<ProbeResult>;
  /**
   * Startup probe for `GET /startup` (k8s startup — Phase R). Gates slow boot;
   * 200 once boot completes, 503 until then. Unset ⇒ always ready.
   */
  startupProbe?: () => Promise<ProbeResult>;
  /**
   * MCP Streamable-HTTP handler (Phase M). When set, the gateway mounts
   * POST/GET/DELETE at `mcpPath` behind the same helmet + rate-limit + JWT chain.
   * Unset ⇒ the MCP surface is not exposed (default-off).
   */
  mcpHandler?: McpHttpHandler;
  /** Path the MCP surface is mounted at (defaults to `/mcp`). */
  mcpPath?: string;
}

const READY: ProbeResult = { ready: true, checks: [] };

/**
 * GatewayApp — the HTTP front door for the A2A surface.
 *
 * It owns the security middleware chain (helmet, per-IP rate limiting, env-gated
 * JWT auth, request timeout) and mounts the official `@a2a-js/sdk` Express
 * middlewares behind it:
 *   - `agentCardHandler` at `/.well-known/agent-card.json`
 *   - `jsonRpcHandler`   at `/a2a/rpc` (message/send, message/stream, tasks/get, tasks/cancel)
 * plus a real `GET /a2a/agents/:agentId/status` endpoint served from the status
 * tracker (replacing the old hardcoded `IDLE`).
 *
 * The custom `A2AConnector` is gone — the SDK is the single source of A2A wire
 * conformance; this class is just the secured Express shell around it.
 */
export class GatewayApp {
  public readonly app: Application;
  private readonly requestHandler: A2ARequestHandler;
  private readonly statusTracker: Pick<
    AgentStatusTracker,
    "getStatus" | "hasSeen"
  >;
  private readonly readinessProbe: () => Promise<ProbeResult>;
  private readonly startupProbe: () => Promise<ProbeResult>;
  private readonly mcpHandler?: McpHttpHandler;
  private readonly mcpPath: string;
  private rateLimiter = new SlidingWindowRateLimiter(60_000, 100);
  private healthRateLimiter = new SlidingWindowRateLimiter(60_000, 5);

  constructor(deps: GatewayAppDeps) {
    this.requestHandler = deps.requestHandler;
    this.statusTracker = deps.statusTracker;
    const alwaysReady = (): Promise<ProbeResult> => Promise.resolve(READY);
    this.readinessProbe = deps.readinessProbe ?? alwaysReady;
    this.startupProbe = deps.startupProbe ?? alwaysReady;
    this.mcpHandler = deps.mcpHandler;
    this.mcpPath = deps.mcpPath ?? "/mcp";
    this.app = express();

    // Trust proxy — enables correct req.ip behind reverse proxies (Railway, K8s, Nginx).
    // Must be set before any middleware that reads req.ip.
    if (deps.trustProxy) this.app.set("trust proxy", 1);

    this.app.use(
      helmet({
        contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } },
        hsts: { maxAge: 63072000, includeSubDomains: true },
        referrerPolicy: { policy: "no-referrer" },
      }),
    );
    this.app.use(express.json({ limit: "1mb" }));
    this.registerRoutes();
  }

  private registerRoutes(): void {
    this.app.use(this.requestLogger.bind(this));

    this.app.get(
      "/health",
      this.healthRateLimit.bind(this),
      this.handleHealth.bind(this),
    );

    // k8s readiness + startup probes (Phase R) — readiness verifies Redis +
    // broker reachability; startup gates slow boot. 200 ready / 503 not-ready.
    this.app.get(
      "/ready",
      this.healthRateLimit.bind(this),
      this.handleProbe.bind(this, this.readinessProbe),
    );
    this.app.get(
      "/startup",
      this.healthRateLimit.bind(this),
      this.handleProbe.bind(this, this.startupProbe),
    );

    // A2A AgentCard — served by the SDK from the same handler that answers RPC.
    this.app.use(
      "/.well-known/agent-card.json",
      agentCardHandler({ agentCardProvider: this.requestHandler }),
    );

    // Real `agent.status` (de-stubbed) — last-known status from the state stream.
    this.app.get(
      "/a2a/agents/:agentId/status",
      this.rateLimit.bind(this),
      this.handleAgentStatus.bind(this),
    );

    // A2A JSON-RPC — security middleware in front, then the SDK's handler.
    this.app.use(
      "/a2a/rpc",
      this.rateLimit.bind(this),
      this.requireA2AAuth.bind(this),
      this.enforceRequestTimeout.bind(this),
      jsonRpcHandler({
        requestHandler: this.requestHandler,
        userBuilder: UserBuilder.noAuthentication,
      }),
    );

    // MCP Streamable-HTTP surface (Phase M) — only when a handler is provided.
    if (this.mcpHandler) this.registerMcpRoutes(this.mcpHandler);

    this.app.use(this.handleNotFound.bind(this));
  }

  /**
   * Mount the MCP surface behind the same security chain as A2A: per-IP rate
   * limiting then env-gated JWT auth. POST opens/uses a session; GET streams
   * notifications; DELETE terminates a session.
   */
  private registerMcpRoutes(handler: McpHttpHandler): void {
    const chain = [
      this.rateLimit.bind(this),
      this.requireA2AAuth.bind(this),
      this.enforceRequestTimeout.bind(this),
    ];
    this.app.post(this.mcpPath, ...chain, (req: Request, res: Response) => {
      void handler.handlePost(req, res, req.body);
    });
    this.app.get(this.mcpPath, ...chain, (req: Request, res: Response) => {
      void handler.handleSession(req, res);
    });
    this.app.delete(this.mcpPath, ...chain, (req: Request, res: Response) => {
      void handler.handleSession(req, res);
    });
  }

  private requestLogger(req: Request, res: Response, next: NextFunction): void {
    const requestId = randomUUID();
    res.on("finish", () => {
      log.info(
        {
          requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
        },
        "request",
      );
    });
    next();
  }

  private rateLimit(req: Request, res: Response, next: NextFunction): void {
    const clientIp = req.ip ?? req.socket.remoteAddress ?? "unknown";
    if (!this.rateLimiter.isAllowed(clientIp)) {
      res.status(429).json(apiError("Too Many Requests"));
      return;
    }
    next();
  }

  private healthRateLimit(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const clientIp = req.ip ?? req.socket.remoteAddress ?? "unknown";
    if (!this.healthRateLimiter.isAllowed(clientIp)) {
      res.status(429).json(apiError("Too Many Requests"));
      return;
    }
    next();
  }

  /**
   * A2A bearer token auth middleware.
   * Gated: only enforced when A2A_JWT_SECRET is set (backwards-compatible).
   */
  private requireA2AAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (!process.env["A2A_JWT_SECRET"]) return next(); // auth disabled
    try {
      verifyA2AToken(req.headers["authorization"]);
      next();
    } catch {
      res.status(401).json(apiError("Unauthorized"));
    }
  }

  /** Request timeout — prevent slow-read attacks holding connections open. */
  private enforceRequestTimeout(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    req.setTimeout(REQUEST_TIMEOUT_MS);
    next();
  }

  private handleHealth(_req: Request, res: Response): void {
    res.json(apiOk({ status: "ok", timestamp: new Date().toISOString() }));
  }

  /** Run a probe and map readiness to the HTTP contract (200 ready / 503 not). */
  private async handleProbe(
    probe: () => Promise<ProbeResult>,
    _req: Request,
    res: Response,
  ): Promise<void> {
    const result = await probe();
    res.status(result.ready ? 200 : 503).json(apiOk(result));
  }

  private handleAgentStatus(req: Request, res: Response): void {
    // The `:agentId` route param is always present for a matched route.
    const agentId = String(req.params["agentId"]);
    res.json(
      apiOk({
        agentId,
        status: this.statusTracker.getStatus(agentId),
        seen: this.statusTracker.hasSeen(agentId),
      }),
    );
  }

  private handleNotFound(_req: Request, res: Response): void {
    res.status(404).json(apiError("Not Found"));
  }
}
