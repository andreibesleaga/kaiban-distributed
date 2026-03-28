import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentStatePublisher } from '../../../src/adapters/state/agent-state-publisher';

// Mock ioredis so no real Redis connection is made
const mockPublish = vi.fn().mockResolvedValue(1);
const mockQuit = vi.fn().mockResolvedValue(undefined);

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { publish: mockPublish, quit: mockQuit };
  }),
}));

const agentInfo = { agentId: 'researcher', name: 'Ava', role: 'News Researcher' };

describe('AgentStatePublisher — channel signing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env['CHANNEL_SIGNING_SECRET'];
  });

  // ─── Without signing (legacy mode) ───────────────────────────────────────

  it('publishIdle() publishes a string to Redis STATE_CHANNEL', () => {
    const pub = new AgentStatePublisher('redis://localhost:6379', agentInfo);
    pub.publishIdle();
    expect(mockPublish).toHaveBeenCalledOnce();
    const [channel, payload] = mockPublish.mock.calls[0] as [string, string];
    expect(channel).toBe('kaiban-state-events');
    expect(typeof payload).toBe('string');
  });

  it('publishIdle() produces valid JSON payload (no signing secret)', () => {
    const pub = new AgentStatePublisher('redis://localhost:6379', agentInfo);
    pub.publishIdle();
    const [, payload] = mockPublish.mock.calls[0] as [string, string];
    const parsed = JSON.parse(payload) as { agents?: unknown[] };
    expect(parsed.agents).toBeDefined();
  });

  it('publishIdle() payload includes agent IDLE status', () => {
    const pub = new AgentStatePublisher('redis://localhost:6379', agentInfo);
    pub.publishIdle();
    const [, payload] = mockPublish.mock.calls[0] as [string, string];
    const parsed = JSON.parse(payload) as { agents: Array<{ agentId: string; status: string }> };
    expect(parsed.agents[0]?.agentId).toBe('researcher');
    expect(parsed.agents[0]?.status).toBe('IDLE');
  });

  // ─── With signing (CHANNEL_SIGNING_SECRET set) ────────────────────────────

  describe('with CHANNEL_SIGNING_SECRET', () => {
    beforeEach(() => {
      process.env['CHANNEL_SIGNING_SECRET'] = 'test-signing-secret-32bytes!!!!!';
    });

    it('publishIdle() produces a signed envelope with sig and ts fields', () => {
      const pub = new AgentStatePublisher('redis://localhost:6379', agentInfo);
      pub.publishIdle();
      const [, payload] = mockPublish.mock.calls[0] as [string, string];
      const envelope = JSON.parse(payload) as { sig?: string; ts?: number; payload?: unknown };
      expect(typeof envelope.sig).toBe('string');
      expect(envelope.sig).toHaveLength(64); // HMAC-SHA256 hex
      expect(typeof envelope.ts).toBe('number');
      expect(envelope.payload).toBeDefined();
    });

    it('signed envelope payload contains agent state', () => {
      const pub = new AgentStatePublisher('redis://localhost:6379', agentInfo);
      pub.publishIdle();
      const [, raw] = mockPublish.mock.calls[0] as [string, string];
      const envelope = JSON.parse(raw) as { payload: { agents: Array<{ agentId: string }> } };
      expect(envelope.payload.agents[0]?.agentId).toBe('researcher');
    });

    it('wrapHandler DONE branch publishes signed envelope', async () => {
      const pub = new AgentStatePublisher('redis://localhost:6379', agentInfo);
      const mockHandler = vi.fn().mockResolvedValue({ answer: 'test result', inputTokens: 10, outputTokens: 5, estimatedCost: 0.001 });

      const wrapped = pub.wrapHandler(mockHandler);
      await wrapped({ taskId: 'task-123', agentId: 'researcher', data: { instruction: 'test' }, timestamp: Date.now() });

      // Last publish call (DONE state)
      const lastCall = mockPublish.mock.calls[mockPublish.mock.calls.length - 1] as [string, string];
      const envelope = JSON.parse(lastCall[1]) as { sig?: string; payload?: { tasks?: Array<{ status: string; result: string }> } };
      expect(typeof envelope.sig).toBe('string');
      expect(envelope.payload?.tasks?.[0]?.status).toBe('DONE');
    });

    it('wrapHandler DONE branch shows answer text in task result (not raw JSON)', async () => {
      const pub = new AgentStatePublisher('redis://localhost:6379', agentInfo);
      const mockHandler = vi.fn().mockResolvedValue({
        answer: 'Clean research summary here',
        inputTokens: 100, outputTokens: 50, estimatedCost: 0.01,
      });
      const wrapped = pub.wrapHandler(mockHandler);
      await wrapped({ taskId: 'task-abc', agentId: 'researcher', data: {}, timestamp: Date.now() });

      const lastCall = mockPublish.mock.calls[mockPublish.mock.calls.length - 1] as [string, string];
      const envelope = JSON.parse(lastCall[1]) as { payload: { tasks: Array<{ result: string }> } };
      expect(envelope.payload.tasks[0]?.result).toBe('Clean research summary here');
    });
  });

  // ─── wrapHandler display result (no signing) ─────────────────────────────

  it('wrapHandler DONE branch shows answer text when KaibanHandlerResult returned', async () => {
    const pub = new AgentStatePublisher('redis://localhost:6379', agentInfo);
    const mockHandler = vi.fn().mockResolvedValue({
      answer: 'My research findings',
      inputTokens: 50, outputTokens: 20, estimatedCost: 0.005,
    });
    const wrapped = pub.wrapHandler(mockHandler);
    await wrapped({ taskId: 'task-xyz', agentId: 'researcher', data: {}, timestamp: Date.now() });

    const lastCall = mockPublish.mock.calls[mockPublish.mock.calls.length - 1] as [string, string];
    const parsed = JSON.parse(lastCall[1]) as { tasks: Array<{ result: string }> };
    expect(parsed.tasks[0]?.result).toBe('My research findings');
    // Must NOT be raw JSON
    expect(parsed.tasks[0]?.result).not.toContain('"inputTokens"');
  });

  it('wrapHandler ERROR branch publishes BLOCKED task status', async () => {
    const pub = new AgentStatePublisher('redis://localhost:6379', agentInfo);
    const mockHandler = vi.fn().mockRejectedValue(new Error('LLM failure'));
    const wrapped = pub.wrapHandler(mockHandler);
    await expect(wrapped({ taskId: 'task-err', agentId: 'researcher', data: {}, timestamp: Date.now() })).rejects.toThrow('LLM failure');

    const lastCall = mockPublish.mock.calls[mockPublish.mock.calls.length - 1] as [string, string];
    const parsed = JSON.parse(lastCall[1]) as { tasks: Array<{ status: string }> };
    expect(parsed.tasks[0]?.status).toBe('BLOCKED');
  });
});
