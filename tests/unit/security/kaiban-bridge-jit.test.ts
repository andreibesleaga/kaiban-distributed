import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createKaibanTaskHandler } from '../../../src/infrastructure/kaibanjs/kaiban-agent-bridge';
import type { IMessagingDriver, MessagePayload } from '../../../src/infrastructure/messaging/interfaces';
import type { ITokenProvider } from '../../../src/domain/security/token-provider';

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

const API_KEYS = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY'];

function makeSuccess(): { status: string; result: string; stats: { llmUsageStats: { inputTokens: number; outputTokens: number; callsCount: number }; costDetails: { costInputTokens: number; costOutputTokens: number; totalCost: number } } } {
  return {
    status: 'FINISHED', result: 'ok',
    stats: { llmUsageStats: { inputTokens: 10, outputTokens: 5, callsCount: 1 }, costDetails: { costInputTokens: 0, costOutputTokens: 0, totalCost: 0 } },
  };
}

describe('createKaibanTaskHandler — JIT token provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTeamStart.mockResolvedValue(makeSuccess());
    for (const k of API_KEYS) delete process.env[k];
  });
  afterEach(() => { for (const k of API_KEYS) delete process.env[k]; });

  it('does NOT call getToken during factory construction', () => {
    const getToken = vi.fn().mockResolvedValue('jit-key');
    const tokenProvider: ITokenProvider = { getToken };
    createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver(), tokenProvider);
    expect(getToken).not.toHaveBeenCalled();
  });

  it('calls tokenProvider.getToken() for each LLM key on task execution', async () => {
    const getToken = vi.fn().mockResolvedValue(undefined);
    const tokenProvider: ITokenProvider = { getToken };
    const handler = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver(), tokenProvider);
    await handler(basePayload);
    for (const key of API_KEYS) {
      expect(getToken).toHaveBeenCalledWith(key, 'task-001');
    }
  });

  it('passes JIT token values to Team env', async () => {
    const { Team } = await import('kaibanjs');
    const getToken = vi.fn().mockImplementation((key: string) =>
      key === 'OPENAI_API_KEY' ? Promise.resolve('jit-openai-key') : Promise.resolve(undefined),
    );
    const handler = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver(), { getToken });
    await handler(basePayload);
    const env = (vi.mocked(Team).mock.calls[0]?.[0] as { env: Record<string, string> }).env;
    expect(env['OPENAI_API_KEY']).toBe('jit-openai-key');
    expect(env['OPENROUTER_API_KEY']).toBeUndefined();
  });

  it('fetches fresh tokens per-task (re-fetches on each invocation)', async () => {
    const getToken = vi.fn().mockResolvedValue(null);
    const handler = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver(), { getToken });
    await handler({ ...basePayload, taskId: 'task-1' });
    await handler({ ...basePayload, taskId: 'task-2' });
    expect(getToken.mock.calls.length).toBe(API_KEYS.length * 2);
  });

  it('uses process.env fallback when no tokenProvider is given', async () => {
    const { Team } = await import('kaibanjs');
    process.env['OPENAI_API_KEY'] = 'env-key';
    const handler = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    await handler(basePayload);
    const env = (vi.mocked(Team).mock.calls[0]?.[0] as { env: Record<string, string> }).env;
    expect(env['OPENAI_API_KEY']).toBe('env-key');
  });
});
