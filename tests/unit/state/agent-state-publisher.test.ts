import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentStatePublisher } from '../../../src/adapters/state/agent-state-publisher';
import type { MessagePayload } from '../../../src/infrastructure/messaging/interfaces';

const mockPublish = vi.fn().mockResolvedValue(1);
const mockQuit = vi.fn().mockResolvedValue('OK');

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { publish: mockPublish, quit: mockQuit };
  }),
}));

const agentInfo = { agentId: 'researcher', name: 'Ava', role: 'Researcher' };

describe('AgentStatePublisher', () => {
  let publisher: AgentStatePublisher;

  beforeEach(() => {
    vi.clearAllMocks();
    publisher = new AgentStatePublisher('redis://localhost:6379', agentInfo);
  });

  it('publishIdle() broadcasts IDLE agent state to Redis pub/sub', () => {
    publisher.publishIdle();
    expect(mockPublish).toHaveBeenCalledWith(
      'kaiban-state-events',
      expect.stringContaining('"status":"IDLE"'),
    );
  });

  it('wrapHandler() publishes EXECUTING on task start, DONE on completion', async () => {
    const inner = vi.fn().mockResolvedValue('result text');
    const wrapped = publisher.wrapHandler(inner);
    const payload: MessagePayload = {
      taskId: 't1', agentId: 'researcher', timestamp: 0,
      data: { instruction: 'Do research' },
    };

    await wrapped(payload);

    const calls = mockPublish.mock.calls.map((c) => JSON.parse(c[1] as string));
    const executingCall = calls.find((c) => c.agents?.[0]?.status === 'EXECUTING');
    const doneTaskCall = calls.find((c) => c.tasks?.[0]?.status === 'DONE');

    expect(executingCall).toBeDefined();
    expect(executingCall.agents[0].currentTaskId).toBe('t1');
    expect(doneTaskCall).toBeDefined();
    expect(doneTaskCall.tasks[0].result).toBe('result text');
  });

  it('wrapHandler() publishes ERROR/BLOCKED when handler throws', async () => {
    const inner = vi.fn().mockRejectedValue(new Error('LLM failed'));
    const wrapped = publisher.wrapHandler(inner);
    const payload: MessagePayload = {
      taskId: 't2', agentId: 'researcher', timestamp: 0, data: {},
    };

    await expect(wrapped(payload)).rejects.toThrow('LLM failed');

    const calls = mockPublish.mock.calls.map((c) => JSON.parse(c[1] as string));
    const errorCall = calls.find((c) => c.agents?.[0]?.status === 'ERROR');
    expect(errorCall).toBeDefined();
    expect(errorCall.tasks[0].status).toBe('BLOCKED');
  });

  it('disconnect() calls redis.quit()', async () => {
    await publisher.disconnect();
    expect(mockQuit).toHaveBeenCalledOnce();
  });

  it('publish() logs and swallows redis errors (covers .catch() branch)', async () => {
    mockPublish.mockRejectedValueOnce(new Error('Redis connection lost'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    publisher.publishIdle();
    await new Promise((r) => setTimeout(r, 20));
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to publish'),
      expect.any(Error),
    );
    errSpy.mockRestore();
  });
});
