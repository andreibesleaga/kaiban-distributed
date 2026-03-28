import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'http';
import jwt from 'jsonwebtoken';

const BOARD_SECRET = 'test-board-secret-32bytes-padded!!';

function makeToken(secret = BOARD_SECRET, expiresIn = 3600): string {
  return jwt.sign({ sub: 'operator', role: 'board-viewer' }, secret, {
    algorithm: 'HS256', expiresIn,
  });
}

// ── Socket.io mock that captures use() middleware and on() handlers ──────────

let capturedUseMiddleware: ((socket: MockSocket, next: (err?: Error) => void) => void) | null = null;
let capturedConnectionHandler: ((socket: MockSocket) => void) | null = null;
let capturedOptions: Record<string, unknown> | null = null;

interface MockSocket {
  handshake: { auth: Record<string, unknown> };
  data: Record<string, unknown>;
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeMockSocket(auth: Record<string, unknown> = {}): MockSocket {
  return {
    handshake: { auth },
    data: {},
    emit: vi.fn(),
    on: vi.fn(),
    disconnect: vi.fn(),
  };
}

vi.mock('socket.io', () => ({
  Server: vi.fn().mockImplementation(function (_srv: unknown, opts: Record<string, unknown>) {
    capturedOptions = opts;
    return {
      adapter: vi.fn(),
      emit: vi.fn(),
      close: vi.fn((cb?: () => void) => { if (cb) cb(); }),
      use: vi.fn().mockImplementation((middleware: typeof capturedUseMiddleware) => {
        capturedUseMiddleware = middleware;
      }),
      on: vi.fn().mockImplementation((event: string, handler: typeof capturedConnectionHandler) => {
        if (event === 'connection') capturedConnectionHandler = handler;
      }),
    };
  }),
}));
vi.mock('@socket.io/redis-adapter', () => ({ createAdapter: vi.fn().mockReturnValue('mock-adapter') }));

import { SocketGateway } from '../../../src/adapters/gateway/SocketGateway';

const mockRedis = {
  subscribe: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  quit: vi.fn().mockResolvedValue(undefined),
  publish: vi.fn().mockResolvedValue(1),
};

describe('SocketGateway — JWT auth middleware', () => {
  const httpServer = createServer();

  beforeEach(() => {
    capturedUseMiddleware = null;
    capturedConnectionHandler = null;
    capturedOptions = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env['BOARD_JWT_SECRET'];
    delete process.env['SOCKET_CORS_ORIGINS'];
    delete process.env['NODE_ENV'];
  });

  function getGateway(): SocketGateway {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new SocketGateway(httpServer, mockRedis as any, mockRedis as any);
  }

  // ─── Auth disabled (no BOARD_JWT_SECRET) ─────────────────────────────────

  it('registers io.use() middleware even when BOARD_JWT_SECRET is unset', () => {
    const sg = getGateway();
    sg.initialize();
    expect(capturedUseMiddleware).not.toBeNull();
  });

  it('middleware calls next() without error when BOARD_JWT_SECRET is unset', () => {
    const sg = getGateway();
    sg.initialize();
    const socket = makeMockSocket();
    const next = vi.fn();
    capturedUseMiddleware!(socket, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(); // no error argument
  });

  // ─── Auth enabled (BOARD_JWT_SECRET set) ──────────────────────────────────

  describe('with BOARD_JWT_SECRET set', () => {
    beforeEach(() => {
      process.env['BOARD_JWT_SECRET'] = BOARD_SECRET;
    });

    it('calls next(error) when auth.token is missing', () => {
      const sg = getGateway();
      sg.initialize();
      const socket = makeMockSocket({}); // no token
      const next = vi.fn();
      capturedUseMiddleware!(socket, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Missing board token' }));
    });

    it('calls next(error) when auth.token is invalid', () => {
      const sg = getGateway();
      sg.initialize();
      const socket = makeMockSocket({ token: 'not-a-valid-jwt' });
      const next = vi.fn();
      capturedUseMiddleware!(socket, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid or expired board token' }));
    });

    it('calls next(error) when auth.token is signed with wrong secret', () => {
      const sg = getGateway();
      sg.initialize();
      const bad = makeToken('wrong-secret');
      const socket = makeMockSocket({ token: bad });
      const next = vi.fn();
      capturedUseMiddleware!(socket, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid or expired board token' }));
    });

    it('calls next(error) when auth.token is expired', () => {
      const sg = getGateway();
      sg.initialize();
      const expired = makeToken(BOARD_SECRET, -1);
      const socket = makeMockSocket({ token: expired });
      const next = vi.fn();
      capturedUseMiddleware!(socket, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid or expired board token' }));
    });

    it('calls next() without error for a valid token', () => {
      const sg = getGateway();
      sg.initialize();
      const token = makeToken();
      const socket = makeMockSocket({ token });
      const next = vi.fn();
      capturedUseMiddleware!(socket, next);
      expect(next).toHaveBeenCalledWith(); // no error
    });

    it('stores exp in socket.data for expiry enforcement', () => {
      const sg = getGateway();
      sg.initialize();
      const token = makeToken();
      const socket = makeMockSocket({ token });
      capturedUseMiddleware!(socket, vi.fn());
      expect(typeof socket.data['exp']).toBe('number');
      expect(socket.data['exp'] as number).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  // ─── Expiry enforcement on connection ─────────────────────────────────────

  describe('expiry enforcement', () => {
    beforeEach(() => {
      process.env['BOARD_JWT_SECRET'] = BOARD_SECRET;
    });

    it('disconnects socket immediately when exp is in the past', () => {
      vi.useFakeTimers();
      const sg = getGateway();
      sg.initialize();
      const socket = makeMockSocket();
      socket.data['exp'] = Math.floor(Date.now() / 1000) - 10; // already expired
      capturedConnectionHandler!(socket);
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      vi.useRealTimers();
    });

    it('schedules disconnect when exp is in the future', () => {
      vi.useFakeTimers();
      const sg = getGateway();
      sg.initialize();
      const socket = makeMockSocket();
      const futureExp = Math.floor(Date.now() / 1000) + 60;
      socket.data['exp'] = futureExp;
      capturedConnectionHandler!(socket);
      expect(socket.disconnect).not.toHaveBeenCalled();
      // Advance past expiry
      vi.advanceTimersByTime(61_000);
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      vi.useRealTimers();
    });

    it('does not schedule disconnect when exp is undefined (no auth)', () => {
      vi.useFakeTimers();
      const sg = getGateway();
      sg.initialize();
      const socket = makeMockSocket();
      // socket.data['exp'] is not set
      capturedConnectionHandler!(socket);
      vi.advanceTimersByTime(100_000);
      expect(socket.disconnect).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  // ─── CORS configuration ───────────────────────────────────────────────────

  describe('CORS configuration', () => {
    it('uses wildcard origin when SOCKET_CORS_ORIGINS is not set (non-production)', () => {
      const sg = getGateway();
      sg.initialize();
      const cors = capturedOptions!['cors'] as Record<string, unknown>;
      expect(cors['origin']).toEqual(['*']);
    });

    it('uses origin list from SOCKET_CORS_ORIGINS', () => {
      process.env['SOCKET_CORS_ORIGINS'] = 'http://localhost:5173,https://board.example.com';
      const sg = getGateway();
      sg.initialize();
      const cors = capturedOptions!['cors'] as Record<string, unknown>;
      expect(cors['origin']).toEqual(['http://localhost:5173', 'https://board.example.com']);
    });

    it('trims whitespace from SOCKET_CORS_ORIGINS entries', () => {
      process.env['SOCKET_CORS_ORIGINS'] = ' http://localhost:5173 , https://board.example.com ';
      const sg = getGateway();
      sg.initialize();
      const cors = capturedOptions!['cors'] as Record<string, unknown>;
      expect(cors['origin']).toEqual(['http://localhost:5173', 'https://board.example.com']);
    });

    it('throws on initialize() in production without SOCKET_CORS_ORIGINS', () => {
      process.env['NODE_ENV'] = 'production';
      const sg = getGateway();
      expect(() => sg.initialize()).toThrow('SOCKET_CORS_ORIGINS must be set in production');
    });

    it('sets credentials: true when CORS is configured', () => {
      process.env['SOCKET_CORS_ORIGINS'] = 'http://localhost:5173';
      const sg = getGateway();
      sg.initialize();
      const cors = capturedOptions!['cors'] as Record<string, unknown>;
      expect(cors['credentials']).toBe(true);
    });
  });
});
