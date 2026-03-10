import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKaibanTaskHandler } from '../../../src/infrastructure/kaibanjs/kaiban-agent-bridge';
import type { IMessagingDriver, MessagePayload } from '../../../src/infrastructure/messaging/interfaces';
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

describe('createKaibanTaskHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Agent).mockImplementation(function () {
      return { workOnTask: mockWorkOnTask, agentInstance: { initialize: mockInitialize, llmInstance: undefined } };
    });
  });

  it('returns a callable task handler', () => {
    const h = createKaibanTaskHandler({ name: 'Ava', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    expect(typeof h).toBe('function');
  });

  it('calls agentInstance.initialize() when llmInstance is unset', () => {
    createKaibanTaskHandler({ name: 'Ava', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    expect(mockInitialize).toHaveBeenCalledWith(null, expect.any(Object));
  });

  it('skips initialize() when llmInstance already set', () => {
    vi.mocked(Agent).mockImplementationOnce(function () {
      return { workOnTask: mockWorkOnTask, agentInstance: { initialize: mockInitialize, llmInstance: 'SET' } };
    });
    createKaibanTaskHandler({ name: 'Ava', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it('includes env vars in initialize() env arg when set', () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    createKaibanTaskHandler({ name: 'Ava', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    const envArg = mockInitialize.mock.calls[0]?.[1] as Record<string, string>;
    expect(envArg['OPENAI_API_KEY']).toBe('test-key');
    delete process.env['OPENAI_API_KEY'];
  });

  it('calls agent.workOnTask() with Task built from MessagePayload', async () => {
    mockWorkOnTask.mockResolvedValue({ result: { finalAnswer: 'done' } });
    const handler = createKaibanTaskHandler({ name: 'Ava', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    const payload: MessagePayload = {
      ...basePayload,
      data: { instruction: 'Research AI', expectedOutput: 'Summary', inputs: { topic: 'AI' }, context: 'ctx' },
    };
    await handler(payload);
    const [taskArg, inputsArg, contextArg] = mockWorkOnTask.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>, string];
    expect(taskArg['description']).toBe('Research AI');
    expect(inputsArg).toEqual({ topic: 'AI' });
    expect(contextArg).toBe('ctx');
  });

  it('throws when KaibanJS returns an error result (LLM API failure → retryable)', async () => {
    mockWorkOnTask.mockResolvedValue({
      error: 'Execution stopped due to a critical error: LLM API Error during executeThinking',
      metadata: { iterations: 0, maxAgentIterations: 10 },
    });
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    await expect(h(basePayload)).rejects.toThrow('KaibanJS execution error:');
  });

  it('extracts finalAnswer from nested result object', async () => {
    mockWorkOnTask.mockResolvedValue({ result: { finalAnswer: 'extracted' } });
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    expect(await h(basePayload)).toBe('extracted');
  });

  it('returns string result directly', async () => {
    mockWorkOnTask.mockResolvedValue({ result: 'plain string' });
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    expect(await h(basePayload)).toBe('plain string');
  });

  it('returns result object without finalAnswer', async () => {
    const obj = { summary: 'data' };
    mockWorkOnTask.mockResolvedValue({ result: obj });
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    expect(await h(basePayload)).toBe(obj);
  });

  it('returns full loopResult when result is null', async () => {
    const loop = { result: null, metadata: {} };
    mockWorkOnTask.mockResolvedValue(loop);
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    expect(await h(basePayload)).toBe(loop);
  });

  it('uses defaults when instruction/context absent', async () => {
    mockWorkOnTask.mockResolvedValue({ result: { finalAnswer: 'ok' } });
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    await h(basePayload);
    const [taskArg, , ctxArg] = mockWorkOnTask.mock.calls[0] as [Record<string, unknown>, unknown, string];
    expect(taskArg['description']).toBe('Execute task');
    expect(ctxArg).toBe('');
  });

  it('propagates workOnTask thrown errors', async () => {
    mockWorkOnTask.mockRejectedValueOnce(new Error('LLM timeout'));
    const h = createKaibanTaskHandler({ name: 'A', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    await expect(h(basePayload)).rejects.toThrow('LLM timeout');
  });
});
