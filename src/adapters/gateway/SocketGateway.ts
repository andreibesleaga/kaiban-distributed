import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type Redis from 'ioredis';
import { STATE_CHANNEL, STATE_EVENT_UPDATE, STATE_EVENT_REQUEST, HITL_CHANNEL, HITL_SOCKET_EVENT } from '../../infrastructure/messaging/channels';
import { verifyBoardToken } from '../../infrastructure/security/board-auth';
import { unwrapVerified } from '../../infrastructure/security/channel-signing';

const STATE_EVENT = STATE_EVENT_UPDATE;
const DEFAULT_DECISIONS = ['PUBLISH', 'REVISE', 'REJECT', 'VIEW'];

/**
 * Accumulated state snapshot.
 * Merged from every delta received on kaiban-state-events since gateway start.
 * Sent to each newly connected / reconnected board client so it sees the full
 * current picture immediately — not just future incremental deltas.
 */
interface StateSnapshot {
  teamWorkflowStatus?: string;
  agents: Map<string, Record<string, unknown>>;
  tasks: Map<string, Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
}

export class SocketGateway {
  private io: SocketIOServer | null = null;
  private httpServer: HttpServer;
  private redisPublisher: Redis;
  private redisSubscriber: Redis;
  private validDecisions: string[];

  /** Running state snapshot — gate truth for reconnecting clients */
  private snapshot: StateSnapshot = { agents: new Map(), tasks: new Map() };

  constructor(
    httpServer: HttpServer,
    redisPublisher: Redis,
    redisSubscriber: Redis,
    opts?: { validHitlDecisions?: string[] },
  ) {
    this.httpServer = httpServer;
    this.redisPublisher = redisPublisher;
    this.redisSubscriber = redisSubscriber;
    this.validDecisions = opts?.validHitlDecisions ?? DEFAULT_DECISIONS;
  }

  // ─── Snapshot helpers ────────────────────────────────────────────────────

  private applyStatusUpdate(delta: Record<string, unknown>): void {
    const newStatus = typeof delta['teamWorkflowStatus'] === 'string'
      ? delta['teamWorkflowStatus'] : undefined;
    if (newStatus === undefined) return;
    // When a workflow restarts from a terminal state, clear stale tasks
    const prev = this.snapshot.teamWorkflowStatus;
    if (newStatus === 'RUNNING' && (prev === 'FINISHED' || prev === 'STOPPED' || prev === 'ERRORED')) {
      this.snapshot.tasks.clear();
    }
    this.snapshot.teamWorkflowStatus = newStatus;
  }

  private applyMapDelta(
    delta: Record<string, unknown>,
    field: string,
    idKey: string,
    map: Map<string, Record<string, unknown>>,
  ): void {
    if (!Array.isArray(delta[field])) return;
    for (const item of delta[field] as Record<string, unknown>[]) {
      const id = item[idKey];
      if (typeof id === 'string') {
        map.set(id, { ...(map.get(id) ?? {}), ...item });
      }
    }
  }

  private applyToSnapshot(delta: Record<string, unknown>): void {
    this.applyStatusUpdate(delta);
    this.applyMapDelta(delta, 'agents', 'agentId', this.snapshot.agents);
    this.applyMapDelta(delta, 'tasks', 'taskId', this.snapshot.tasks);
    if (delta['metadata'] !== null && typeof delta['metadata'] === 'object') {
      this.snapshot.metadata = { ...(this.snapshot.metadata ?? {}), ...(delta['metadata'] as Record<string, unknown>) };
    }
    if (delta['inputs'] !== null && typeof delta['inputs'] === 'object') {
      this.snapshot.inputs = { ...(this.snapshot.inputs ?? {}), ...(delta['inputs'] as Record<string, unknown>) };
    }
  }

