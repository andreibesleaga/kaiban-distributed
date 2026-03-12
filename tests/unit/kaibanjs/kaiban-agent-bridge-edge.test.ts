/**
 * kaiban-agent-bridge — edge cases and uncovered branch coverage.
 *
 * Covers:
 *   - `!internal` early-return branch (line 56): agent without agentInstance
 *   - JIT token provider: re-initialises on every call even if llmInstance is set
 *   - JIT token provider: fetches each supported API key name
 *   - JIT token provider: handles missing tokens gracefully (not added to env)
 *   - extractFinalAnswer: all result shape variants
 *   - Task defaults (missing instruction, expectedOutput, inputs, context)
 *   - Thrown errors from workOnTask propagate through handler
 *   - Multiple env API keys included when set
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createKaibanTaskHandler } from '../../../src/infrastructure/kaibanjs/kaiban-agent-bridge';
import type { IMessagingDriver, MessagePayload } from '../../../src/infrastructure/messaging/interfaces';
import type { ITokenProvider } from '../../../src/domain/security/token-provider';
import { Agent } from 'kaibanjs';

const mockWorkOnTask = vi.fn();
const mockInitialize = vi.fn();

vi.mock('kaibanjs', () => ({
  Agent: vi.fn().mockImplementation(function () {
    return {
      workOnTask: mockWorkOnTask,
      agentInstance: { initialize: mockInitialize, llmInstance: undefined },
    };
  }),
  Task: vi.fn().mockImplementation(function (params: Record<string, unknown>) { return { ...params }; }),
}));

function makeDriver(): IMessagingDriver {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

const basePayload: MessagePayload = {
  taskId: 'task-001', agentId: 'researcher', timestamp: Date.now(), data: {},
};

describe('kaiban-agent-bridge — !internal early-return branch (line 56)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Agent with NO agentInstance property
    vi.mocked(Agent).mockImplementation(function () {
      return { workOnTask: mockWorkOnTask }; // agentInstance is undefined
    });
  });

  it('does not crash when agentInstance is missing on factory creation', () => {
    expect(() =>
      createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver()),
    ).not.toThrow();
  });

  it('does not call initialize() when agentInstance is missing', async () => {
    // Allow void initializeAgentLLM to settle
    createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it('handler still calls workOnTask even when agentInstance is missing', async () => {
    mockWorkOnTask.mockResolvedValue({ result: { finalAnswer: 'fallback result' } });
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    const result = await h(basePayload);
    expect(mockWorkOnTask).toHaveBeenCalledOnce();
    expect(result).toBe('fallback result');
  });
});

describe('kaiban-agent-bridge — JIT token provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Agent).mockImplementation(function () {
      return {
        workOnTask: mockWorkOnTask,
        agentInstance: { initialize: mockInitialize, llmInstance: 'already-set' },
      };
    });
    mockWorkOnTask.mockResolvedValue({ result: { finalAnswer: 'ok' } });
  });

  it('with tokenProvider, re-initialises even when llmInstance is already set', async () => {
    const tokenProvider: ITokenProvider = {
      getToken: vi.fn().mockResolvedValue(null),
    };
    const h = createKaibanTaskHandler(
      { name: 'A', role: 'R', goal: 'G', background: 'B' },
      makeDriver(),
      tokenProvider,
    );
    await h(basePayload);
    // initialize must be called at handler invocation time (not on factory creation)
    expect(mockInitialize).toHaveBeenCalledOnce();
  });

  it('without tokenProvider, does NOT re-initialise when llmInstance is already set', async () => {
    // llmInstance is 'already-set' from mock above, no tokenProvider
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await h(basePayload);
    // Only the initial sync call (which skips because llmInstance is set) — 0 calls total
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it('fetches all supported API key names via tokenProvider.getToken', async () => {
    const getToken = vi.fn().mockResolvedValue(null);
    const tokenProvider: ITokenProvider = { getToken };
    const h = createKaibanTaskHandler(
      { name: 'A', role: 'R', goal: 'G', background: 'B' },
      makeDriver(),
      tokenProvider,
    );
    await h({ ...basePayload, taskId: 'task-jit' });
    const calledKeys = getToken.mock.calls.map((c) => c[0] as string);
    expect(calledKeys).toContain('OPENAI_API_KEY');
    expect(calledKeys).toContain('OPENROUTER_API_KEY');
    expect(calledKeys).toContain('ANTHROPIC_API_KEY');
    expect(calledKeys).toContain('GOOGLE_API_KEY');
    expect(calledKeys).toContain('MISTRAL_API_KEY');
    expect(calledKeys).toContain('GROQ_API_KEY');
  });

  it('passes taskId to tokenProvider.getToken for each key', async () => {
    const getToken = vi.fn().mockResolvedValue(null);
    const h = createKaibanTaskHandler(
      { name: 'A', role: 'R', goal: 'G', background: 'B' },
      makeDriver(),
      { getToken },
    );
    await h({ ...basePayload, taskId: 'specific-task' });
    for (const call of getToken.mock.calls) {
      expect(call[1]).toBe('specific-task');
    }
  });

  it('includes token in env when tokenProvider returns a value', async () => {
    const getToken = vi.fn().mockImplementation(async (key: string) => {
      if (key === 'OPENROUTER_API_KEY') return 'sk-jit-token';
      return null;
    });
    const h = createKaibanTaskHandler(
      { name: 'A', role: 'R', goal: 'G', background: 'B' },
      makeDriver(),
      { getToken },
    );
    await h(basePayload);
    const envArg = mockInitialize.mock.calls[0][1] as Record<string, string>;
    expect(envArg['OPENROUTER_API_KEY']).toBe('sk-jit-token');
    expect(envArg['OPENAI_API_KEY']).toBeUndefined();
  });

  it('calls handler multiple times: re-initialises on each call (fresh JIT tokens)', async () => {
    let callCount = 0;
    const getToken = vi.fn().mockImplementation(async () => {
      callCount++;
      return callCount <= 6 ? 'token-call-1' : 'token-call-2';
    });
    const h = createKaibanTaskHandler(
      { name: 'A', role: 'R', goal: 'G', background: 'B' },
      makeDriver(),
      { getToken },
    );
    await h({ ...basePayload, taskId: 'task-1' });
    await h({ ...basePayload, taskId: 'task-2' });
    // initialize() called once per handler invocation
    expect(mockInitialize).toHaveBeenCalledTimes(2);
  });
});

describe('kaiban-agent-bridge — env API keys without tokenProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Agent).mockImplementation(function () {
      return {
        workOnTask: mockWorkOnTask,
        agentInstance: { initialize: mockInitialize, llmInstance: undefined },
      };
    });
    // Clean env before each test
    const keysToDelete = [
      'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY',
      'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY',
    ];
    for (const k of keysToDelete) delete process.env[k];
  });

  afterEach(() => {
    const keysToDelete = [
      'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY',
      'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY',
    ];
    for (const k of keysToDelete) delete process.env[k];
  });

  it('includes multiple API keys from env when all are set', () => {
    process.env['OPENAI_API_KEY'] = 'sk-openai';
    process.env['OPENROUTER_API_KEY'] = 'sk-or';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    const env = mockInitialize.mock.calls[0][1] as Record<string, string>;
    expect(env['OPENAI_API_KEY']).toBe('sk-openai');
    expect(env['OPENROUTER_API_KEY']).toBe('sk-or');
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant');
  });

  it('env is empty object when no API keys are in process.env', () => {
    createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    const env = mockInitialize.mock.calls[0][1] as Record<string, string>;
    expect(Object.keys(env).length).toBe(0);
  });
});

describe('kaiban-agent-bridge — task construction from MessagePayload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Agent).mockImplementation(function () {
      return {
        workOnTask: mockWorkOnTask,
        agentInstance: { initialize: mockInitialize, llmInstance: undefined },
      };
    });
    mockWorkOnTask.mockResolvedValue({ result: { finalAnswer: 'done' } });
  });

  it('passes instruction from data to Task description', async () => {
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    const p: MessagePayload = {
      ...basePayload,
      data: { instruction: 'Research quantum computing', expectedOutput: 'Report' },
    };
    await h(p);
    const [taskArg] = mockWorkOnTask.mock.calls[0] as [Record<string, unknown>];
    expect(taskArg['description']).toBe('Research quantum computing');
  });

  it('passes expectedOutput to Task expectedOutput', async () => {
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    const p: MessagePayload = {
      ...basePayload,
      data: { instruction: 'Task', expectedOutput: 'A detailed report with citations' },
    };
    await h(p);
    const [taskArg] = mockWorkOnTask.mock.calls[0] as [Record<string, unknown>];
    expect(taskArg['expectedOutput']).toBe('A detailed report with citations');
  });

  it('passes inputs object from data to workOnTask', async () => {
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    const p: MessagePayload = {
      ...basePayload,
      data: {
        instruction: 'Write about {topic}',
        inputs: { topic: 'AI agents', year: 2025 },
      },
    };
    await h(p);
    const [, inputsArg] = mockWorkOnTask.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(inputsArg).toEqual({ topic: 'AI agents', year: 2025 });
  });

  it('passes context string from data to workOnTask', async () => {
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    const p: MessagePayload = {
      ...basePayload,
      data: { instruction: 'Edit', context: 'PREVIOUS DRAFT: The quick brown fox...' },
    };
    await h(p);
    const [, , ctxArg] = mockWorkOnTask.mock.calls[0] as [unknown, unknown, string];
    expect(ctxArg).toBe('PREVIOUS DRAFT: The quick brown fox...');
  });

  it('defaults description to "Execute task" when instruction is absent', async () => {
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await h(basePayload);
    const [taskArg] = mockWorkOnTask.mock.calls[0] as [Record<string, unknown>];
    expect(taskArg['description']).toBe('Execute task');
  });

  it('defaults expectedOutput to "Task result" when absent', async () => {
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await h(basePayload);
    const [taskArg] = mockWorkOnTask.mock.calls[0] as [Record<string, unknown>];
    expect(taskArg['expectedOutput']).toBe('Task result');
  });

  it('defaults context to empty string when absent', async () => {
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await h(basePayload);
    const [, , ctxArg] = mockWorkOnTask.mock.calls[0] as [unknown, unknown, string];
    expect(ctxArg).toBe('');
  });

  it('defaults inputs to empty object when absent', async () => {
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await h(basePayload);
    const [, inputsArg] = mockWorkOnTask.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(inputsArg).toEqual({});
  });

  it('non-string instruction is coerced with String()', async () => {
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    const p: MessagePayload = { ...basePayload, data: { instruction: 42 } };
    await h(p);
    const [taskArg] = mockWorkOnTask.mock.calls[0] as [Record<string, unknown>];
    expect(taskArg['description']).toBe('42');
  });
});

describe('kaiban-agent-bridge — extractFinalAnswer variants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Agent).mockImplementation(function () {
      return {
        workOnTask: mockWorkOnTask,
        agentInstance: { initialize: mockInitialize, llmInstance: undefined },
      };
    });
  });

  it('extracts finalAnswer string from result.finalAnswer', async () => {
    mockWorkOnTask.mockResolvedValue({ result: { finalAnswer: 'The answer is 42' } });
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    expect(await h(basePayload)).toBe('The answer is 42');
  });

  it('returns string result directly when result is a plain string', async () => {
    mockWorkOnTask.mockResolvedValue({ result: 'plain string result' });
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    expect(await h(basePayload)).toBe('plain string result');
  });

  it('returns result object when result has no finalAnswer field', async () => {
    const obj = { summary: 'data', count: 5 };
    mockWorkOnTask.mockResolvedValue({ result: obj });
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    expect(await h(basePayload)).toBe(obj);
  });

  it('returns full loopResult when result is null', async () => {
    const loop = { result: null, metadata: { extra: true } };
    mockWorkOnTask.mockResolvedValue(loop);
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    expect(await h(basePayload)).toBe(loop);
  });

  it('returns full loopResult when result is undefined', async () => {
    const loop = { result: undefined };
    mockWorkOnTask.mockResolvedValue(loop);
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    const res = await h(basePayload);
    // result is falsy, so extractFinalAnswer returns loopResult
    expect(res).toBe(loop);
  });

  it('throws with KaibanJS error message when error field is present', async () => {
    mockWorkOnTask.mockResolvedValue({
      error: 'LLM API Error during executeThinking',
      metadata: { iterations: 3, maxAgentIterations: 10 },
    });
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await expect(h(basePayload)).rejects.toThrow('KaibanJS execution error: LLM API Error');
  });

  it('throws when error field is non-empty string', async () => {
    mockWorkOnTask.mockResolvedValue({
      error: 'Rate limit exceeded',
      metadata: { iterations: 0, maxAgentIterations: 5 },
    });
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await expect(h(basePayload)).rejects.toThrow('KaibanJS execution error');
  });

  it('propagates rejection from workOnTask directly', async () => {
    mockWorkOnTask.mockRejectedValue(new Error('network timeout'));
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    await expect(h(basePayload)).rejects.toThrow('network timeout');
  });

  it('finalAnswer undefined in result object falls through to returning result', async () => {
    // result.finalAnswer exists but is explicitly undefined — typeof check in code
    const obj = { finalAnswer: undefined };
    mockWorkOnTask.mockResolvedValue({ result: obj });
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeDriver());
    // finalAnswer is undefined, so r = obj, 'finalAnswer' in r is true, return r.finalAnswer = undefined
    const result = await h(basePayload);
    expect(result).toBeUndefined();
  });
});
