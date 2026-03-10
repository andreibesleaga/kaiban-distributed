import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'http';
import { SocketGateway } from '../../../src/adapters/gateway/SocketGateway';

const mockSubscribe = vi.fn().mockResolvedValue(undefined);
const mockOn = vi.fn();
const mockQuit = vi.fn().mockResolvedValue(undefined);
const mockRedisSubscriber = { subscribe: mockSubscribe, on: mockOn, quit: mockQuit };
const mockRedisPublisher = { quit: mockQuit };

const mockEmit = vi.fn();
const mockIoClose = vi.fn().mockImplementation((cb?: () => void) => { if (cb) cb(); });
const mockAdapter = vi.fn();

vi.mock('socket.io', () => ({
  Server: vi.fn().mockImplementation(function () {
    return { adapter: mockAdapter, emit: mockEmit, close: mockIoClose };
  }),
}));
vi.mock('@socket.io/redis-adapter', () => ({ createAdapter: vi.fn().mockReturnValue('mock-redis-adapter') }));

describe('SocketGateway', () => {
  let sg: SocketGateway;
  const httpServer = createServer();

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sg = new SocketGateway(httpServer, mockRedisPublisher as any, mockRedisSubscriber as any);
  });

  afterEach(async () => { await sg.shutdown(); });

  function getMessageHandler(): (channel: string, data: string) => void {
    const calls = mockOn.mock.calls as Array<[string, (...args: unknown[]) => void]>;
    const onCall = calls.find((args) => args[0] === 'message');
    return onCall![1] as (channel: string, data: string) => void;
  }

  it('initialize() attaches Redis adapter to Socket.io', () => {
    sg.initialize();
    expect(mockAdapter).toHaveBeenCalledWith('mock-redis-adapter');
  });

  it('initialize() subscribes to kaiban-state-events on Redis', () => {
    sg.initialize();
    expect(mockSubscribe).toHaveBeenCalledWith('kaiban-state-events');
  });

  it('a Redis message triggers io.emit(state:update)', () => {
    sg.initialize();
    getMessageHandler()('kaiban-state-events', JSON.stringify({ stateUpdate: { count: 1 } }));
    expect(mockEmit).toHaveBeenCalledWith('state:update', { stateUpdate: { count: 1 } });
  });

  it('invalid JSON in Redis message is caught and logged', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sg.initialize();
    getMessageHandler()('kaiban-state-events', '{invalid}');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to parse'));
    errSpy.mockRestore();
  });

  it('shutdown() resolves without calling io.close when not initialized', async () => {
    // sg is NOT initialized — io is null, should resolve via else branch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uninitSg = new SocketGateway(httpServer, mockRedisPublisher as any, mockRedisSubscriber as any);
    await expect(uninitSg.shutdown()).resolves.not.toThrow();
    expect(mockIoClose).not.toHaveBeenCalled();
  });
});
