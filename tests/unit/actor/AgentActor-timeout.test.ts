/**
 * AgentActor — task timeout and token budget guardrails.
 *
 * Verifies that:
 * 1. A task that exceeds taskTimeoutMs is terminated and routed to DLQ.
 * 2. A task that completes within the timeout succeeds normally.
 * 3. The AgentStatePublisher throws when maxTokenBudget is exceeded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentActor } from '../../../src/application/actor/AgentActor';
import { AgentStatePublisher } from '../../../src/adapters/state/agent-state-publisher';
import type { IMessagingDriver, MessagePayload } from '../../../src/infrastructure/messaging/interfaces';

// ── ioredis mock ─────────────────────────────────────────────────────────────
const mockPublish = vi.fn().mockResolvedValue(1);
const mockQuit = vi.fn().mockResolvedValue('OK');

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { publish: mockPublish, quit: mockQuit };
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDriver(): { driver: IMessagingDriver; getHandler: () => (p: MessagePayload) => Promise<void> } {
  let h!: (p: MessagePayload) => Promise<void>;
  const driver: IMessagingDriver = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((_q, handler) => { h = handler; return Promise.resolve(); }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return { driver, getHandler: () => h };
}

function makePayload(taskId: string): MessagePayload {
  return { taskId, agentId: 'agent-1', timestamp: Date.now(), data: {} };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AgentActor — task timeout', () => {
  it('task exceeding taskTimeoutMs is routed to DLQ', async () => {
    const { driver, getHandler } = makeDriver();
    const slowHandler = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 5000)), // 5s — much longer than timeout
    );

    const actor = new AgentActor('agent-1', driver, 'q', slowHandler, { taskTimeoutMs: 50 });
    await actor.start();

    await getHandler()(makePayload('t-slow'));

    // Handler should have been called once (it's slow, not retried because timeout = error)
    const publishCalls = (driver.publish as ReturnType<typeof vi.fn>).mock.calls;
    const dlqCall = publishCalls.find((c) => c[0] === 'kaiban-events-failed');
    expect(dlqCall).toBeDefined();
    const dlqData = dlqCall?.[1].data as Record<string, unknown>;
    expect(String(dlqData['error'])).toContain('timed out');
  });

  it('task completing within timeout succeeds normally', async () => {
    const { driver, getHandler } = makeDriver();
    const fastHandler = vi.fn().mockResolvedValue('fast-result');

    const actor = new AgentActor('agent-1', driver, 'q', fastHandler, { taskTimeoutMs: 5000 });
    await actor.start();

    await getHandler()(makePayload('t-fast'));

    const publishCalls = (driver.publish as ReturnType<typeof vi.fn>).mock.calls;
    const completedCall = publishCalls.find((c) => c[0] === 'kaiban-events-completed');
    expect(completedCall).toBeDefined();
  });
});

describe('AgentStatePublisher — token budget guardrail', () => {
  let publisher: AgentStatePublisher;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    publisher = new AgentStatePublisher(
      'redis://localhost:6379',
      { agentId: 'budget-agent', name: 'BudgetAgent', role: 'Worker' },
      { maxTokenBudget: 500 },
    );
  });

  afterEach(async () => {
    await publisher.disconnect().catch(() => {});
    vi.useRealTimers();
  });

  it('task whose cumulative tokens exceed maxTokenBudget throws BudgetExceededError', async () => {
    // First task: 300 tokens — within budget
    const handler1 = publisher.wrapHandler(async () => ({
      answer: 'First answer',
      inputTokens: 200,
      outputTokens: 100,
      estimatedCost: 0.001,
    }));
    await handler1({ taskId: 't1', agentId: 'budget-agent', timestamp: Date.now(), data: {} });

    // Second task: 300 more tokens — total 600, exceeds 500 limit
    const handler2 = publisher.wrapHandler(async () => ({
      answer: 'Second answer',
      inputTokens: 200,
      outputTokens: 100,
      estimatedCost: 0.001,
    }));
    await expect(
      handler2({ taskId: 't2', agentId: 'budget-agent', timestamp: Date.now(), data: {} }),
    ).rejects.toThrow(/Token budget exceeded/);

    // Error status should have been published
    const calls = mockPublish.mock.calls as Array<[string, string]>;
    const errorPublish = calls.find(([, data]) => {
      try {
        const parsed = JSON.parse(data);
        return parsed.agents?.[0]?.status === 'ERROR';
      } catch { return false; }
    });
    expect(errorPublish).toBeDefined();
  });

  it('budget disabled (maxTokenBudget=0) — unlimited tokens, no throw', async () => {
    const unlimitedPublisher = new AgentStatePublisher(
      'redis://localhost:6379',
      { agentId: 'unlimited', name: 'Unlimited', role: 'Worker' },
      { maxTokenBudget: 0 },
    );

    const handler = unlimitedPublisher.wrapHandler(async () => ({
      answer: 'Big result',
      inputTokens: 100_000,
      outputTokens: 100_000,
      estimatedCost: 10,
    }));

    await expect(
      handler({ taskId: 't-big', agentId: 'unlimited', timestamp: Date.now(), data: {} }),
    ).resolves.toBeDefined();

    await unlimitedPublisher.disconnect().catch(() => {});
  });
});
