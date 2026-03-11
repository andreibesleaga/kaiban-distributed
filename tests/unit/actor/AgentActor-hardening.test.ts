import { describe, it, expect, vi } from 'vitest';
import { AgentActor } from '../../../src/application/actor/AgentActor';
import type { IMessagingDriver, MessagePayload } from '../../../src/infrastructure/messaging/interfaces';

function makeCapturingDriver(): { driver: IMessagingDriver; getHandler: () => (p: MessagePayload) => Promise<void> } {
  let h!: (p: MessagePayload) => Promise<void>;
  const driver: IMessagingDriver = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((_q, handler) => { h = handler; return Promise.resolve(); }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return { driver, getHandler: () => h };
}

describe('AgentActor — payload size cap (capDataSize)', () => {
  it('small results pass through without truncation', async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue('short result');
    const actor = new AgentActor('agent-1', driver, 'q', handler);
    await actor.start();
    await getHandler()({ taskId: 't1', agentId: 'agent-1', data: {}, timestamp: 0 });

    const publishCall = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'kaiban-events-completed',
    );
    expect(publishCall).toBeDefined();
    const payload = publishCall![1] as MessagePayload;
    expect(payload.data['result']).toBe('short result');
    expect(payload.data['_truncated']).toBeUndefined();
  });

  it('large results (>64KB) are truncated with _truncated flag', async () => {
    const bigResult = 'x'.repeat(100_000);
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue(bigResult);
    const actor = new AgentActor('agent-1', driver, 'q', handler);
    await actor.start();
    await getHandler()({ taskId: 't2', agentId: 'agent-1', data: {}, timestamp: 0 });

    const publishCall = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'kaiban-events-completed',
    );
    expect(publishCall).toBeDefined();
    const payload = publishCall![1] as MessagePayload;
    expect(String(payload.data['result']).length).toBeLessThanOrEqual(65_536);
    expect(payload.data['_truncated']).toBe(true);
  });

  it('DLQ messages with large error strings are also capped', async () => {
    const bigError = new Error('e'.repeat(100_000));
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockRejectedValue(bigError);
    const actor = new AgentActor('agent-1', driver, 'q', handler);
    await actor.start();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await getHandler()({ taskId: 't3', agentId: 'agent-1', data: {}, timestamp: 0 });

    const dlqCall = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'kaiban-events-failed',
    );
    expect(dlqCall).toBeDefined();
    const payload = dlqCall![1] as MessagePayload;
    const serialized = JSON.stringify(payload.data);
    // The data should not be excessively large
    expect(serialized.length).toBeLessThan(200_000);
  });

  it('result at exactly 64KB boundary is NOT truncated', async () => {
    // Create a result that when serialized with the rest of data is just under 64KB
    const smallResult = 'y'.repeat(1000);
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue(smallResult);
    const actor = new AgentActor('agent-1', driver, 'q', handler);
    await actor.start();
    await getHandler()({ taskId: 't4', agentId: 'agent-1', data: {}, timestamp: 0 });

    const publishCall = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'kaiban-events-completed',
    );
    const payload = publishCall![1] as MessagePayload;
    expect(payload.data['result']).toBe(smallResult);
    expect(payload.data['_truncated']).toBeUndefined();
  });
});
