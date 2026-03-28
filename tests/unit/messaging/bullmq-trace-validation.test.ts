import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BullMQDriver } from '../../../src/infrastructure/messaging/bullmq-driver';

// Capture the processor function registered by Worker so we can call it directly
let capturedProcessor: ((job: { data: unknown }) => Promise<void>) | null = null;

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function () {
    return { add: vi.fn().mockResolvedValue({ id: 'j' }), close: vi.fn() };
  }),
  Worker: vi.fn().mockImplementation(function (_name: string, processor: (job: { data: unknown }) => Promise<void>) {
    capturedProcessor = processor;
    return { close: vi.fn() };
  }),
}));

vi.mock('@opentelemetry/api', () => ({
  context: {
    active: vi.fn().mockReturnValue({}),
    with: vi.fn().mockImplementation((_ctx: unknown, fn: () => unknown) => fn()),
  },
  propagation: { inject: vi.fn(), extract: vi.fn().mockReturnValue({}) },
  ROOT_CONTEXT: {},
}));

// Track what headers extractTraceContext was called with
const mockExtractTraceContext = vi.fn().mockReturnValue({});
vi.mock('../../../src/infrastructure/telemetry/TraceContext', () => ({
  injectTraceContext: vi.fn(),
  extractTraceContext: (headers: Record<string, string>): Record<string, unknown> => mockExtractTraceContext(headers) as Record<string, unknown>,
}));

const cfg = { connection: { host: 'localhost', port: 6379 } };

describe('BullMQDriver — traceparent header validation', () => {
  beforeEach(() => {
    capturedProcessor = null;
    mockExtractTraceContext.mockClear();
  });

  async function subscribeAndGetProcessor(handler = vi.fn()): Promise<(job: { data: unknown }) => Promise<void>> {
    const driver = new BullMQDriver(cfg);
    await driver.subscribe('test-queue', handler);
    return capturedProcessor!;
  }

  // ─── Valid traceparent ────────────────────────────────────────────────────

  it('passes a valid traceparent through to extractTraceContext', async () => {
    const processor = await subscribeAndGetProcessor();
    const validTraceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    await processor({
      data: {
        taskId: 't1', agentId: 'a', data: {}, timestamp: 0,
        traceHeaders: { traceparent: validTraceparent },
      },
    });
    const calledHeaders = mockExtractTraceContext.mock.calls[0]?.[0] as Record<string, string>;
    expect(calledHeaders['traceparent']).toBe(validTraceparent);
  });

  // ─── Invalid traceparent ─────────────────────────────────────────────────

  it('strips an invalid traceparent (wrong format) before extractTraceContext', async () => {
    const processor = await subscribeAndGetProcessor();
    await processor({
      data: {
        taskId: 't2', agentId: 'a', data: {}, timestamp: 0,
        traceHeaders: { traceparent: 'invalid-value-here' },
      },
    });
    const calledHeaders = mockExtractTraceContext.mock.calls[0]?.[0] as Record<string, string>;
    expect(calledHeaders['traceparent']).toBeUndefined();
  });

  it('strips a traceparent with wrong version prefix', async () => {
    const processor = await subscribeAndGetProcessor();
    await processor({
      data: {
        taskId: 't3', agentId: 'a', data: {}, timestamp: 0,
        traceHeaders: { traceparent: '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
      },
    });
    const calledHeaders = mockExtractTraceContext.mock.calls[0]?.[0] as Record<string, string>;
    expect(calledHeaders['traceparent']).toBeUndefined();
  });

  it('strips a traceparent with uppercase hex (must be lowercase per W3C spec)', async () => {
    const processor = await subscribeAndGetProcessor();
    await processor({
      data: {
        taskId: 't4', agentId: 'a', data: {}, timestamp: 0,
        traceHeaders: { traceparent: '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01' },
      },
    });
    const calledHeaders = mockExtractTraceContext.mock.calls[0]?.[0] as Record<string, string>;
    expect(calledHeaders['traceparent']).toBeUndefined();
  });

  // ─── Non-traceparent headers pass through ────────────────────────────────

  it('passes other header keys through unchanged', async () => {
    const processor = await subscribeAndGetProcessor();
    await processor({
      data: {
        taskId: 't5', agentId: 'a', data: {}, timestamp: 0,
        traceHeaders: { tracestate: 'vendor=value' },
      },
    });
    const calledHeaders = mockExtractTraceContext.mock.calls[0]?.[0] as Record<string, string>;
    expect(calledHeaders['tracestate']).toBe('vendor=value');
  });

  // ─── Non-string values stripped ──────────────────────────────────────────

  it('strips header entries with non-string values', async () => {
    const processor = await subscribeAndGetProcessor();
    await processor({
      data: {
        taskId: 't6', agentId: 'a', data: {}, timestamp: 0,
        traceHeaders: { traceparent: 42, tracestate: null },
      },
    });
    const calledHeaders = mockExtractTraceContext.mock.calls[0]?.[0] as Record<string, string>;
    expect(calledHeaders['traceparent']).toBeUndefined();
    expect(calledHeaders['tracestate']).toBeUndefined();
  });

  // ─── Missing / null traceHeaders ─────────────────────────────────────────

  it('passes empty object to extractTraceContext when traceHeaders is missing', async () => {
    const processor = await subscribeAndGetProcessor();
    await processor({
      data: { taskId: 't7', agentId: 'a', data: {}, timestamp: 0 },
    });
    const calledHeaders = mockExtractTraceContext.mock.calls[0]?.[0] as Record<string, string>;
    expect(calledHeaders).toEqual({});
  });

  it('passes empty object when traceHeaders is null', async () => {
    const processor = await subscribeAndGetProcessor();
    await processor({
      data: { taskId: 't8', agentId: 'a', data: {}, timestamp: 0, traceHeaders: null },
    });
    const calledHeaders = mockExtractTraceContext.mock.calls[0]?.[0] as Record<string, string>;
    expect(calledHeaders).toEqual({});
  });

  it('passes empty object when traceHeaders is a string (not an object)', async () => {
    const processor = await subscribeAndGetProcessor();
    await processor({
      data: { taskId: 't9', agentId: 'a', data: {}, timestamp: 0, traceHeaders: 'bad' },
    });
    const calledHeaders = mockExtractTraceContext.mock.calls[0]?.[0] as Record<string, string>;
    expect(calledHeaders).toEqual({});
  });
});
