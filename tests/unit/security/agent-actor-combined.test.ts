import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentActor, type AgentActorDeps } from '../../../src/application/actor/AgentActor';
import type { IMessagingDriver, MessagePayload } from '../../../src/infrastructure/messaging/interfaces';
import type { ISemanticFirewall } from '../../../src/domain/security/semantic-firewall';
import type { ICircuitBreaker } from '../../../src/domain/security/circuit-breaker';

function makePayload(agentId = 'agent-1'): MessagePayload {
  return { taskId: 'task-1', agentId, timestamp: Date.now(), data: { instruction: 'test' } };
}

describe('AgentActor — combined security golden paths', () => {
  let driver: IMessagingDriver;
  let subscribedHandler: (payload: MessagePayload) => Promise<void>;

  beforeEach(() => {
    driver = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockImplementation((_q: string, handler: (p: MessagePayload) => Promise<void>) => {
        subscribedHandler = handler;
        return Promise.resolve();
      }),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
  });

  // ── Both firewall AND circuit breaker enabled, both allow ───────
  it('succeeds when both firewall allows and circuit breaker is closed', async () => {
    const firewall: ISemanticFirewall = {
      evaluate: vi.fn().mockResolvedValue({ allowed: true }),
    };
    const breaker: ICircuitBreaker = {
      isOpen: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const deps: AgentActorDeps = { firewall, circuitBreaker: breaker };
    const actor = new AgentActor('agent-1', driver, 'q', undefined, deps);
    await actor.start();
    await subscribedHandler(makePayload());

    expect(driver.publish).toHaveBeenCalledWith('kaiban-events-completed', expect.objectContaining({
      data: expect.objectContaining({ status: 'success' }),
    }));
    expect(breaker.recordSuccess).toHaveBeenCalled();
    expect(firewall.evaluate).toHaveBeenCalled();
  });

  // ── CB open blocks BEFORE firewall ever runs ────────────────────
  it('circuit breaker open blocks task before firewall is evaluated', async () => {
    const firewall: ISemanticFirewall = {
      evaluate: vi.fn().mockResolvedValue({ allowed: true }),
    };
    const breaker: ICircuitBreaker = {
      isOpen: vi.fn().mockReturnValue(true),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const deps: AgentActorDeps = { firewall, circuitBreaker: breaker };
    const actor = new AgentActor('agent-1', driver, 'q', undefined, deps);
    await actor.start();
    await subscribedHandler(makePayload());

    // Firewall should NOT have been called — CB short-circuits
    expect(firewall.evaluate).not.toHaveBeenCalled();
    expect(driver.publish).toHaveBeenCalledWith('kaiban-events-failed', expect.objectContaining({
      data: expect.objectContaining({ error: 'circuit_breaker_open' }),
    }));
  });

  // ── CB closed, firewall blocks → DLQ with firewall error ───────
  it('firewall rejection sends to DLQ even when circuit breaker is closed', async () => {
    const firewall: ISemanticFirewall = {
      evaluate: vi.fn().mockResolvedValue({ allowed: false, reason: 'injection detected' }),
    };
    const breaker: ICircuitBreaker = {
      isOpen: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const deps: AgentActorDeps = { firewall, circuitBreaker: breaker };
    const actor = new AgentActor('agent-1', driver, 'q', undefined, deps);
    await actor.start();
    await subscribedHandler(makePayload());

    expect(driver.publish).toHaveBeenCalledWith('kaiban-events-failed', expect.objectContaining({
      data: expect.objectContaining({
        error: 'blocked_by_semantic_firewall',
        reason: 'injection detected',
      }),
    }));
    // CB should NOT record either success or failure for firewall blocks
    expect(breaker.recordSuccess).not.toHaveBeenCalled();
    expect(breaker.recordFailure).not.toHaveBeenCalled();
  });

  // ── CB closed, firewall allows, handler fails → CB records failure ──
  it('handler failure records on circuit breaker when both deps present', async () => {
    const firewall: ISemanticFirewall = {
      evaluate: vi.fn().mockResolvedValue({ allowed: true }),
    };
    const breaker: ICircuitBreaker = {
      isOpen: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const failingHandler = vi.fn().mockRejectedValue(new Error('LLM timeout'));
    const deps: AgentActorDeps = { firewall, circuitBreaker: breaker };
    const actor = new AgentActor('agent-1', driver, 'q', failingHandler, deps);
    await actor.start();
    await subscribedHandler(makePayload());

    expect(breaker.recordFailure).toHaveBeenCalled();
    expect(firewall.evaluate).toHaveBeenCalled();
  });

  // ── Firewall evaluate throws an exception (not a rejection) ─────
  it('firewall exception propagates as unhandled error (fail-safe)', async () => {
    const firewall: ISemanticFirewall = {
      evaluate: vi.fn().mockRejectedValue(new Error('firewall service down')),
    };
    const deps: AgentActorDeps = { firewall };
    const actor = new AgentActor('agent-1', driver, 'q', undefined, deps);
    await actor.start();

    // If the firewall itself throws, the error propagates — this is correct
    // fail-safe behavior: if we can't evaluate the task, don't execute it
    await expect(subscribedHandler(makePayload())).rejects.toThrow('firewall service down');
  });

  // ── Agent ID mismatch is still correctly ignored ────────────────
  it('ignores tasks for different agent even with security deps', async () => {
    const firewall: ISemanticFirewall = {
      evaluate: vi.fn().mockResolvedValue({ allowed: true }),
    };
    const breaker: ICircuitBreaker = {
      isOpen: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const deps: AgentActorDeps = { firewall, circuitBreaker: breaker };
    const actor = new AgentActor('agent-1', driver, 'q', undefined, deps);
    await actor.start();
    await subscribedHandler(makePayload('different-agent'));

    // Nothing should fire — task was for a different agent
    expect(firewall.evaluate).not.toHaveBeenCalled();
    expect(breaker.isOpen).not.toHaveBeenCalled();
    expect(driver.publish).not.toHaveBeenCalled();
  });

  // ── Wildcard agent processes task ───────────────────────────────
  it('processes task when agentId is wildcard "*"', async () => {
    const deps: AgentActorDeps = {};
    const actor = new AgentActor('agent-1', driver, 'q', undefined, deps);
    await actor.start();
    await subscribedHandler(makePayload('*'));

    expect(driver.publish).toHaveBeenCalledWith('kaiban-events-completed', expect.objectContaining({
      data: expect.objectContaining({ status: 'success' }),
    }));
  });
});
