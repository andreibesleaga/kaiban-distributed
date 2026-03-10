import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKaibanTaskHandler } from '../../../src/infrastructure/kaibanjs/kaiban-agent-bridge';
import type { IMessagingDriver, MessagePayload } from '../../../src/infrastructure/messaging/interfaces';

const mockWorkOnTask = vi.fn();
const mockInitialize = vi.fn();

// Default mock: no llmInstance yet (needs initialization)
vi.mock('kaibanjs', () => ({
  Agent: vi.fn().mockImplementation(function () {
    return {
      workOnTask: mockWorkOnTask,
      agentInstance: { initialize: mockInitialize, llmInstance: undefined },
    };
  }),
  Task: vi.fn().mockImplementation(function (params: Record<string, unknown>) {
    return { ...params };
  }),
}));

function makeMockDriver(): IMessagingDriver {
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

import { Agent } from 'kaibanjs';

describe('createKaibanTaskHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default: llmInstance undefined, so initialize() is called
    vi.mocked(Agent).mockImplementation(function () {
      return {
        workOnTask: mockWorkOnTask,
        agentInstance: { initialize: mockInitialize, llmInstance: undefined },
      };
    });
  });

  it('returns a callable task handler', () => {
    const handler = createKaibanTaskHandler(
      { name: 'Ava', role: 'Researcher', goal: 'Research', background: 'Expert' },
      makeMockDriver(),
    );
    expect(typeof handler).toBe('function');
  });

  it('calls agentInstance.initialize() to bootstrap LLM when not yet initialized', () => {
    createKaibanTaskHandler({ name: 'Ava', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    expect(mockInitialize).toHaveBeenCalledWith(null, expect.any(Object));
  });

  it('skips initialize() when llmInstance already set (covers early return branch)', () => {
    vi.mocked(Agent).mockImplementationOnce(function () {
      return {
        workOnTask: mockWorkOnTask,
        agentInstance: { initialize: mockInitialize, llmInstance: 'already-set' },
      };
    });
    createKaibanTaskHandler({ name: 'Ava', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it('calls agent.workOnTask() with Task built from MessagePayload', async () => {
    mockWorkOnTask.mockResolvedValue({ result: { finalAnswer: 'research complete' } });
    const handler = createKaibanTaskHandler(
      { name: 'Ava', role: 'Researcher', goal: 'Research topics', background: 'Expert' },
      makeMockDriver(),
    );
    const payload: MessagePayload = {
      ...basePayload,
      data: { instruction: 'Research AI news', expectedOutput: 'A summary', inputs: { topic: 'AI' }, context: 'prior' },
    };
    const result = await handler(payload);
    expect(mockWorkOnTask).toHaveBeenCalledOnce();
    const [taskArg, inputsArg, contextArg] = mockWorkOnTask.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>, string];
    expect(taskArg['description']).toBe('Research AI news');
    expect(inputsArg).toEqual({ topic: 'AI' });
    expect(contextArg).toBe('prior');
    expect(result).toBe('research complete');
  });

  it('extracts finalAnswer from nested result object', async () => {
    mockWorkOnTask.mockResolvedValue({ result: { finalAnswer: 'extracted answer' } });
    const handler = createKaibanTaskHandler({ name: 'Ava', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    expect(await handler(basePayload)).toBe('extracted answer');
  });

  it('returns string result directly when result is a string', async () => {
    mockWorkOnTask.mockResolvedValue({ result: 'plain string answer' });
    const handler = createKaibanTaskHandler({ name: 'Ava', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    expect(await handler(basePayload)).toBe('plain string answer');
  });

  it('returns result object when it has no finalAnswer property', async () => {
    const resultObj = { summary: 'no finalAnswer' };
    mockWorkOnTask.mockResolvedValue({ result: resultObj });
    const handler = createKaibanTaskHandler({ name: 'Ava', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    expect(await handler(basePayload)).toBe(resultObj);
  });

  it('returns full loopResult when result is null', async () => {
    const loopResult = { result: null, metadata: { iterations: 1 } };
    mockWorkOnTask.mockResolvedValue(loopResult);
    const handler = createKaibanTaskHandler({ name: 'Ava', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    expect(await handler(basePayload)).toBe(loopResult);
  });

  it('uses default values when instruction/context absent', async () => {
    mockWorkOnTask.mockResolvedValue({ result: { finalAnswer: 'ok' } });
    const handler = createKaibanTaskHandler({ name: 'Kai', role: 'Writer', goal: 'Write', background: 'Expert' }, makeMockDriver());
    await handler(basePayload);
    const [taskArg, , contextArg] = mockWorkOnTask.mock.calls[0] as [Record<string, unknown>, unknown, string];
    expect(taskArg['description']).toBe('Execute task');
    expect(contextArg).toBe('');
  });

  it('propagates workOnTask errors (handled by AgentActor retry)', async () => {
    mockWorkOnTask.mockRejectedValueOnce(new Error('LLM timeout'));
    const handler = createKaibanTaskHandler({ name: 'Ava', role: 'R', goal: 'G', background: 'B' }, makeMockDriver());
    await expect(handler(basePayload)).rejects.toThrow('LLM timeout');
  });
});
