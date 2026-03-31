/**
 * AgentActor — concurrency & multi-task scenarios.
 *
 * Verifies that multiple tasks on the same queue are processed correctly,
 * and that task handlers process sequentially (no interleaving).
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentActor } from '../../../src/application/actor/AgentActor';
import type { IMessagingDriver, MessagePayload } from '../../../src/infrastructure/messaging/interfaces';

function makeCapturingDriver(): {
  driver: IMessagingDriver;
  getHandler: () => (p: MessagePayload) => Promise<void>;
} {
  let h!: (p: MessagePayload) => Promise<void>;
  const driver: IMessagingDriver = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((_q, handler) => { h = handler; return Promise.resolve(); }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return { driver, getHandler: () => h };
}

function makePayload(taskId: string, agentId = 'agent-1'): MessagePayload {
  return { taskId, agentId, timestamp: Date.now(), data: { instruction: `task-${taskId}` } };
}

describe('AgentActor — concurrency', () => {
  it('processes multiple tasks sequentially on the same queue', async () => {
    const order: string[] = [];
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockImplementation(async (p: MessagePayload) => {
      order.push(`start-${p.taskId}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end-${p.taskId}`);
      return `result-${p.taskId}`;
    });

    const actor = new AgentActor('agent-1', driver, 'q', handler);
    await actor.start();

    // Process 3 tasks sequentially
    const h = getHandler();
    await h(makePayload('t1'));
    await h(makePayload('t2'));
    await h(makePayload('t3'));

    expect(order).toEqual(['start-t1', 'end-t1', 'start-t2', 'end-t2', 'start-t3', 'end-t3']);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(driver.publish).toHaveBeenCalledTimes(3);
  });

  it('two actors on same queue both receive tasks via competing consumers pattern', async () => {
    const results1: string[] = [];
    const results2: string[] = [];

    const { driver: d1, getHandler: gh1 } = makeCapturingDriver();
    const { driver: d2, getHandler: gh2 } = makeCapturingDriver();

    const actor1 = new AgentActor('agent-1', d1, 'shared-q', async (p) => { results1.push(p.taskId); return ''; });
    const actor2 = new AgentActor('agent-1', d2, 'shared-q', async (p) => { results2.push(p.taskId); return ''; });

    await actor1.start();
    await actor2.start();

    // Each actor processes its own tasks (BullMQ distributes at driver level)
    await gh1()(makePayload('t1'));
    await gh2()(makePayload('t2'));

    expect(results1).toEqual(['t1']);
    expect(results2).toEqual(['t2']);
  });

  it('failed task is retried then routed to DLQ; next task still processes normally', async () => {
    const { driver, getHandler } = makeCapturingDriver();
    // AgentActor retries RETRY_ATTEMPTS=3 times before routing to DLQ.
    // The failing handler will be called 3 times (all retries), then the
    // success handler once — total 4 calls to the handler mock.
    let callCount = 0;
    const handler = vi.fn().mockImplementation(async (p: MessagePayload) => {
      if (p.taskId === 't-fail') throw new Error('boom');
      callCount++;
      return 'ok';
    });

    const actor = new AgentActor('agent-1', driver, 'q', handler);
    await actor.start();

    const h = getHandler();
    // First task fails all retries → DLQ
    await h(makePayload('t-fail'));
    // Second task succeeds
    await h(makePayload('t-ok'));

    // 't-ok' should have been processed
    expect(callCount).toBe(1);
    // Failing task goes to failed channel; success task goes to completed channel
    const publishCalls = (driver.publish as ReturnType<typeof vi.fn>).mock.calls;
    const failedCall = publishCalls.find((c) => c[0] === 'kaiban-events-failed');
    const completedCall = publishCalls.find((c) => c[0] === 'kaiban-events-completed');
    expect(failedCall).toBeDefined();
    expect(completedCall).toBeDefined();
  });
});
