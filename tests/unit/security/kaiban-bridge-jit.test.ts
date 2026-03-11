import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKaibanTaskHandler } from '../../../src/infrastructure/kaibanjs/kaiban-agent-bridge';
import type { IMessagingDriver, MessagePayload } from '../../../src/infrastructure/messaging/interfaces';
import type { ITokenProvider } from '../../../src/domain/security/token-provider';
import { Agent } from 'kaibanjs';

const mockWorkOnTask = vi.fn();
const mockInitialize = vi.fn();

vi.mock('kaibanjs', () => ({
  Agent: vi.fn().mockImplementation(function () {
    return { workOnTask: mockWorkOnTask, agentInstance: { initialize: mockInitialize, llmInstance: undefined } };
  }),
  Task: vi.fn().mockImplementation(function (params: Record<string, unknown>) { return { ...params }; }),
}));

function makeMockDriver(): IMessagingDriver {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

const basePayload: MessagePayload = { taskId: 'task-001', agentId: 'researcher', timestamp: Date.now(), data: {} };

describe('createKaibanTaskHandler — JIT token provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Agent).mockImplementation(function () {
      return { workOnTask: mockWorkOnTask, agentInstance: { initialize: mockInitialize, llmInstance: undefined } };
    });
    mockWorkOnTask.mockResolvedValue({ result: { finalAnswer: 'ok' } });
  });

  it('does NOT call initialize() during construction when tokenProvider is given', () => {
    const tokenProvider: ITokenProvider = {
      getToken: vi.fn().mockResolvedValue('jit-key'),
    };
    createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver(), tokenProvider);
    // With tokenProvider, init is deferred to per-task
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it('calls tokenProvider.getToken() for each LLM key on task execution', async () => {
    const tokenProvider: ITokenProvider = {
      getToken: vi.fn().mockResolvedValue(undefined),
    };
    const handler = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver(), tokenProvider);
    await handler(basePayload);

    // Should have called getToken for each of the 6 LLM key names
    const expectedKeys = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY'];
    for (const key of expectedKeys) {
      expect(tokenProvider.getToken).toHaveBeenCalledWith(key, 'task-001');
    }
  });

  it('passes JIT token values to initialize() env arg', async () => {
    const tokenProvider: ITokenProvider = {
      getToken: vi.fn().mockImplementation((key: string) => {
        if (key === 'OPENAI_API_KEY') return Promise.resolve('jit-openai-key');
        return Promise.resolve(undefined);
      }),
    };
    const handler = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver(), tokenProvider);
    await handler(basePayload);

    const envArg = mockInitialize.mock.calls[0]?.[1] as Record<string, string>;
    expect(envArg['OPENAI_API_KEY']).toBe('jit-openai-key');
    // Other keys should not be present since they returned undefined
    expect(envArg['OPENROUTER_API_KEY']).toBeUndefined();
  });

  it('re-initializes agent even when llmInstance is already set (JIT path)', async () => {
    vi.mocked(Agent).mockImplementation(function () {
      return { workOnTask: mockWorkOnTask, agentInstance: { initialize: mockInitialize, llmInstance: 'ALREADY_SET' } };
    });
    const tokenProvider: ITokenProvider = {
      getToken: vi.fn().mockResolvedValue('fresh-key'),
    };
    const handler = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver(), tokenProvider);
    await handler(basePayload);

    // With tokenProvider, should ALWAYS re-initialize even if llmInstance is set
    expect(mockInitialize).toHaveBeenCalled();
  });

  it('uses process.env fallback when no tokenProvider is given', async () => {
    process.env['OPENAI_API_KEY'] = 'env-key';
    const handler = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    await handler(basePayload);

    const envArg = mockInitialize.mock.calls[0]?.[1] as Record<string, string>;
    expect(envArg['OPENAI_API_KEY']).toBe('env-key');
    delete process.env['OPENAI_API_KEY'];
  });
});
