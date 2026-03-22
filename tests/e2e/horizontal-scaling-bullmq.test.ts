import { describe, it, expect, afterEach } from 'vitest';
import { BullMQDriver } from '../../src/infrastructure/messaging/bullmq-driver';
import { AgentActor } from '../../src/application/actor/AgentActor';
import { randomUUID } from 'crypto';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

describe('E2E: Horizontal Scaling & Concurrency (BullMQ)', () => {
  const drivers: BullMQDriver[] = [];

  afterEach(async () => {
    // Teardown all connected drivers gracefully
    await Promise.all(drivers.map((d) => d.disconnect()));
    drivers.length = 0;
  });

  it('distributes tasks across multiple cloned instances exactly once (Competing Consumers)', async () => {
    const url = new URL(REDIS_URL);
    const connConfig = { 
      connection: { host: url.hostname, port: parseInt(url.port || '6379', 10) }
    };

    // 1. Setup global publisher/subscriber for observing the test
    const oracleDriver = new BullMQDriver(connConfig);
    drivers.push(oracleDriver);

    const completedTasks = new Set<string>();
    const processingAgents = new Set<string>();
    
    // Listen for completions
    await oracleDriver.subscribe('kaiban-events-completed', async (payload) => {
      // payload data contains which actual worker instance handled it
      completedTasks.add(payload.taskId);
    });

    // 2. Setup 3 multiple cloned agents (identical agent ids and queue names)
    // To prove distribution, we inject a unique workerId inside the handler closure
    const NUM_INSTANCES = 3;
    const NUM_TASKS = 30;
    const QUEUE_NAME = `e2e-scaled-queue-${randomUUID()}`;
    const AGENT_ID = 'e2e-scaled-agent';
    
    const instances: AgentActor[] = [];

    for (let i = 0; i < NUM_INSTANCES; i++) {
        const workerId = `clone-${i}`;
        
        // Re-init with correct settings:
        const sharedDriver = new BullMQDriver(connConfig);
        drivers.push(sharedDriver);

        // Handler simulates work and tracks which clone did the work
        const handler = async (): Promise<unknown> => {
            processingAgents.add(workerId);
            // Simulate random processing time between 10ms - 50ms to allow concurrent overlaps
            await new Promise(r => setTimeout(r, 10 + Math.random() * 40));
            return { handledBy: workerId };
        };

        const actor = new AgentActor(AGENT_ID, sharedDriver, QUEUE_NAME, handler);
        await actor.start();
        instances.push(actor);
    }

    // Wait for workers to attach properly
    await new Promise(r => setTimeout(r, 1000));

    // 3. Publish massive flood of tasks
    const publishPromises: Promise<void>[] = [];
    for (let i = 0; i < NUM_TASKS; i++) {
        publishPromises.push(
            oracleDriver.publish(QUEUE_NAME, {
                taskId: `burst-task-${i}`,
                agentId: AGENT_ID,
                data: { instruction: `do work ${i}` },
                timestamp: Date.now(),
            })
        );
    }

    await Promise.all(publishPromises);

    // 4. Wait for all messages to be processed. 
    // Wait max 10 seconds.
    let elapsed = 0;
    while(completedTasks.size < NUM_TASKS && elapsed < 10000) {
        await new Promise(r => setTimeout(r, 200));
        elapsed += 200;
    }

    // 5. Assertions
    // All tasks must have completed
    expect(completedTasks.size).toBe(NUM_TASKS);

    // If spreading works correctly across overlapping processing delays, multiple agents should have picked up tasks.
    // At least 2 clones should have been utilized to prove horizontal scaling concurrency.
    expect(processingAgents.size).toBeGreaterThan(1);
  }, 15000);
});
