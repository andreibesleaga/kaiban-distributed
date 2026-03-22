/**
 * AgentActor — comprehensive edge-case & missing-path tests.
 *
 * Covers scenarios NOT already in:
 *  - AgentActor.test.ts           (golden paths, basic routing)
 *  - AgentActor-warn.test.ts      (taskHandler warnings, result propagation)
 *  - AgentActor-hardening.test.ts (capDataSize payload capping)
 *  - agent-actor-security.test.ts (firewall + CB individual paths)
 *  - agent-actor-combined.test.ts (firewall + CB combined paths)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentActor, type AgentActorDeps } from '../../../src/application/actor/AgentActor';
import type { IMessagingDriver, MessagePayload } from '../../../src/infrastructure/messaging/interfaces';
import type { ICircuitBreaker } from '../../../src/domain/security/circuit-breaker';

// ── helpers ───────────────────────────────────────────────────────────

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

function makePayload(overrides: Partial<MessagePayload> = {}): MessagePayload {
  return { taskId: 'task-1', agentId: 'agent-1', timestamp: Date.now(), data: { instruction: 'test' }, ...overrides };
}

// ── Retry recovery scenarios ──────────────────────────────────────────

describe('AgentActor — retry recovery (partial failure)', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { errSpy.mockRestore(); });

  it('recovers on 2nd attempt after 1st failure → publishes to completed (not DLQ)', async () => {
    const { driver, getHandler } = makeCapturingDriver();
    let attempt = 0;
    const handler = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt === 1) throw new Error('transient failure');
      return 'recovered-on-2nd';
    });
    const actor = new AgentActor('agent-1', driver, 'q', handler);
    await actor.start();
    await getHandler()(makePayload());

    expect(handler).toHaveBeenCalledTimes(2);
    // Must publish to completed, NOT DLQ
    const completedCalls = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'kaiban-events-completed',
    );
    const dlqCalls = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'kaiban-events-failed',
    );
    expect(completedCalls).toHaveLength(1);
    expect(dlqCalls).toHaveLength(0);
    expect(completedCalls[0][1].data.result).toBe('recovered-on-2nd');
  });

  it('recovers on 3rd (last) attempt → publishes to completed', async () => {
    const { driver, getHandler } = makeCapturingDriver();
    let attempt = 0;
    const handler = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt < 3) throw new Error('transient');
      return 'recovered-on-3rd';
    });
    const actor = new AgentActor('agent-1', driver, 'q', handler);
    await actor.start();
    await getHandler()(makePayload());

    expect(handler).toHaveBeenCalledTimes(3);
    const completedCalls = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'kaiban-events-completed',
    );
    expect(completedCalls).toHaveLength(1);
    expect(completedCalls[0][1].data.result).toBe('recovered-on-3rd');
  });

  it('circuit breaker records success on retry recovery (not failure)', async () => {
    const { driver, getHandler } = makeCapturingDriver();
    let attempt = 0;
    const handler = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt === 1) throw new Error('transient');
      return 'OK';
    });
    const breaker: ICircuitBreaker = {
      isOpen: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const actor = new AgentActor('agent-1', driver, 'q', handler, { circuitBreaker: breaker });
    await actor.start();
    await getHandler()(makePayload());

    expect(breaker.recordSuccess).toHaveBeenCalledOnce();
    expect(breaker.recordFailure).not.toHaveBeenCalled();
  });

  it('retry delay increases with backoff (attempt * 100ms)', async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockRejectedValue(new Error('always fails'));
    const actor = new AgentActor('agent-1', driver, 'q', handler);
    await actor.start();

    const start = Date.now();
    await getHandler()(makePayload());
    const elapsed = Date.now() - start;

    // 3 retries: delays of 100ms + 200ms = 300ms minimum (3rd attempt does not delay)
    expect(elapsed).toBeGreaterThanOrEqual(250); // allow some tolerance
  });
});

// ── Lifecycle edge cases ──────────────────────────────────────────────

describe('AgentActor — lifecycle edge cases', () => {
  it('stop() before any tasks does not throw', async () => {
    const { driver } = makeCapturingDriver();
    const actor = new AgentActor('agent-1', driver, 'q');
    await actor.start();
    await expect(actor.stop()).resolves.not.toThrow();
    expect(driver.unsubscribe).toHaveBeenCalledWith('q');
  });

  it('multiple stop() calls are safe (idempotent unsubscribe)', async () => {
    const { driver } = makeCapturingDriver();
    const actor = new AgentActor('agent-1', driver, 'q');
    await actor.start();
    await actor.stop();
    await actor.stop();
    expect(driver.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('start → stop → start re-subscribes to queue', async () => {
    const { driver } = makeCapturingDriver();
    const actor = new AgentActor('agent-1', driver, 'q');
    await actor.start();
    await actor.stop();
    await actor.start();
    expect(driver.subscribe).toHaveBeenCalledTimes(2);
    expect(driver.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

// ── Rapid sequential task processing ──────────────────────────────────

describe('AgentActor — rapid sequential tasks', () => {
  it('processes multiple tasks in sequence without cross-contamination', async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const results: string[] = [];
    const handler = vi.fn().mockImplementation(async (p: MessagePayload) => {
      results.push(p.taskId);
      return `result-${p.taskId}`;
    });
    const actor = new AgentActor('agent-1', driver, 'q', handler);
    await actor.start();

    // Fire 5 tasks rapidly
    for (let i = 0; i < 5; i++) {
      await getHandler()(makePayload({ taskId: `task-${i}` }));
    }

    expect(handler).toHaveBeenCalledTimes(5);
    expect(results).toEqual(['task-0', 'task-1', 'task-2', 'task-3', 'task-4']);

    const completedCalls = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'kaiban-events-completed',
    );
    expect(completedCalls).toHaveLength(5);
  });

  it('mixed success/failure tasks maintain correct order', async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn().mockImplementation(async (p: MessagePayload) => {
      if (p.taskId === 'fail-task') throw new Error('boom');
      return 'ok';
    });
    const actor = new AgentActor('agent-1', driver, 'q', handler);
    await actor.start();

    await getHandler()(makePayload({ taskId: 'ok-1' }));
    await getHandler()(makePayload({ taskId: 'fail-task' }));
    await getHandler()(makePayload({ taskId: 'ok-2' }));

    const completedIds = (driver.publish as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => c[0] === 'kaiban-events-completed')
      .map((c: unknown[]) => (c[1] as MessagePayload).taskId);
    const dlqIds = (driver.publish as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => c[0] === 'kaiban-events-failed')
      .map((c: unknown[]) => (c[1] as MessagePayload).taskId);

    expect(completedIds).toEqual(['ok-1', 'ok-2']);
    expect(dlqIds).toEqual(['fail-task']);
    errSpy.mockRestore();
  });
});

// ── capDataSize edge cases ────────────────────────────────────────────

describe('AgentActor — capDataSize edge cases', () => {
  it('data with no result key (covers result ?? "" fallback)', async () => {
    const { driver, getHandler } = makeCapturingDriver();
    // Return an object without a 'result' key that is > 64KB when serialized
    const bigObj: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) bigObj[`key${i}`] = 'x'.repeat(100);
    const handler = vi.fn().mockResolvedValue(bigObj);
    const actor = new AgentActor('agent-1', driver, 'q', handler);
    await actor.start();
    await getHandler()(makePayload());

    const publishCall = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'kaiban-events-completed',
    );
    expect(publishCall).toBeDefined();
    const payload = publishCall![1] as MessagePayload;
    // capDataSize truncates result key specifically; the rest of data also gets capped
    expect(payload.data['_truncated']).toBe(true);
  });

  it('null result in handler is replaced with default success message', async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue(null);
    const actor = new AgentActor('agent-1', driver, 'q', handler);
    await actor.start();
    await getHandler()(makePayload());

    const publishCall = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'kaiban-events-completed',
    );
    const payload = publishCall![1] as MessagePayload;
    // null triggers the ?? fallback: `Actor {hash} executed successfully`
    expect(payload.data['result']).toContain('executed successfully');
  });
});

// ── DLQ payload shape edge cases ──────────────────────────────────────

describe('AgentActor — DLQ payload shape', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { errSpy.mockRestore(); });

  it('DLQ from retry exhaustion has error string but no reason field', async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockRejectedValue(new Error('kaboom'));
    const actor = new AgentActor('agent-1', driver, 'q', handler);
    await actor.start();
    await getHandler()(makePayload());

    const dlqCall = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'kaiban-events-failed',
    );
    expect(dlqCall).toBeDefined();
    const data = dlqCall![1].data;
    expect(data.error).toBe('kaboom');
    expect(data.reason).toBeUndefined(); // no reason for retry failures
  });

  it('DLQ from firewall block has both error and reason', async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const firewall = { evaluate: vi.fn().mockResolvedValue({ allowed: false, reason: 'prompt injection' }) };
    const actor = new AgentActor('agent-1', driver, 'q', undefined, { firewall });
    await actor.start();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await getHandler()(makePayload());

    const dlqCall = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'kaiban-events-failed',
    );
    expect(dlqCall).toBeDefined();
    const data = dlqCall![1].data;
    expect(data.error).toBe('blocked_by_semantic_firewall');
    expect(data.reason).toBe('prompt injection');
    warnSpy.mockRestore();
  });

  it('DLQ from circuit breaker has error but no reason', async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const breaker: ICircuitBreaker = {
      isOpen: vi.fn().mockReturnValue(true),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const actor = new AgentActor('agent-1', driver, 'q', undefined, { circuitBreaker: breaker });
    await actor.start();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await getHandler()(makePayload());

    const dlqCall = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'kaiban-events-failed',
    );
    const data = dlqCall![1].data;
    expect(data.error).toBe('circuit_breaker_open');
    expect(data.reason).toBeUndefined();
    warnSpy.mockRestore();
  });
});

// ── Timestamp & metadata integrity ────────────────────────────────────

describe('AgentActor — published event metadata', () => {
  it('completed event timestamp is a recent number (not from input payload)', async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue('done');
    const actor = new AgentActor('agent-1', driver, 'q', handler);
    await actor.start();
    const before = Date.now();
    await getHandler()(makePayload({ timestamp: 1000 })); // old timestamp
    const after = Date.now();

    const call = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'kaiban-events-completed',
    );
    const ts = call![1].timestamp;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('completed event uses actor id (not payload agentId) in published message', async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue('done');
    // Actor id is 'real-agent', but task arrives with wildcard
    const actor = new AgentActor('real-agent', driver, 'q', handler);
    await actor.start();
    await getHandler()(makePayload({ agentId: '*' }));

    const call = (driver.publish as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'kaiban-events-completed',
    );
    expect(call![1].agentId).toBe('real-agent');
  });
});
