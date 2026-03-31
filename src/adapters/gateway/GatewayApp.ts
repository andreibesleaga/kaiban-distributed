import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'crypto';
import helmet from 'helmet';
import { A2AConnector, type JsonRpcRequest } from '../../infrastructure/federation/a2a-connector';
import { verifyA2AToken } from '../../infrastructure/security/a2a-auth';

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

export class GatewayApp {
  public readonly app: Application;
  private connector: A2AConnector;
  private rateLimiter = new SlidingWindowRateLimiter(60_000, 100);
  private healthRateLimiter = new SlidingWindowRateLimiter(60_000, 5);

  constructor(connector: A2AConnector, opts?: { trustProxy?: boolean }) {
    this.connector = connector;
    this.app = express();

    // Trust proxy — enables correct req.ip behind reverse proxies (Railway, Kubernetes, Nginx).
    // Must be set before any middleware that reads req.ip.
    if (opts?.trustProxy) this.app.set('trust proxy', 1);

    this.app.use(helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } },
      hsts: { maxAge: 63072000, includeSubDomains: true },
      referrerPolicy: { policy: 'no-referrer' },
    }));
    this.app.use(express.json({ limit: '1mb' }));
    this.registerRoutes();
  }

  private registerRoutes(): void {
    this.app.use(this.requestLogger.bind(this));
    this.app.get('/health', this.healthRateLimit.bind(this), this.handleHealth.bind(this));
    this.app.get('/.well-known/agent-card.json', this.handleAgentCard.bind(this));
    this.app.post('/a2a/rpc',
      this.rateLimit.bind(this),
      this.requireA2AAuth.bind(this),
      this.handleRpc.bind(this),
    );
    this.app.use(this.handleNotFound.bind(this));
  }

  private requestLogger(req: Request, res: Response, next: NextFunction): void {
    const requestId = randomUUID();
    res.on('finish', () => {
      console.log(`[${requestId}] ${req.method} ${req.path} ${res.statusCode}`);
    });
    next();
  }

  private rateLimit(req: Request, res: Response, next: NextFunction): void {
    const clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    if (!this.rateLimiter.isAllowed(clientIp)) {
      res.status(429).json(apiError('Too Many Requests'));
      return;
    }
    next();
  }

  private healthRateLimit(req: Request, res: Response, next: NextFunction): void {
    const clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    if (!this.healthRateLimiter.isAllowed(clientIp)) {
      res.status(429).json(apiError('Too Many Requests'));
      return;
    }
    next();
  }

  /**
   * A2A bearer token auth middleware.
   * Gated: only enforced when A2A_JWT_SECRET is set (backwards-compatible).
   */
  private requireA2AAuth(req: Request, res: Response, next: NextFunction): void {
    if (!process.env['A2A_JWT_SECRET']) return next(); // auth disabled
    try {
      verifyA2AToken(req.headers['authorization']);
      next();
    } catch {
      res.status(401).json(apiError('Unauthorized'));
    }
  }

  private handleHealth(_req: Request, res: Response): void {
    res.json(apiOk({ status: 'ok', timestamp: new Date().toISOString() }));
  }

  private handleAgentCard(_req: Request, res: Response): void {
    res.json(this.connector.getAgentCard());
  }

  private async handleRpc(req: Request, res: Response): Promise<void> {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      res.status(415).json(apiError('Content-Type must be application/json'));
      return;
    }

    // Request timeout — prevent slow-read attacks holding connections
    req.setTimeout(REQUEST_TIMEOUT_MS);

    const result = await this.connector.handleRpc(req.body as JsonRpcRequest);
    if (result.ok) {
      res.json(result.value);
    } else {
      // Sanitize internal error details in production
      const isDev = process.env['NODE_ENV'] !== 'production';
      const publicMsg = isDev ? result.error.message : 'Internal server error';
      res.status(500).json(apiError(publicMsg));
    }
  }

  private handleNotFound(_req: Request, res: Response): void {
    res.status(404).json(apiError('Not Found'));
  }
}
