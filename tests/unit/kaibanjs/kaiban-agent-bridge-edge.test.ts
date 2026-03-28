/**
 * kaiban-agent-bridge — edge cases.
 *
 * Covers:
 *   - Context merging into Task description
 *   - Task defaults (missing instruction, expectedOutput, inputs, context)
 *   - JIT token provider: fetches all API key names per-task
 *   - JIT token provider: passes taskId to getToken
 *   - JIT token provider: includes returned token in Team env
 *   - Multiple env API keys included when set
 *   - Empty env when no keys in process.env
 *   - Non-string instruction coercion
 *   - STOPPED status treated as success (not an error)
 *   - result null → answer is empty string
 */
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

function makeDriver(): IMessagingDriver {
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

function makeSuccess(result = 'done'): { status: string; result: string; stats: { llmUsageStats: { inputTokens: number; outputTokens: number; callsCount: number }; costDetails: { costInputTokens: number; costOutputTokens: number; totalCost: number } } } {
  return {
    status: 'FINISHED',
    result,
    stats: {
      llmUsageStats: { inputTokens: 10, outputTokens: 5, callsCount: 1 },
      costDetails: { costInputTokens: 0, costOutputTokens: 0, totalCost: 0.001 },
    },
  };
}

const API_KEYS = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY'];

describe('kaiban-agent-bridge — Task construction from MessagePayload', () => {
  beforeEach(() => { vi.clearAllMocks(); mockTeamStart.mockResolvedValue(makeSuccess()); });

  it('passes instruction as Task description', async () => {
    const { Task } = await import('kaibanjs');
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await h({ ...basePayload, data: { instruction: 'Research quantum computing' } });
    const taskArg = vi.mocked(Task).mock.calls[0]?.[0] as { description: string };
    expect(taskArg.description).toBe('Research quantum computing');
  });

  it('merges context into description when present', async () => {
    const { Task } = await import('kaibanjs');
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await h({ ...basePayload, data: { instruction: 'Edit', context: 'DRAFT: hello' } });
    const taskArg = vi.mocked(Task).mock.calls[0]?.[0] as { description: string };
    expect(taskArg.description).toBe('Edit\n\nContext:\nDRAFT: hello');
  });

  it('description is just instruction when context is empty', async () => {
    const { Task } = await import('kaibanjs');
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await h({ ...basePayload, data: { instruction: 'Do something', context: '' } });
    const taskArg = vi.mocked(Task).mock.calls[0]?.[0] as { description: string };
    expect(taskArg.description).toBe('Do something');
  });

  it('passes expectedOutput to Task', async () => {
    const { Task } = await import('kaibanjs');
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await h({ ...basePayload, data: { expectedOutput: 'A detailed report' } });
    const taskArg = vi.mocked(Task).mock.calls[0]?.[0] as { expectedOutput: string };
    expect(taskArg.expectedOutput).toBe('A detailed report');
  });

  it('defaults description to "Execute task" when instruction absent', async () => {
    const { Task } = await import('kaibanjs');
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await h(basePayload);
    const taskArg = vi.mocked(Task).mock.calls[0]?.[0] as { description: string };
    expect(taskArg.description).toBe('Execute task');
  });

  it('defaults expectedOutput to "Task result" when absent', async () => {
    const { Task } = await import('kaibanjs');
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await h(basePayload);
    const taskArg = vi.mocked(Task).mock.calls[0]?.[0] as { expectedOutput: string };
    expect(taskArg.expectedOutput).toBe('Task result');
  });

  it('passes empty inputs object to team.start() when absent', async () => {
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await h(basePayload);
    expect(mockTeamStart).toHaveBeenCalledWith({});
  });

  it('coerces non-string instruction with String()', async () => {
    const { Task } = await import('kaibanjs');
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await h({ ...basePayload, data: { instruction: 42 } });
    const taskArg = vi.mocked(Task).mock.calls[0]?.[0] as { description: string };
    expect(taskArg.description).toBe('42');
  });

  it('answer is empty string when result is null', async () => {
    mockTeamStart.mockResolvedValue({ status: 'FINISHED', result: null, stats: null });
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    const r = await h(basePayload) as { answer: string };
    expect(r.answer).toBe('');
  });

  it('STOPPED status is treated as success (not thrown)', async () => {
    mockTeamStart.mockResolvedValue({ status: 'STOPPED', result: 'partial', stats: null });
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await expect(h(basePayload)).resolves.toBeDefined();
  });
});

describe('kaiban-agent-bridge — env API keys without tokenProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTeamStart.mockResolvedValue(makeSuccess());
    for (const k of API_KEYS) delete process.env[k];
  });
  afterEach(() => { for (const k of API_KEYS) delete process.env[k]; });

  it('includes multiple API keys from env when set', async () => {
    const { Team } = await import('kaibanjs');
    process.env['OPENAI_API_KEY'] = 'sk-openai';
    process.env['OPENROUTER_API_KEY'] = 'sk-or';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await h(basePayload);
    const env = (vi.mocked(Team).mock.calls[0]?.[0] as { env: Record<string, string> }).env;
    expect(env['OPENAI_API_KEY']).toBe('sk-openai');
    expect(env['OPENROUTER_API_KEY']).toBe('sk-or');
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant');
  });

  it('env is empty object when no API keys are in process.env', async () => {
    const { Team } = await import('kaibanjs');
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await h(basePayload);
    const env = (vi.mocked(Team).mock.calls[0]?.[0] as { env: Record<string, string> }).env;
    expect(Object.keys(env).length).toBe(0);
  });
});

describe('kaiban-agent-bridge — JIT token provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTeamStart.mockResolvedValue(makeSuccess());
    for (const k of API_KEYS) delete process.env[k];
  });
  afterEach(() => { for (const k of API_KEYS) delete process.env[k]; });

  it('fetches all supported API key names via tokenProvider.getToken', async () => {
    const getToken = vi.fn().mockResolvedValue(null);
    const tokenProvider: ITokenProvider = { getToken };
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver(), tokenProvider);
    await h({ ...basePayload, taskId: 'task-jit' });
    const calledKeys = getToken.mock.calls.map((c) => c[0] as string);
    for (const key of API_KEYS) expect(calledKeys).toContain(key);
  });

  it('passes taskId to tokenProvider.getToken for each key', async () => {
    const getToken = vi.fn().mockResolvedValue(null);
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver(), { getToken });
    await h({ ...basePayload, taskId: 'specific-task' });
    for (const call of getToken.mock.calls) expect(call[1]).toBe('specific-task');
  });

  it('includes token in Team env when tokenProvider returns a value', async () => {
    const { Team } = await import('kaibanjs');
    const getToken = vi.fn().mockImplementation(async (key: string) =>
      key === 'OPENROUTER_API_KEY' ? 'sk-jit-token' : null,
    );
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver(), { getToken });
    await h(basePayload);
    const env = (vi.mocked(Team).mock.calls[0]?.[0] as { env: Record<string, string> }).env;
    expect(env['OPENROUTER_API_KEY']).toBe('sk-jit-token');
    expect(env['OPENAI_API_KEY']).toBeUndefined();
  });

  it('fetches fresh tokens per task invocation', async () => {
    const getToken = vi.fn().mockResolvedValue(null);
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver(), { getToken });
    await h({ ...basePayload, taskId: 'task-1' });
    await h({ ...basePayload, taskId: 'task-2' });
    // getToken called once per key per invocation = 12 total (6 keys × 2 tasks)
    expect(getToken.mock.calls.length).toBe(API_KEYS.length * 2);
  });
});
