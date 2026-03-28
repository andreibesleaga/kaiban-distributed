import { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type Redis from 'ioredis';
import { STATE_CHANNEL, STATE_EVENT_UPDATE } from '../../infrastructure/messaging/channels';

const STATE_EVENT = STATE_EVENT_UPDATE;

export class SocketGateway {
  private io: SocketIOServer | null = null;
  private httpServer: HttpServer;
  private redisPublisher: Redis;
  private redisSubscriber: Redis;

  constructor(httpServer: HttpServer, redisPublisher: Redis, redisSubscriber: Redis) {
    this.httpServer = httpServer;
    this.redisPublisher = redisPublisher;
    this.redisSubscriber = redisSubscriber;
  }

  public initialize(): void {
    // SECURITY WARNING: The wildcard origin '*' is used here for local
    // development convenience ONLY. In production, replace with an explicit
    // allowlist of trusted origins, e.g.:
    //   cors: { origin: ['https://your-dashboard.example.com'] }
    this.io = new SocketIOServer(this.httpServer, {
      cors: { origin: '*' },
      maxHttpBufferSize: 1e6,       // 1 MB — prevent oversized WebSocket frames
      pingTimeout: 20_000,          // Disconnect dead clients after 20s without pong
      pingInterval: 25_000,         // Ping every 25s to detect dead connections
    });
    this.io.adapter(createAdapter(this.redisPublisher, this.redisSubscriber));

    this.redisSubscriber.subscribe(STATE_CHANNEL);
    this.redisSubscriber.on('message', (_channel: string, data: string) => {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        this.io?.emit(STATE_EVENT, parsed);
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
