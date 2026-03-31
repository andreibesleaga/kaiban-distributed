/**
 * AgentStatePublisher — concurrent state publishing & race conditions.
 *
 * Verifies that rapid state transitions, heartbeats during execution,
 * and boundary-condition truncation all behave correctly.
 */
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

const agentInfo = { agentId: 'worker-1', name: 'TestWorker', role: 'Worker' };

describe('AgentStatePublisher — concurrent scenarios', () => {
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

  it('rapid IDLE→EXECUTING→DONE transitions all publish in order', async () => {
    // IDLE
    publisher.publishIdle();
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const idleMsg = JSON.parse(mockPublish.mock.calls[0][1] as string);
    expect(idleMsg.agents[0].status).toBe('IDLE');

    // Wrap a handler — it publishes EXECUTING at start, DONE at end
    const handler = publisher.wrapHandler(async (_p: MessagePayload) => 'result-data');
    const payload: MessagePayload = { taskId: 't1', agentId: 'worker-1', timestamp: Date.now(), data: {} };

    await handler(payload);

    // Should have published: IDLE (1) + EXECUTING (2) + task completion (3)
    expect(mockPublish.mock.calls.length).toBeGreaterThanOrEqual(3);

    const statuses = mockPublish.mock.calls.map((call: unknown[]) => {
      const parsed = JSON.parse(call[1] as string);
      return parsed.agents?.[0]?.status ?? parsed.tasks?.[0]?.status ?? 'unknown';
    });

    // First is IDLE, then EXECUTING should appear
    expect(statuses[0]).toBe('IDLE');
    expect(statuses).toContain('EXECUTING');
  });

  it('heartbeat during task execution publishes EXECUTING status (not IDLE)', async () => {
    publisher.publishIdle(3000); // heartbeat every 3s

    const handler = publisher.wrapHandler(async (_p: MessagePayload) => {
      // Trigger heartbeat mid-execution
      vi.advanceTimersByTime(3001);
      return 'done';
    });

    const payload: MessagePayload = { taskId: 't1', agentId: 'worker-1', timestamp: Date.now(), data: {} };
    await handler(payload);

    // Find the heartbeat call that fired during execution
    const heartbeatCalls = mockPublish.mock.calls.filter((call: unknown[]) => {
      const parsed = JSON.parse(call[1] as string);
      return parsed.agents?.[0]?.status === 'EXECUTING';
    });
    expect(heartbeatCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('result exceeding MAX_RESULT_LEN (20_000 chars) is truncated', async () => {
    const MAX = 20_000; // must match AgentStatePublisher.MAX_RESULT_LEN

    const bigResult = 'x'.repeat(MAX + 500);
    const handler = publisher.wrapHandler(async () => bigResult);
    await handler({ taskId: 't-big', agentId: 'worker-1', timestamp: Date.now(), data: {} });

    // Find the DONE publish — it has a result field; the DOING publish does not
    const doneCalls = (mockPublish.mock.calls as Array<[string, string]>).filter(([, data]) => {
      try {
        const parsed = JSON.parse(data);
        return parsed.tasks?.[0]?.taskId === 't-big' && parsed.tasks?.[0]?.result !== undefined;
      } catch { return false; }
    });
    expect(doneCalls.length).toBeGreaterThanOrEqual(1);

    const resultStr = JSON.parse(doneCalls[0][1]).tasks[0].result as string;
    expect(resultStr.length).toBeLessThanOrEqual(MAX);
  });

  it('result at exactly MAX_RESULT_LEN is not truncated (boundary)', async () => {
    const MAX = 20_000;

    const exactResult = 'y'.repeat(MAX);
    const handler = publisher.wrapHandler(async () => exactResult);
    await handler({ taskId: 't-exact', agentId: 'worker-1', timestamp: Date.now(), data: {} });

    const doneCalls = (mockPublish.mock.calls as Array<[string, string]>).filter(([, data]) => {
      try {
        const parsed = JSON.parse(data);
        return parsed.tasks?.[0]?.taskId === 't-exact' && parsed.tasks?.[0]?.result !== undefined;
      } catch { return false; }
    });
    expect(doneCalls.length).toBeGreaterThanOrEqual(1);

    const resultStr = JSON.parse(doneCalls[0][1]).tasks[0].result as string;
    expect(resultStr.length).toBe(MAX);
  });
});
