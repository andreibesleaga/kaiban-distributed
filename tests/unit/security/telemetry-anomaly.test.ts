import { describe, it, expect, vi } from 'vitest';
import { recordAnomalyEvent } from '../../../src/infrastructure/telemetry/telemetry';
import { trace } from '@opentelemetry/api';

vi.mock('@opentelemetry/api', () => {
  const addEventMock = vi.fn();
  return {
    trace: {
      getActiveSpan: vi.fn().mockReturnValue({ addEvent: addEventMock }),
    },
    // re-export the mock so tests can access it
    __mockAddEvent: addEventMock,
  };
});

describe('recordAnomalyEvent', () => {
  it('adds event to active span when span exists', () => {
    const mockSpan = trace.getActiveSpan() as unknown as { addEvent: ReturnType<typeof vi.fn> };
    recordAnomalyEvent('circuit_breaker_trip', { agentId: 'a1', threshold: 5 });
    expect(mockSpan.addEvent).toHaveBeenCalledWith('circuit_breaker_trip', { agentId: 'a1', threshold: 5 });
  });

  it('does not throw when no active span', () => {
    vi.mocked(trace.getActiveSpan).mockReturnValueOnce(undefined);
    expect(() => recordAnomalyEvent('test_event', { key: 'val' })).not.toThrow();
  });
});
