// SPDX-License-Identifier: Apache-2.0
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
import { SlidingWindowRateLimiter } from "./rate-limiter";
import type { EmergencyStopIngress } from "./emergency-stop-ingress";

/** HTTP route of the emergency STOP ALL (ADR-025; only with CONTROL_PLANE_ENABLED). */
export const CONTROL_STOP_ALL_PATH = "/control/stop-all";

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

// The in-memory sliding-window rate limiter lives in its own module (the
// emergency-stop ingress uses it too); re-exported here for API stability.
export { SlidingWindowRateLimiter } from "./rate-limiter";

/** The client address a rate limit is keyed by. */
function clientIpOf(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/**
 * Socket idle limit for short routes (`POST /control/stop-all`): a slow-read
 * client cannot hold the connection open.
 */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Socket idle limit for the routes that legitimately stay silent for as long
 * as a task runs: blocking A2A `message/send`, `message/stream` and the MCP
 * stream. Overridable with `longRequestTimeoutMs`.
 */
export const DEFAULT_LONG_REQUEST_TIMEOUT_MS = 900_000;
/** Largest body the A2A and MCP routes parse. */
const JSON_BODY_LIMIT = "1mb";
/** The stop-all body is only an optional short reason. */
const STOP_BODY_LIMIT = "16kb";

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
  /**
   * Emergency STOP ALL ingress (ADR-025). When set, `POST /control/stop-all`
   * is mounted (board token always required); unset ⇒ 404 (default-off).
   */
  emergencyStop?: EmergencyStopIngress;
  /**
   * Socket idle limit (ms) for the long-running routes (`/a2a/rpc`, MCP). Must
   * exceed the longest task wait, or a blocking `message/send` is cut mid-task.
   * Defaults to 15 minutes. `POST /control/stop-all` keeps a 30 s limit.
   */
  longRequestTimeoutMs?: number;
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
  private readonly emergencyStop?: EmergencyStopIngress;
  private readonly longRequestTimeoutMs: number;
  private rateLimiter = new SlidingWindowRateLimiter(60_000, 100);
  // Probe routes: 120/min per route per client (keyed route|ip), so Kubernetes
  // liveness + readiness + startup from one kubelet address never share a bucket,
  // still bounded so the Redis/broker checks cannot be flooded.
  private healthRateLimiter = new SlidingWindowRateLimiter(60_000, 120);

  constructor(deps: GatewayAppDeps) {
    this.requestHandler = deps.requestHandler;
    this.statusTracker = deps.statusTracker;
    const alwaysReady = (): Promise<ProbeResult> => Promise.resolve(READY);
    this.readinessProbe = deps.readinessProbe ?? alwaysReady;
    this.startupProbe = deps.startupProbe ?? alwaysReady;
    this.mcpHandler = deps.mcpHandler;
    this.mcpPath = deps.mcpPath ?? "/mcp";
    this.emergencyStop = deps.emergencyStop;
    this.longRequestTimeoutMs =
      deps.longRequestTimeoutMs ?? DEFAULT_LONG_REQUEST_TIMEOUT_MS;
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
    // No global body parser: each route parses its own body after the rate
    // limit (and auth), so unknown paths and anonymous callers cost no parsing.
    this.registerRoutes();
  }

  private registerRoutes(): void {
    this.app.use(this.requestLogger.bind(this));

    this.app.get(
      "/health",
      this.healthRateLimit.bind(this, "/health"),
      this.handleHealth.bind(this),
    );

    // k8s readiness + startup probes (Phase R) — readiness verifies Redis +
    // broker reachability; startup gates slow boot. 200 ready / 503 not-ready.
    this.app.get(
      "/ready",
      this.healthRateLimit.bind(this, "/ready"),
      this.handleProbe.bind(this, this.readinessProbe),
    );
    this.app.get(
      "/startup",
      this.healthRateLimit.bind(this, "/startup"),
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
      this.enforceRequestTimeout(this.longRequestTimeoutMs),
      express.json({ limit: JSON_BODY_LIMIT }),
      jsonRpcHandler({
        requestHandler: this.requestHandler,
        userBuilder: UserBuilder.noAuthentication,
      }),
    );

    // MCP Streamable-HTTP surface (Phase M) — only when a handler is provided.
    if (this.mcpHandler) this.registerMcpRoutes(this.mcpHandler);

    // Emergency STOP ALL (ADR-025) — only when the control plane is on. It is
    // not in the shared 100/min bucket: the ingress limits it itself, after
    // authentication, so other traffic from the same address cannot starve it.
    const emergencyStop = this.emergencyStop;
    if (emergencyStop) {
      this.app.post(
        CONTROL_STOP_ALL_PATH,
        this.enforceRequestTimeout(REQUEST_TIMEOUT_MS),
        express.json({ limit: STOP_BODY_LIMIT }),
        (req: Request, res: Response) => void this.handleStopAll(emergencyStop, req, res),
      );
    }

    this.app.use(this.rateLimit.bind(this), this.handleNotFound.bind(this));
    this.app.use(this.handleError.bind(this));
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
      this.enforceRequestTimeout(this.longRequestTimeoutMs),
      express.json({ limit: JSON_BODY_LIMIT }),
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
    const clientIp = clientIpOf(req);
    if (!this.rateLimiter.isAllowed(clientIp)) {
      res.status(429).json(apiError("Too Many Requests"));
      return;
    }
    next();
  }

  /** Per-route key: one probe route's traffic cannot exhaust another's bucket. */
  private healthRateLimit(
    route: string,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const clientIp = clientIpOf(req);
    if (!this.healthRateLimiter.isAllowed(`${route}|${clientIp}`)) {
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

  /**
   * Socket idle limit for one route — prevents slow-read attacks holding
   * connections open. Node destroys the socket after `ms` without traffic, so
   * routes that wait on a task need a limit longer than the task.
   */
  private enforceRequestTimeout(ms: number) {
    return (req: Request, _res: Response, next: NextFunction): void => {
      req.setTimeout(ms);
      next();
    };
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

  /** Map the ingress outcome to HTTP: 202 issued, else its refusal status. */
  private async handleStopAll(
    ingress: EmergencyStopIngress,
    req: Request,
    res: Response,
  ): Promise<void> {
    const header = req.headers["authorization"];
    const token =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : undefined;
    const clientIp = clientIpOf(req);
    try {
      const result = await ingress.stopAll(token, req.body, clientIp);
      if (result.ok) {
        const { commandId, issuedAt, saved } = result;
        res.status(202).json(apiOk({ commandId, issuedAt, saved }));
      } else {
        res.status(result.status).json(apiError(result.error));
      }
    } catch (err) {
      log.error({ err }, "Emergency stop failed");
      res.status(500).json(apiError("Emergency stop failed"));
    }
  }

  private handleNotFound(_req: Request, res: Response): void {
    res.status(404).json(apiError("Not Found"));
  }

  /**
   * Last resort: a malformed or oversized body (or any thrown error) gets a
   * short JSON answer, never Express's HTML page with a stack trace.
   */
  private handleError(
    err: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ): void {
    const status = (err as { status?: unknown } | null)?.status;
    if (status === 413) {
      res.status(413).json(apiError("Payload Too Large"));
    } else if (status === 400) {
      res.status(400).json(apiError("Bad Request"));
    } else {
      log.error({ err }, "Unhandled request error");
      res.status(500).json(apiError("Internal Server Error"));
    }
  }
}
