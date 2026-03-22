import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KaibanTeamBridge } from '../../../src/infrastructure/kaibanjs/kaiban-team-bridge';

const mockGetStore = vi.fn().mockReturnValue({
  setState: vi.fn(),
  getState: vi.fn().mockReturnValue({ teamWorkflowStatus: 'INITIAL' }),
  subscribe: vi.fn().mockReturnValue(() => {}),
});
const mockStart = vi.fn().mockResolvedValue({ status: 'FINISHED', result: 'blog post', stats: null });
const mockSubscribeToChanges = vi.fn().mockReturnValue(() => {});

vi.mock('kaibanjs', () => ({
  Team: vi.fn().mockImplementation(function () {
    return { getStore: mockGetStore, start: mockStart, subscribeToChanges: mockSubscribeToChanges };
  }),
  Agent: vi.fn().mockImplementation(function (params: Record<string, unknown>) { return params; }),
  Task: vi.fn().mockImplementation(function (params: Record<string, unknown>) { return params; }),
}));

const mockRedis = {
  publish: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(function() { return mockRedis; }),
}));

describe('KaibanTeamBridge', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls team.getStore() to attach DistributedStateMiddleware', () => {
    const bridge = new KaibanTeamBridge(
      { name: 'Blog Team', agents: [], tasks: [] },
      'redis://localhost:6379',
    );
    expect(bridge).toBeDefined();
    expect(mockGetStore).toHaveBeenCalledOnce();
  });

  it('getTeam() returns the underlying KaibanJS Team', () => {
    const bridge = new KaibanTeamBridge({ name: 'T', agents: [], tasks: [] }, 'redis://localhost:6379');
    const team = bridge.getTeam();
    expect(team).toBeDefined();
    expect(typeof team.start).toBe('function');
  });

  it('start() delegates to team.start() with inputs', async () => {
    const bridge = new KaibanTeamBridge({ name: 'T', agents: [], tasks: [] }, 'redis://localhost:6379');
    const result = await bridge.start({ topic: 'AI trends' });
    expect(mockStart).toHaveBeenCalledWith({ topic: 'AI trends' });
    expect(result.status).toBe('FINISHED');
  });

  it('start() with no inputs passes empty object', async () => {
    const bridge = new KaibanTeamBridge({ name: 'T', agents: [], tasks: [] }, 'redis://localhost:6379');
    await bridge.start();
    expect(mockStart).toHaveBeenCalledWith({});
  });

  it('subscribeToChanges() sets up a store listener', () => {
    const bridge = new KaibanTeamBridge({ name: 'T', agents: [], tasks: [] }, 'redis://localhost:6379');
    const listener = vi.fn();
    bridge.subscribeToChanges(listener, ['teamWorkflowStatus']);
    expect(mockGetStore).toHaveBeenCalled();
  });

  it('disconnect() calls middleware disconnect', async () => {
    const bridge = new KaibanTeamBridge({ name: 'T', agents: [], tasks: [] }, 'redis://localhost:6379');
    await bridge.disconnect();
    expect(mockRedis.quit).toHaveBeenCalled();
  });
});
