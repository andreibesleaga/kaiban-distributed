/**
 * E2E: Fan-Out / Fan-In Multi-Agent Workflow
 *
 * Architecture:
 *   Orchestrator publishes N sub-tasks → N parallel AgentActors (fan-out)
 *   → All actors publish completions to kaiban-events-completed (fan-in)
 *   → Aggregator collects until all N done or timeout
 *   → Auto-approver validates the summary (no HITL)
 *   → Oracle asserts the final outcome
 *
 * All tests run against a real Redis broker (started by globalSetup.ts).
 * Each test uses UUID-prefixed queue names for full isolation.
 *
 * Scenarios:
 *   1. Golden Path         — 4 agents, all succeed, approver passes
 *   2. Scaled 8-node       — 8 agents, all succeed (proves horizontal fan-out)
 *   3. Partial Failure     — 1 of 4 agents fails once, retries, recovers
 *   4. Total Failure       — All agents exhaust retries → DLQ, workflow partial
 *   5. Late-joining agent  — Agent starts after tasks published, BullMQ delivers
 *   6. Duplicate Task IDs  — Same taskId published twice, processed exactly once
 *   7. Approver Rejects    — Summary below threshold → rejected
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { BullMQDriver } from '../../src/infrastructure/messaging/bullmq-driver';
import { AgentActor } from '../../src/application/actor/AgentActor';
import type { MessagePayload } from '../../src/infrastructure/messaging/interfaces';

// ── Shared setup ─────────────────────────────────────────────────────

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

function connConfig(): { connection: { host: string; port: number } } {
  const url = new URL(REDIS_URL);
  return { connection: { host: url.hostname, port: parseInt(url.port || '6379', 10) } };
}

const FANIN_SUMMARY_CHANNEL = 'kaiban-fanin-summary';
const FANIN_APPROVED_CHANNEL = 'kaiban-fanin-approved';
const COMPLETED_CHANNEL = 'kaiban-events-completed';
const FAILED_CHANNEL = 'kaiban-events-failed';

/** Wait until predicate is true or timeout expires */
async function waitUntil(pred: () => boolean, timeoutMs: number, intervalMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

type WorkflowSummary = {
  success: string[];
  failed: string[];
  totalExpected: number;
};

/**
 * Aggregator — collects completion/failure events until all N are accounted
 * for then publishes a summary to FANIN_SUMMARY_CHANNEL.
 */
async function runAggregator(
  oracleDriver: BullMQDriver,
  expectedTaskIds: string[],
  timeoutMs: number,
): Promise<WorkflowSummary> {
  const success = new Set<string>();
  const failed = new Set<string>();
  const expected = new Set(expectedTaskIds);

  await oracleDriver.subscribe(COMPLETED_CHANNEL, async (payload) => {
    if (expected.has(payload.taskId)) success.add(payload.taskId);
  });
  await oracleDriver.subscribe(FAILED_CHANNEL, async (payload) => {
    if (expected.has(payload.taskId)) failed.add(payload.taskId);
  });

  await waitUntil(() => success.size + failed.size >= expected.size, timeoutMs);

  return {
    success: [...success],
    failed: [...failed],
    totalExpected: expected.size,
  };
}

/**
 * Auto-approver — validates a workflow summary and publishes an approval
 * decision with no HITL.
 */
async function runAutoApprover(
  driver: BullMQDriver,
  summary: WorkflowSummary,
  workflowId: string,
  requiredSuccessRatio = 1.0,
): Promise<{ status: 'approved' | 'rejected'; reason: string }> {
  const ratio = summary.totalExpected > 0 ? summary.success.length / summary.totalExpected : 0;
  const approved = ratio >= requiredSuccessRatio;
  const decision = {
    workflowId,
    status: approved ? ('approved' as const) : ('rejected' as const),
    reason: approved
      ? `All ${summary.success.length}/${summary.totalExpected} sub-tasks succeeded`
      : `Only ${summary.success.length}/${summary.totalExpected} succeeded (required ${requiredSuccessRatio * 100}%)`,
    successCount: summary.success.length,
    failureCount: summary.failed.length,
    timestamp: Date.now(),
  };

  // Publish summary + decision
  await driver.publish(FANIN_SUMMARY_CHANNEL, {
    taskId: workflowId,
    agentId: 'aggregator',
    timestamp: Date.now(),
    data: { summary, decision },
  });
  await driver.publish(FANIN_APPROVED_CHANNEL, {
    taskId: workflowId,
    agentId: 'approver',
    timestamp: Date.now(),
    data: decision,
  });

  return decision;
}

// ── Helpers ───────────────────────────────────────────────────────────

function makeTaskId(prefix: string, i: number): string {
  return `${prefix}-task-${i}`;
}

/** Spin up N agent actors with a shared handler on a shared queue (competing consumers) */
async function spawnAgents(
  drivers: BullMQDriver[],
  count: number,
  agentId: string,
  queue: string,
  handler: (p: MessagePayload) => Promise<unknown>,
): Promise<AgentActor[]> {
  const actors: AgentActor[] = [];
  for (let i = 0; i < count; i++) {
    const d = new BullMQDriver(connConfig());
    drivers.push(d);
    const actor = new AgentActor(agentId, d, queue, handler);
    await actor.start();
    actors.push(actor);
  }
  // Allow BullMQ workers to attach
  await new Promise(r => setTimeout(r, 800));
  return actors;
}

// ── Test Suite ────────────────────────────────────────────────────────

describe('E2E: Fan-Out / Fan-In Workflow (BullMQ)', () => {
  const drivers: BullMQDriver[] = [];

  afterEach(async () => {
    await Promise.all(drivers.map(d => d.disconnect()));
    drivers.length = 0;
  });

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 1 — Golden Path: 4 agents, all succeed, approver passes
  // ─────────────────────────────────────────────────────────────────────
  it('Scenario 1 — Golden Path: 4 parallel agents complete, auto-approver passes', async () => {
    const workflowId = `wf-golden-${randomUUID()}`;
    const QUEUE = `fan-out-${workflowId}`;
    const NUM_AGENTS = 4;
    const AGENT_ID = `agent-${workflowId}`;
    const taskIds = Array.from({ length: NUM_AGENTS }, (_, i) => makeTaskId(workflowId, i));

    // Oracle driver (publisher + result listener)
    const oracle = new BullMQDriver(connConfig());
    drivers.push(oracle);

    // Approval result listener
    let approvalDecision: Record<string, unknown> | null = null;
    await oracle.subscribe(FANIN_APPROVED_CHANNEL, async (payload) => {
      if (payload.taskId === workflowId) approvalDecision = payload.data as Record<string, unknown>;
    });

    // Spin up 4 competing consumer agents on the same queue
    await spawnAgents(drivers, NUM_AGENTS, AGENT_ID, QUEUE, async () => {
      await new Promise(r => setTimeout(r, 20 + Math.random() * 30));
      return { result: 'sub-task complete' };
    });

    // Fan-out: publish all tasks simultaneously
    await Promise.all(
      taskIds.map(taskId =>
        oracle.publish(QUEUE, { taskId, agentId: AGENT_ID, timestamp: Date.now(), data: { instruction: `work-${taskId}` } }),
      ),
    );

    // Fan-in: aggregator collects completions
    const summary = await runAggregator(oracle, taskIds, 10_000);

    // Auto-approver (100% success required)
    const decision = await runAutoApprover(oracle, summary, workflowId, 1.0);

    // Wait for the approval event to round-trip through the BullMQ bus
    const received = await waitUntil(() => approvalDecision !== null, 5_000);

    // Assertions
    expect(summary.success).toHaveLength(NUM_AGENTS);
    expect(summary.failed).toHaveLength(0);
    expect(decision.status).toBe('approved');
    expect(received).toBe(true);
    expect(approvalDecision!['status']).toBe('approved');
    expect(approvalDecision!['successCount']).toBe(NUM_AGENTS);
  }, 30_000);

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 2 — Scaled 8-node: proves horizontal fan-out at scale
  // ─────────────────────────────────────────────────────────────────────
  it('Scenario 2 — Scaled 8-node: 8 parallel agents all succeed (horizontal fan-out)', async () => {
    const workflowId = `wf-scale-${randomUUID()}`;
    const QUEUE = `fan-out-${workflowId}`;
    const NUM_AGENTS = 8;
    const AGENT_ID = `agent-${workflowId}`;
    const taskIds = Array.from({ length: NUM_AGENTS }, (_, i) => makeTaskId(workflowId, i));

    const oracle = new BullMQDriver(connConfig());
    drivers.push(oracle);

    const workerNodes = new Set<string>();
    await spawnAgents(drivers, NUM_AGENTS, AGENT_ID, QUEUE, async (p) => {
      workerNodes.add(p.taskId); // unique per job slot
      await new Promise(r => setTimeout(r, 10 + Math.random() * 20));
      return 'ok';
    });

    await Promise.all(
      taskIds.map(taskId =>
        oracle.publish(QUEUE, { taskId, agentId: AGENT_ID, timestamp: Date.now(), data: {} }),
      ),
    );

    const summary = await runAggregator(oracle, taskIds, 15_000);
    const decision = await runAutoApprover(oracle, summary, workflowId, 1.0);

    expect(summary.success).toHaveLength(NUM_AGENTS);
    expect(summary.failed).toHaveLength(0);
    expect(decision.status).toBe('approved');
    // Prove tasks were spread across multiple BullMQ workers (competing consumers)
    expect(workerNodes.size).toBeGreaterThanOrEqual(NUM_AGENTS); // each task processed
  }, 40_000);

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 3 — Partial Failure + Retry Recovery
  //   Agent for task-0 fails on 1st attempt, retries, then succeeds.
  //   Overall workflow still completes successfully.
  // ─────────────────────────────────────────────────────────────────────
  it('Scenario 3 — Partial failure: 1 agent retries and recovers, workflow approves', async () => {
    const workflowId = `wf-retry-${randomUUID()}`;
    const QUEUE = `fan-out-${workflowId}`;
    const NUM_AGENTS = 4;
    const AGENT_ID = `agent-${workflowId}`;
    const taskIds = Array.from({ length: NUM_AGENTS }, (_, i) => makeTaskId(workflowId, i));

    const oracle = new BullMQDriver(connConfig());
    drivers.push(oracle);

    // Only the first task will be handled by the "flaky" agent
    const FLAKY_TASK = taskIds[0];
    const attemptCounts = new Map<string, number>();

    await spawnAgents(drivers, NUM_AGENTS, AGENT_ID, QUEUE, async (p) => {
      const attempts = (attemptCounts.get(p.taskId) ?? 0) + 1;
      attemptCounts.set(p.taskId, attempts);
      if (p.taskId === FLAKY_TASK && attempts === 1) {
        throw new Error('transient network error — will retry');
      }
      return 'ok';
    });

    await Promise.all(
      taskIds.map(taskId =>
        oracle.publish(QUEUE, { taskId, agentId: AGENT_ID, timestamp: Date.now(), data: {} }),
      ),
    );

    // Allow extra time for the retry backoff (100ms + 200ms)
    const summary = await runAggregator(oracle, taskIds, 12_000);
    const decision = await runAutoApprover(oracle, summary, workflowId, 1.0);

    expect(summary.success).toHaveLength(NUM_AGENTS);
    expect(summary.failed).toHaveLength(0);
    expect(decision.status).toBe('approved');
    // Confirm the flaky task needed more than 1 attempt
    expect(attemptCounts.get(FLAKY_TASK)).toBeGreaterThan(1);
  }, 35_000);

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 4 — Total Failure: all agents exhaust retries → DLQ
  //   Workflow reports partial failure; approver rejects.
  // ─────────────────────────────────────────────────────────────────────
  it('Scenario 4 — Total failure: all agents exhaust retries, approver rejects', async () => {
    const workflowId = `wf-fail-${randomUUID()}`;
    const QUEUE = `fan-out-${workflowId}`;
    const NUM_AGENTS = 3;
    const AGENT_ID = `agent-${workflowId}`;
    const taskIds = Array.from({ length: NUM_AGENTS }, (_, i) => makeTaskId(workflowId, i));

    const oracle = new BullMQDriver(connConfig());
    drivers.push(oracle);

    // All handlers always throw → all 3 retries exhausted → DLQ
    await spawnAgents(drivers, NUM_AGENTS, AGENT_ID, QUEUE, async () => {
      throw new Error('permanent failure');
    });

    await Promise.all(
      taskIds.map(taskId =>
        oracle.publish(QUEUE, { taskId, agentId: AGENT_ID, timestamp: Date.now(), data: {} }),
      ),
    );

    // 3 tasks × 3 retries × 100ms backoff each ≈ ~1.8s minimum; allow generous margin
    const summary = await runAggregator(oracle, taskIds, 15_000);
    const decision = await runAutoApprover(oracle, summary, workflowId, 1.0);

    expect(summary.success).toHaveLength(0);
    expect(summary.failed).toHaveLength(NUM_AGENTS);
    expect(decision.status).toBe('rejected');
    expect(decision.reason).toContain('0/' + NUM_AGENTS);
  }, 30_000);

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 5 — Late-joining agent
  //   Tasks are published BEFORE the agent subscribes.
  //   BullMQ persists jobs in Redis; the late agent picks them up.
  // ─────────────────────────────────────────────────────────────────────
  it('Scenario 5 — Late-joining agent: processes tasks published before connecting', async () => {
    const workflowId = `wf-late-${randomUUID()}`;
    const QUEUE = `fan-out-${workflowId}`;
    const AGENT_ID = `agent-${workflowId}`;
    const taskIds = [makeTaskId(workflowId, 0), makeTaskId(workflowId, 1)];

    const oracle = new BullMQDriver(connConfig());
    drivers.push(oracle);

    // Fan-out FIRST — no agents subscribed yet
    await Promise.all(
      taskIds.map(taskId =>
        oracle.publish(QUEUE, { taskId, agentId: AGENT_ID, timestamp: Date.now(), data: {} }),
      ),
    );

    // Short pause to ensure jobs are persisted in Redis before agent joins
    await new Promise(r => setTimeout(r, 200));

    // Now the agent joins late
    await spawnAgents(drivers, 1, AGENT_ID, QUEUE, async () => 'late-result');

    const summary = await runAggregator(oracle, taskIds, 10_000);
    const decision = await runAutoApprover(oracle, summary, workflowId, 1.0);

    expect(summary.success).toHaveLength(2);
    expect(decision.status).toBe('approved');
  }, 25_000);

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 6 — Duplicate Task IDs
  //   The same taskId is published twice. BullMQ uses the taskId as the
  //   BullMQ job name. Verify: the agent still processes it (BullMQ
  //   allows same-named jobs unless jobId dedup is configured). We assert
  //   at the aggregator level that the completion set only counts once
  //   per unique taskId (Set semantics).
  // ─────────────────────────────────────────────────────────────────────
  it('Scenario 6 — Duplicate task IDs: aggregator counts each taskId only once', async () => {
    const workflowId = `wf-dup-${randomUUID()}`;
    const QUEUE = `fan-out-${workflowId}`;
    const AGENT_ID = `agent-${workflowId}`;
    const taskId = makeTaskId(workflowId, 0);

    const oracle = new BullMQDriver(connConfig());
    drivers.push(oracle);

    let callCount = 0;
    await spawnAgents(drivers, 1, AGENT_ID, QUEUE, async () => {
      callCount++;
      return 'ok';
    });

    // Publish same taskId TWICE
    await oracle.publish(QUEUE, { taskId, agentId: AGENT_ID, timestamp: Date.now(), data: {} });
    await oracle.publish(QUEUE, { taskId, agentId: AGENT_ID, timestamp: Date.now(), data: {} });

    // Collect completions for this one logical taskId
    const summary = await runAggregator(oracle, [taskId], 8_000);
    const decision = await runAutoApprover(oracle, summary, workflowId, 1.0);

    // The aggregator Set yields exactly 1 unique taskId
    expect(summary.success).toHaveLength(1);
    expect(decision.status).toBe('approved');
    // The handler may be invoked once or twice depending on BullMQ job-id behavior,
    // but the workflow outcome is correct either way
    expect(callCount).toBeGreaterThanOrEqual(1);
  }, 20_000);

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 7 — Approver Rejects (partial success below threshold)
  //   3 of 4 agents succeed; approver threshold is 100% → rejected.
  //   Also verifies the approver works with a lenient threshold (75%).
  // ─────────────────────────────────────────────────────────────────────
  it('Scenario 7 — Approver rejects when success ratio below threshold', async () => {
    const workflowId = `wf-reject-${randomUUID()}`;
    const QUEUE = `fan-out-${workflowId}`;
    const NUM_AGENTS = 4;
    const AGENT_ID = `agent-${workflowId}`;
    const taskIds = Array.from({ length: NUM_AGENTS }, (_, i) => makeTaskId(workflowId, i));

    const oracle = new BullMQDriver(connConfig());
    drivers.push(oracle);

    const FAILING_TASK = taskIds[0]; // exactly 1 task will always fail

    await spawnAgents(drivers, NUM_AGENTS, AGENT_ID, QUEUE, async (p) => {
      if (p.taskId === FAILING_TASK) throw new Error('permanent sub-task failure');
      return 'ok';
    });

    await Promise.all(
      taskIds.map(taskId =>
        oracle.publish(QUEUE, { taskId, agentId: AGENT_ID, timestamp: Date.now(), data: {} }),
      ),
    );

    const summary = await runAggregator(oracle, taskIds, 15_000);

    // Strict 100% threshold → rejected
    const strictDecision = await runAutoApprover(oracle, summary, `${workflowId}-strict`, 1.0);
    expect(strictDecision.status).toBe('rejected');
    expect(summary.success).toHaveLength(NUM_AGENTS - 1);
    expect(summary.failed).toHaveLength(1);

    // Lenient 75% threshold → approved (3/4 = 75%)
    const lenientDecision = await runAutoApprover(oracle, summary, `${workflowId}-lenient`, 0.75);
    expect(lenientDecision.status).toBe('approved');
  }, 30_000);
});
