import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { A2AConnector, type JsonRpcRequest } from '../../infrastructure/federation/a2a-connector';

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

export class GatewayApp {
  public readonly app: Application;
  private connector: A2AConnector;

  constructor(connector: A2AConnector) {
    this.connector = connector;
    this.app = express();
    this.app.use(express.json());
    this.registerRoutes();
  }

  private registerRoutes(): void {
    this.app.use(this.requestLogger.bind(this));
    this.app.get('/health', this.handleHealth.bind(this));
    this.app.get('/.well-known/agent-card.json', this.handleAgentCard.bind(this));
    this.app.post('/a2a/rpc', this.handleRpc.bind(this));
    this.app.use(this.handleNotFound.bind(this));
  }

  private requestLogger(req: Request, res: Response, next: NextFunction): void {
    const requestId = randomUUID();
    res.on('finish', () => {
      console.log(`[${requestId}] ${req.method} ${req.path} ${res.statusCode}`);
    });
    next();
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

    const result = await this.connector.handleRpc(req.body as JsonRpcRequest);
    if (result.ok) {
      res.json(result.value);
    } else {
      res.status(500).json(apiError(result.error.message));
    }
  }

  private handleNotFound(_req: Request, res: Response): void {
    res.status(404).json(apiError('Not Found'));
  }
}
