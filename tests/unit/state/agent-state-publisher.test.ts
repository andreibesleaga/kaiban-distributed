import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    vi.useFakeTimers();
    publisher = new AgentStatePublisher('redis://localhost:6379', agentInfo);
  });

  afterEach(async () => {
    await publisher.disconnect().catch(() => {});
    vi.useRealTimers();
  });

  it('publishIdle() broadcasts IDLE agent state to Redis pub/sub', () => {
    publisher.publishIdle();
    expect(mockPublish).toHaveBeenCalledWith(
      'kaiban-state-events',
      expect.stringContaining('"status":"IDLE"'),
    );
  });

  it('publishIdle() starts heartbeat that re-publishes state periodically', () => {
    publisher.publishIdle(5000);
    const callsAfterInit = mockPublish.mock.calls.length;
    vi.advanceTimersByTime(5001);
    expect(mockPublish.mock.calls.length).toBeGreaterThan(callsAfterInit);
    const lastMsg = JSON.parse(mockPublish.mock.calls.at(-1)![1] as string) as { agents: { status: string }[] };
    expect(lastMsg.agents[0].status).toBe('IDLE');
  });

  it('publishIdle() clears previous heartbeat if called again (covers clearInterval branch)', () => {
    publisher.publishIdle(5000);
    publisher.publishIdle(5000); // second call — clears first timer
    vi.advanceTimersByTime(5001);
    // Should have fired (no duplicates from two timers)
    expect(mockPublish.mock.calls.length).toBeGreaterThan(0);
  });

  it('wrapHandler() updates currentStatus so heartbeat reflects EXECUTING during task', async () => {
    publisher.publishIdle(3000);
    const inner = vi.fn().mockImplementation(async () => {
      vi.advanceTimersByTime(3001); // trigger heartbeat mid-execution
      return 'done';
    });
    const wrapped = publisher.wrapHandler(inner);
    await wrapped({ taskId: 'tx', agentId: 'researcher', timestamp: 0, data: {} });
    const calls = mockPublish.mock.calls.map((c) => JSON.parse(c[1] as string));
    const executingHeartbeat = calls.find(c => c.agents?.[0]?.status === 'EXECUTING' && !c.tasks);
    expect(executingHeartbeat).toBeDefined();
  });

  it('wrapHandler() publishes EXECUTING on start, DONE on completion', async () => {
    publisher.publishIdle();
    const inner = vi.fn().mockResolvedValue('result text');
    const wrapped = publisher.wrapHandler(inner);
    const payload: MessagePayload = { taskId: 't1', agentId: 'researcher', timestamp: 0, data: { instruction: 'Do research' } };
    await wrapped(payload);
    const calls = mockPublish.mock.calls.map((c) => JSON.parse(c[1] as string));
    expect(calls.find(c => c.agents?.[0]?.status === 'EXECUTING')?.agents[0].currentTaskId).toBe('t1');
    expect(calls.find(c => c.tasks?.[0]?.status === 'DONE')?.tasks[0].result).toBe('result text');
  });

  it('wrapHandler() handles null result (covers result == null branch)', async () => {
    publisher.publishIdle();
    const wrapped = publisher.wrapHandler(vi.fn().mockResolvedValue(null));
    await wrapped({ taskId: 't3', agentId: 'researcher', timestamp: 0, data: {} });
    const calls = mockPublish.mock.calls.map((c) => JSON.parse(c[1] as string));
    expect(calls.find(c => c.tasks?.[0]?.status === 'DONE')?.tasks[0].result).toBe('');
  });

  it('wrapHandler() JSON-stringifies object results (covers typeof !== string branch)', async () => {
    publisher.publishIdle();
    const wrapped = publisher.wrapHandler(vi.fn().mockResolvedValue({ answer: 'hello', score: 9 }));
    await wrapped({ taskId: 't4', agentId: 'researcher', timestamp: 0, data: {} });
    const calls = mockPublish.mock.calls.map((c) => JSON.parse(c[1] as string));
    const doneTask = calls.find(c => c.tasks?.[0]?.status === 'DONE')?.tasks[0];
    expect(doneTask.result).toBe('{"answer":"hello","score":9}');
  });

  it('wrapHandler() publishes ERROR/BLOCKED on throw', async () => {
    publisher.publishIdle();
    const wrapped = publisher.wrapHandler(vi.fn().mockRejectedValue(new Error('LLM failed')));
    await expect(wrapped({ taskId: 't2', agentId: 'researcher', timestamp: 0, data: {} })).rejects.toThrow('LLM failed');
    const calls = mockPublish.mock.calls.map((c) => JSON.parse(c[1] as string));
    expect(calls.find(c => c.agents?.[0]?.status === 'ERROR')?.tasks[0].status).toBe('BLOCKED');
  });

  it('disconnect() with heartbeat: stops timer and calls quit', async () => {
    publisher.publishIdle(5000);
    vi.useRealTimers();
    await publisher.disconnect();
    const callsBefore = mockPublish.mock.calls.length;
    // After disconnect, timer should not fire
    await new Promise(r => setTimeout(r, 10));
    expect(mockPublish.mock.calls.length).toBe(callsBefore);
    expect(mockQuit).toHaveBeenCalledOnce();
  });

  it('disconnect() without publishIdle is safe (heartbeatTimer is null — false branch)', async () => {
    vi.useRealTimers();
    const pub2 = new AgentStatePublisher('redis://localhost:6379', agentInfo);
    await expect(pub2.disconnect()).resolves.not.toThrow();
    expect(mockQuit).toHaveBeenCalledOnce();
  });

  it('publish() logs and swallows redis errors (.catch() branch)', async () => {
    vi.useRealTimers();
    const pub3 = new AgentStatePublisher('redis://localhost:6379', agentInfo);
    mockPublish.mockRejectedValueOnce(new Error('Redis lost'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    pub3.publishIdle();
    await new Promise(r => setTimeout(r, 20));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to publish'), expect.any(Error));
    errSpy.mockRestore();
    await pub3.disconnect();
  });
});