  private buildSnapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (this.snapshot.teamWorkflowStatus !== undefined) {
      out['teamWorkflowStatus'] = this.snapshot.teamWorkflowStatus;
    }
    if (this.snapshot.agents.size > 0) {
      out['agents'] = Array.from(this.snapshot.agents.values());
    }
    if (this.snapshot.tasks.size > 0) {
      out['tasks'] = Array.from(this.snapshot.tasks.values());
    }
    if (this.snapshot.metadata !== undefined) {
      out['metadata'] = this.snapshot.metadata;
    }
    if (this.snapshot.inputs !== undefined) {
      out['inputs'] = this.snapshot.inputs;
    }
    return out;
  }

  private sendSnapshot(socket: Socket): void {
    const snap = this.buildSnapshot();
    if (Object.keys(snap).length > 0) {
      socket.emit(STATE_EVENT, snap);
    }
  }

  // ─── Initialisation ───────────────────────────────────────────────────────

  public initialize(): void {
    const rawOrigins = process.env['SOCKET_CORS_ORIGINS'];
    if (!rawOrigins && process.env['NODE_ENV'] === 'production') {
      throw new Error('SOCKET_CORS_ORIGINS must be set in production — refusing wildcard CORS');
    }
    const allowedOrigins = rawOrigins?.split(',').map((s) => s.trim()) ?? ['*'];

    this.io = new SocketIOServer(this.httpServer, {
      cors: { origin: allowedOrigins, credentials: true },
      maxHttpBufferSize: 1e6,       // 1 MB — prevent oversized WebSocket frames
      pingTimeout: 20_000,          // Disconnect dead clients after 20s without pong
      pingInterval: 25_000,         // Ping every 25s to detect dead connections
    });
    this.io.adapter(createAdapter(this.redisPublisher, this.redisSubscriber));

    // Auth middleware — runs before any 'connection' handler.
    // Gated: only enforced when BOARD_JWT_SECRET is set.
    this.io.use((socket, next) => {
      if (!process.env['BOARD_JWT_SECRET']) return next(); // auth disabled
      try {
        const token = socket.handshake.auth['token'] as string | undefined;
        if (!token) return next(new Error('Missing board token'));
        const payload = verifyBoardToken(token);
        socket.data['exp'] = payload['exp'];
        next();
      } catch {
        next(new Error('Invalid or expired board token'));
      }
    });

    this.io.on('connection', (socket: Socket) => {
      // Enforce token expiry on long-running connections
      const exp = socket.data['exp'] as number | undefined;
      if (exp !== undefined) {
        const msUntilExpiry = exp * 1000 - Date.now();
        if (msUntilExpiry <= 0) {
          socket.disconnect(true);
          return;
        }
        setTimeout(() => socket.disconnect(true), msUntilExpiry);
      }

      // Replay current full state to newly connected / reconnected client
      this.sendSnapshot(socket);

      // Client can explicitly request a state refresh (e.g. after reconnect)
      socket.on(STATE_EVENT_REQUEST, () => this.sendSnapshot(socket));

      // Forward HITL decisions from board → Redis → orchestrator.
      // The optional ack callback lets the board confirm delivery end-to-end.
      socket.on(HITL_SOCKET_EVENT, (payload: unknown, ack?: (response: { ok: boolean; error?: string }) => void) => {
        if (typeof payload !== 'object' || payload === null) {
          ack?.({ ok: false, error: 'invalid payload' });
          return;
        }
        const { taskId, decision } = payload as Record<string, unknown>;
        if (typeof taskId !== 'string' || typeof decision !== 'string') {
          ack?.({ ok: false, error: 'invalid taskId or decision' });
          return;
        }
        if (!this.validDecisions.includes(decision)) {
          ack?.({ ok: false, error: `invalid decision value: ${decision}` });
          return;
        }
        console.log(`[SocketGateway] HITL decision received: ${String(decision)} for task ${taskId.slice(-8)}`);
        this.redisPublisher.publish(HITL_CHANNEL, JSON.stringify({ taskId, decision }))
          .then(() => {
            console.log(`[SocketGateway] HITL decision forwarded to Redis: ${String(decision)}`);
            ack?.({ ok: true });
          })
          .catch((err: unknown) => {
            console.error('[SocketGateway] Failed to publish HITL decision to Redis:', err);
            ack?.({ ok: false, error: 'Redis publish failed' });
          });
      });
    });

    this.redisSubscriber.subscribe(STATE_CHANNEL);
    this.redisSubscriber.on('message', (_channel: string, data: string) => {
      try {
        const parsed = unwrapVerified(data);
        if (!parsed) {
          console.warn('[SocketGateway] Rejected unsigned/invalid channel message');
          return;
        }
        this.applyToSnapshot(parsed);          // keep snapshot current
        this.io?.emit(STATE_EVENT, parsed);    // broadcast incremental delta to all
      } catch {
        console.error('[SocketGateway] Failed to parse state message');
      }
    });
  }

  public async shutdown(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.io) {
        this.io.close(() => resolve());
      } else {
        resolve();
      }
    });
    await this.redisPublisher.quit();
    await this.redisSubscriber.quit();
  }
}
