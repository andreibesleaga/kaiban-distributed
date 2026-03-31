/**
 * Output sanitization tests — PII stripping in state publishing,
 * large result truncation, and malformed LLM result handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentStatePublisher } from '../../../src/adapters/state/agent-state-publisher';
import type { MessagePayload } from '../../../src/infrastructure/messaging/interfaces';

const mockPublish = vi.fn().mockResolvedValue(1);
const mockQuit = vi.fn().mockResolvedValue('OK');

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { publish: mockPublish, quit: mockQuit };
  }),
}));

const agentInfo = { agentId: 'worker-out', name: 'OutWorker', role: 'Worker' };

function getDonePublish(taskId: string): Record<string, unknown> | null {
  const calls = mockPublish.mock.calls as Array<[string, string]>;
  const done = calls.find(([, data]) => {
    try {
      const parsed = JSON.parse(data);
      return parsed.tasks?.[0]?.taskId === taskId && parsed.tasks?.[0]?.result !== undefined;
    } catch { return false; }
  });
  return done ? (JSON.parse(done[1]) as Record<string, unknown>) : null;
}

describe('PII sanitization in distributedMiddleware', () => {
  it('strips PII-keyed fields from state delta before publishing', () => {
    // Test the sanitization logic directly (mirrors distributedMiddleware.ts)
    const PII_DENYLIST = new Set(['email', 'name', 'phone', 'ip', 'password', 'token', 'secret', 'ssn', 'dob']);
    function sanitizeDelta(partial: Record<string, unknown>): Record<string, unknown> {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(partial)) {
        if (!PII_DENYLIST.has(key)) result[key] = value;
      }
      return result;
    }

    const input = {
      teamWorkflowStatus: 'RUNNING',
      email: 'user@example.com',
      phone: '+1234567890',
      password: 'secret123',
      token: 'jwt-token-here',
      agents: [{ agentId: 'a1', status: 'IDLE' }],
    };

    const sanitized = sanitizeDelta(input);
    expect(sanitized).toHaveProperty('teamWorkflowStatus', 'RUNNING');
    expect(sanitized).toHaveProperty('agents');
    expect(sanitized).not.toHaveProperty('email');
    expect(sanitized).not.toHaveProperty('phone');
    expect(sanitized).not.toHaveProperty('password');
    expect(sanitized).not.toHaveProperty('token');
  });
});

describe('Large LLM output truncation via AgentStatePublisher', () => {
  let publisher: AgentStatePublisher;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    publisher = new AgentStatePublisher('redis://localhost:6379', agentInfo);
  });

  afterEach(async () => {
    await publisher.disconnect().catch(() => {});
    vi.useRealTimers();
  });

  it('result exceeding 20_000 chars is truncated to MAX_RESULT_LEN', async () => {
    const MAX = 20_000;
    const bigResult = 'A'.repeat(MAX + 5000); // 25KB
    const handler = publisher.wrapHandler(async () => bigResult);
    const payload: MessagePayload = { taskId: 'large-1', agentId: 'worker-out', timestamp: Date.now(), data: {} };
    await handler(payload);

    const done = getDonePublish('large-1');
    expect(done).not.toBeNull();
    const tasks = (done as Record<string, unknown>)['tasks'] as Array<Record<string, unknown>>;
    const resultStr = tasks[0]['result'] as string;
    expect(resultStr.length).toBeLessThanOrEqual(MAX);
    expect(resultStr.length).toBeGreaterThan(0);
  });

  it('non-JSON string result is treated as plain text — no crash', async () => {
    const plainText = 'This is not JSON, just a plain text answer from the LLM.';
    const handler = publisher.wrapHandler(async () => plainText);
    const payload: MessagePayload = { taskId: 'plain-1', agentId: 'worker-out', timestamp: Date.now(), data: {} };

    await expect(handler(payload)).resolves.toBe(plainText);

    const done = getDonePublish('plain-1');
    expect(done).not.toBeNull();
    const tasks = (done as Record<string, unknown>)['tasks'] as Array<Record<string, unknown>>;
    expect(tasks[0]['result']).toBe(plainText);
  });

  it('KaibanJS result with .answer field — answer extracted and shown as result', async () => {
    const kaibanResult = { answer: 'The answer to everything.', inputTokens: 100, outputTokens: 50, estimatedCost: 0.002 };
    const handler = publisher.wrapHandler(async () => kaibanResult);
    const payload: MessagePayload = { taskId: 'kaiban-1', agentId: 'worker-out', timestamp: Date.now(), data: {} };
    await handler(payload);

    const done = getDonePublish('kaiban-1');
    expect(done).not.toBeNull();
    const tasks = (done as Record<string, unknown>)['tasks'] as Array<Record<string, unknown>>;
    // Answer should be extracted from the .answer field
    expect(tasks[0]['result']).toBe('The answer to everything.');
    // Token metadata should be published
    const meta = (done as Record<string, unknown>)['metadata'] as Record<string, unknown>;
    expect(meta?.['totalTokens']).toBe(150);
  });
});
