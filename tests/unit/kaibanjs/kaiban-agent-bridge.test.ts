import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKaibanTaskHandler } from '../../../src/infrastructure/kaibanjs/kaiban-agent-bridge';
import type { IMessagingDriver, MessagePayload } from '../../../src/infrastructure/messaging/interfaces';

const mockTeamStart = vi.fn();

vi.mock('kaibanjs', () => ({
  Agent: vi.fn().mockImplementation(function () { return {}; }),
  Task:  vi.fn().mockImplementation(function (params: Record<string, unknown>) { return { ...params }; }),
  Team:  vi.fn().mockImplementation(function (params: Record<string, unknown>) {
    return { start: mockTeamStart, ...params };
  }),
}));

function makeMockDriver(): IMessagingDriver {
  return {
    publish:     vi.fn().mockResolvedValue(undefined),
    subscribe:   vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect:  vi.fn().mockResolvedValue(undefined),
  };
}

const basePayload: MessagePayload = {
  taskId: 'task-001', agentId: 'researcher', timestamp: Date.now(), data: {},
};

/** Successful WorkflowResult with stats */
function makeSuccess(result = 'done', inputTokens = 100, outputTokens = 50, totalCost = 0.001) {
  return {
    status: 'FINISHED',
    result,
    stats: {
      llmUsageStats: { inputTokens, outputTokens, callsCount: 1 },
      costDetails: { costInputTokens: 0, costOutputTokens: 0, totalCost },
    },
  };
}

describe('createKaibanTaskHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTeamStart.mockResolvedValue(makeSuccess());
  });

  it('returns a callable task handler', () => {
    const h = createKaibanTaskHandler({ name: 'Ava', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    expect(typeof h).toBe('function');
  });

  it('calls team.start() when handler is invoked', async () => {
    const h = createKaibanTaskHandler({ name: 'Ava', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    await h(basePayload);
    expect(mockTeamStart).toHaveBeenCalledOnce();
  });

  it('passes inputs from payload to team.start()', async () => {
    const h = createKaibanTaskHandler({ name: 'Ava', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    const payload: MessagePayload = {
      ...basePayload,
      data: { instruction: 'Research AI', expectedOutput: 'Summary', inputs: { topic: 'AI' }, context: '' },
    };
    await h(payload);
    expect(mockTeamStart).toHaveBeenCalledWith({ topic: 'AI' });
  });

  it('returns KaibanHandlerResult with answer and token stats', async () => {
    mockTeamStart.mockResolvedValue(makeSuccess('my answer', 200, 80));
    const h = createKaibanTaskHandler({ name: 'Ava', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    const result = await h(basePayload) as { answer: string; inputTokens: number; outputTokens: number; estimatedCost: number };
    expect(result.answer).toBe('my answer');
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(80);
    expect(result.estimatedCost).toBeGreaterThan(0); // computed from model pricing table
  });

  it('throws when team.start() returns ERRORED status', async () => {
    mockTeamStart.mockResolvedValue({ status: 'ERRORED', result: 'LLM API Error', stats: null });
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    await expect(h(basePayload)).rejects.toThrow('KaibanJS workflow error: LLM API Error');
  });

  it('throws with "unknown" when ERRORED status has null result', async () => {
    mockTeamStart.mockResolvedValue({ status: 'ERRORED', result: null, stats: null });
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    await expect(h(basePayload)).rejects.toThrow('KaibanJS workflow error: unknown');
  });

  it('uses model-specific pricing when llmConfig.model matches a known model', async () => {
    mockTeamStart.mockResolvedValue(makeSuccess('answer', 1_000_000, 1_000_000));
    const h = createKaibanTaskHandler(
      { name: 'A', role: 'R', goal: 'G', background: 'B', llmConfig: { provider: 'openai', model: 'gpt-4o-mini' } },
      makeMockDriver(),
    );
    const result = await h(basePayload) as { estimatedCost: number };
    // gpt-4o-mini pricing: input=0.15, output=0.60 per 1M tokens → 0.15 + 0.60 = 0.75
    expect(result.estimatedCost).toBeCloseTo(0.75, 2);
  });

  it('falls back to default pricing for unknown model names', async () => {
    mockTeamStart.mockResolvedValue(makeSuccess('answer', 1_000_000, 1_000_000));
    const h = createKaibanTaskHandler(
      { name: 'A', role: 'R', goal: 'G', background: 'B', llmConfig: { provider: 'openai', model: 'unknown-model-xyz' } },
      makeMockDriver(),
    );
    const result = await h(basePayload) as { estimatedCost: number };
    // default pricing: input=1.00, output=3.00 per 1M tokens → 1.00 + 3.00 = 4.00
    expect(result.estimatedCost).toBeCloseTo(4.00, 2);
  });

  it('propagates thrown errors from team.start()', async () => {
    mockTeamStart.mockRejectedValue(new Error('network timeout'));
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    await expect(h(basePayload)).rejects.toThrow('network timeout');
  });

  it('returns zero tokens when stats is null', async () => {
    mockTeamStart.mockResolvedValue({ status: 'FINISHED', result: 'ok', stats: null });
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    const result = await h(basePayload) as { inputTokens: number; outputTokens: number; estimatedCost: number };
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.estimatedCost).toBe(0);
  });

  it('includes env vars in Team env when set', async () => {
    const { Team } = await import('kaibanjs');
    process.env['OPENAI_API_KEY'] = 'test-key';
    const h = createKaibanTaskHandler({ name: 'Ava', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    await h(basePayload);
    const teamCallArg = vi.mocked(Team).mock.calls[0]?.[0] as { env?: Record<string, string> };
    expect(teamCallArg.env?.['OPENAI_API_KEY']).toBe('test-key');
    delete process.env['OPENAI_API_KEY'];
  });
});
