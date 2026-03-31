/**
 * E2E: Distributed Event Isolation
 *
 * Tests that concurrent state publishers, task completions, and channel-signed
 * messages don't interfere with each other; and that queue isolation holds.
 *
 * Requires: Redis running via docker-compose (started by globalSetup)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { BullMQDriver } from '../../src/infrastructure/messaging/bullmq-driver';
import { AgentActor } from '../../src/application/actor/AgentActor';
import { wrapSigned, unwrapVerified } from '../../src/infrastructure/security/channel-signing';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const COMPLETED_CHANNEL = 'kaiban-events-completed';

function connConfig(): { connection: { host: string; port: number } } {
  const url = new URL(REDIS_URL);
  return { connection: { host: url.hostname, port: parseInt(url.port || '6379', 10) } };
}

async function waitUntil(pred: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

describe('E2E: Distributed Event Isolation', () => {
  const drivers: BullMQDriver[] = [];
  const redisClients: Redis[] = [];

  afterEach(async () => {
    await Promise.all(drivers.map((d) => d.disconnect()));
    await Promise.all(redisClients.map((r) => r.quit().catch(() => {})));
    drivers.length = 0;
    redisClients.length = 0;
  });

  it('concurrent state publishers: both deltas received without corruption', async () => {
    const prefix = randomUUID().slice(0, 8);
    const channel = `test-state-${prefix}`;

    const pub1 = new Redis(REDIS_URL);
    const pub2 = new Redis(REDIS_URL);
    const sub = new Redis(REDIS_URL);
    redisClients.push(pub1, pub2, sub);

    const received: Record<string, unknown>[] = [];
    sub.on('message', (_ch: string, data: string) => {
      try { received.push(JSON.parse(data)); } catch {}
    });
    await sub.subscribe(channel);

    // Publish concurrently from two publishers
    const delta1 = { agentId: 'agent-1', status: 'EXECUTING' };
    const delta2 = { agentId: 'agent-2', status: 'IDLE' };
    await Promise.all([
      pub1.publish(channel, JSON.stringify(delta1)),
      pub2.publish(channel, JSON.stringify(delta2)),
    ]);

    await waitUntil(() => received.length >= 2, 3000);
    expect(received).toHaveLength(2);

    const agentIds = received.map((r) => r['agentId']);
    expect(agentIds).toContain('agent-1');
    expect(agentIds).toContain('agent-2');
  }, 10000);

  it('task completions keyed by taskId: order does not matter', async () => {
    const prefix = randomUUID().slice(0, 8);
    const queue = `iso-queue-${prefix}`;

    const pubDriver = new BullMQDriver(connConfig());
    const conDriver = new BullMQDriver(connConfig());
    drivers.push(pubDriver, conDriver);

    const completed = new Map<string, unknown>();
    await pubDriver.subscribe(COMPLETED_CHANNEL, async (payload) => {
      completed.set(payload.taskId, payload.data);
    });

    const actor = new AgentActor(`iso-agent-${prefix}`, conDriver, queue, async (p) => `result-${p.taskId}`);
    await actor.start();
    await new Promise((r) => setTimeout(r, 200));

    const t1 = `${prefix}-t1`;
    const t2 = `${prefix}-t2`;

    // Publish two tasks
    await pubDriver.publish(queue, { taskId: t1, agentId: `iso-agent-${prefix}`, data: {}, timestamp: Date.now() });
    await pubDriver.publish(queue, { taskId: t2, agentId: `iso-agent-${prefix}`, data: {}, timestamp: Date.now() });

    await waitUntil(() => completed.size >= 2, 10000);
    expect(completed.has(t1)).toBe(true);
    expect(completed.has(t2)).toBe(true);
  }, 15000);

  it('channel-signed messages under concurrent load: all unwrap correctly', async () => {
    const prefix = randomUUID().slice(0, 8);
    const channel = `test-signed-${prefix}`;

    const pub = new Redis(REDIS_URL);
    const sub = new Redis(REDIS_URL);
    redisClients.push(pub, sub);

    const received: (Record<string, unknown> | null)[] = [];
    sub.on('message', (_ch: string, data: string) => {
      received.push(unwrapVerified(data));
    });
    await sub.subscribe(channel);

    // Publish 10 signed messages concurrently
    const messages = Array.from({ length: 10 }, (_, i) => ({ index: i, data: `msg-${prefix}-${i}` }));
    await Promise.all(messages.map((m) => pub.publish(channel, wrapSigned(m))));

    await waitUntil(() => received.length >= 10, 5000);
    expect(received).toHaveLength(10);

    // All should unwrap successfully (no nulls, assuming no CHANNEL_SIGNING_SECRET set → passthrough)
    for (const msg of received) {
      expect(msg).not.toBeNull();
      expect(msg).toHaveProperty('index');
      expect(msg).toHaveProperty('data');
    }

    // All 10 unique indices present
    const indices = new Set(received.map((m) => (m as Record<string, unknown>)['index']));
    expect(indices.size).toBe(10);
  }, 10000);

  it('queue isolation: task on queue-A not received by actor on queue-B', async () => {
    const prefix = randomUUID().slice(0, 8);
    const queueA = `iso-qA-${prefix}`;
    const queueB = `iso-qB-${prefix}`;

    const pubDriver = new BullMQDriver(connConfig());
    const conDriverA = new BullMQDriver(connConfig());
    const conDriverB = new BullMQDriver(connConfig());
    drivers.push(pubDriver, conDriverA, conDriverB);

    const receivedA: string[] = [];
    const receivedB: string[] = [];

    const actorA = new AgentActor(`agentA-${prefix}`, conDriverA, queueA, async (p) => { receivedA.push(p.taskId); return ''; });
    const actorB = new AgentActor(`agentB-${prefix}`, conDriverB, queueB, async (p) => { receivedB.push(p.taskId); return ''; });

    await actorA.start();
    await actorB.start();
    await new Promise((r) => setTimeout(r, 200));

    // Publish only to queue-A
    await pubDriver.publish(queueA, { taskId: `${prefix}-only-A`, agentId: `agentA-${prefix}`, data: {}, timestamp: Date.now() });

    await waitUntil(() => receivedA.length >= 1, 5000);
    // Give extra time to ensure B doesn't receive it
    await new Promise((r) => setTimeout(r, 500));

    expect(receivedA).toEqual([`${prefix}-only-A`]);
    expect(receivedB).toHaveLength(0);
  }, 15000);
});
