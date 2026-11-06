// SPDX-License-Identifier: GPL-3.0-only
/**
 * Blog Team Orchestrator
 *
 * Event-driven orchestration of the three-agent distributed blog pipeline:
 *
 *   Ava (researcher) ──> Kai (writer) ──> Morgan (editor)
 *                                              │
 *                                    ┌─────────▼──────────┐
 *                                    │  EDITORIAL REVIEW   │
 *                                    │  Accuracy: X.X/10   │
 *                                    │  Recommendation:    │
 *                                    │  PUBLISH|REVISE|    │
 *                                    │  REJECT             │
 *                                    └─────────┬──────────┘
 *                                              │
 *                                   ┌──────────▼───────────┐
 *                                   │  Human Decision (HITL) │
 *                                   │  [1] PUBLISH           │
 *                                   │  [2] REVISE            │
 *                                   │  [3] REJECT            │
 *                                   └────────────────────────┘
 *
 * Usage:
 *   GATEWAY_URL=http://localhost:3000 REDIS_URL=redis://localhost:6379 \
 *   TOPIC="AI Agents in 2025" npx ts-node examples/blog-team/orchestrator.ts
 */
import 'dotenv/config';
import readline from 'readline';
import { createHash, randomUUID } from 'crypto';
import { io, type Socket } from 'socket.io-client';
import {
  createDriver,
  CompletionRouter,
  getDriverType,
  WorkflowOrchestrator,
  RedisCheckpointStore,
  workflowBudgetFromEnv,
  assertWithinBudget,
  BudgetExceededError,
  EmergencyStopError,
  controlPlaneEnabled,
  createEmergencyStopSignal,
} from '../../src/shared';
import { log, RunLogger } from './run-logger';
import { BlogStatePublisher } from './state-publisher';
import { parseAgentCardSkills } from './agent-card';
import {
  runResearchPhase,
  runWritePhase,
  runEditorialPhase,
  handleBlogDecision,
  type ResearchResult,
  type WriteResult,
  type EditResult,
} from './phases';

const GATEWAY_URL = process.env['GATEWAY_URL'] ?? 'http://localhost:3000';
const REDIS_URL   = process.env['REDIS_URL']   ?? 'redis://localhost:6379';
const TOPIC       = process.env['TOPIC']       ?? 'Latest developments in AI agents';

/**
 * Stable per-run workflow id → the Redis checkpoint namespace. Defaults to a
 * deterministic hash of the topic so a crashed run, restarted with the same
 * TOPIC, RESUMES from its last completed phase (research/write) instead of
 * re-paying for it. Override with WORKFLOW_ID to force a fresh run.
 */
const WORKFLOW_ID = process.env['WORKFLOW_ID']
  ?? `blog-${createHash('sha256').update(TOPIC).digest('hex').slice(0, 16)}`;

// ── Main orchestration flow ───────────────────────────────────

/** Exit code of a run ended by an emergency STOP ALL (ADR-025). */
const EXIT_EMERGENCY_STOP = 2;

/**
 * End a run that threw: publish its terminal state and finish the run log.
 * Returns the exit code for a stop (emergency or budget); rethrows anything else.
 */
async function endFailedRun(
  err: unknown, pub: BlogStatePublisher, runLog: RunLogger, orch: WorkflowOrchestrator,
): Promise<number> {
  const { totalTokens, totalCost } = runLog.totals;
  if (err instanceof EmergencyStopError) {
    // Emergency STOP ALL: every task of this run was killed; end STOPPED, start fresh next time.
    pub.workflowStopped(randomUUID(), err.message, totalTokens, totalCost);
    pub.reviewStopped();
    runLog.finish('STOPPED');
    await orch.clear();
    log.info(`\n${err.message} — workflow stopped.\n`);
    return EXIT_EMERGENCY_STOP;
  }
  if (err instanceof BudgetExceededError) {
    // Budget guard tripped → stop gracefully (STOPPED), not the generic FAILED path.
    pub.workflowStopped(randomUUID(), `Budget guard: ${err.reason}`, totalTokens, totalCost);
    pub.reviewStopped('Budget guard stopped the run: no decision was taken');
    runLog.finish('STOPPED');
    await orch.clear();
    log.info(`\nBudget guard tripped — ${err.reason}. Workflow stopped.\n`);
    return 0;
  }
  // Publish a terminal state so the board reflects the failure instead of
  // hanging on RUNNING forever, then surface the error to the CLI.
  const msg = err instanceof Error ? err.message : String(err);
  pub.workflowStopped(randomUUID(), `Workflow error: ${msg}`, totalTokens, totalCost);
  pub.reviewStopped('Workflow failed: no decision was taken');
  runLog.finish('FAILED');
  throw err;
}

async function main(): Promise<number> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // For BullMQ: one driver handles both completed + failed queues.
  // For Kafka: separate consumer groups prevent the KafkaJS "can't subscribe after run()" issue.
  const isKafka         = getDriverType() === 'kafka';
  const completedDriver = createDriver('-orchestrator-completed');
  const failedDriver    = isKafka ? createDriver('-orchestrator-failed') : completedDriver;
  const router          = new CompletionRouter(completedDriver, failedDriver);
  const pub             = new BlogStatePublisher(REDIS_URL);
  const runLog          = new RunLogger(TOPIC, GATEWAY_URL, getDriverType());

  // Phase R — crash-safe single-active orchestrator: Redis checkpoint→resume.
  // Each pipeline phase is memoized under WORKFLOW_ID, so a restart resumes from
  // the last completed phase instead of re-running (and re-paying for) it.
  const store           = new RedisCheckpointStore(REDIS_URL);
  // Emergency STOP ALL (ADR-025): only with CONTROL_PLANE_ENABLED=true.
  const stop            = controlPlaneEnabled() ? await createEmergencyStopSignal(REDIS_URL) : null;
  const orch            = new WorkflowOrchestrator({
    workflowId: WORKFLOW_ID, router, store, ...(stop ? { stopSignal: stop.signal } : {}),
  });
  const budget          = workflowBudgetFromEnv();

  let socket: Socket | null = null;

  const cleanup = async (): Promise<void> => {
    socket?.disconnect();
    await completedDriver.disconnect();
    if (isKafka) await failedDriver.disconnect();
    await pub.disconnect();
    await store.disconnect();
    await stop?.close();
    rl.close();
  };
  let exitCode = 0;

  try {
    log.header('KAIBAN DISTRIBUTED — BLOG TEAM ORCHESTRATOR');


    const health = await fetch(`${GATEWAY_URL}/health`).then((r) => r.json()) as { data: { status: string } };
    log.info(`Gateway: ${health.data.status.toUpperCase()} at ${GATEWAY_URL}`);

    // A2A v0.3 AgentCard (ADR-015): `capabilities` is now an object and the
    // agent's discrete abilities live in `skills[]` (was a legacy `string[]`).
    const card = await fetch(`${GATEWAY_URL}/.well-known/agent-card.json`).then((r) => r.json()) as {
      name: string; skills?: Array<{ id?: string; name?: string }>;
    };
    const skills = parseAgentCardSkills(card);
    log.info(`Agent: ${card.name} — [${skills}]\n`);

    socket = io(GATEWAY_URL, { transports: ['websocket'] });
    socket.on('state:update', (delta: Record<string, unknown>) => {
      const status = delta['teamWorkflowStatus'] ?? delta['status'];
      if (status) process.stdout.write(`  ⬡ Board: ${String(status)}\n`);
    });

    log.info(`Topic: "${TOPIC}"  |  Workflow: ${WORKFLOW_ID}\n`);
    if (await orch.isResuming()) log.info('Resuming from a prior checkpoint (completed phases will be skipped)\n');
    pub.workflowStarted(TOPIC);

    // STEP 1 — Research (checkpoint→resume via the shared orchestrator)
    log.separator('-'); log.info('STEP 1 — Ava (Researcher) is gathering information...'); log.separator('-');
    const research = await orch.memoize<ResearchResult>('research',
      () => runResearchPhase(TOPIC, router, pub, completedDriver, runLog, stop?.signal));

    log.info('\nRESEARCH COMPLETE');
    log.separator('-');
    log.info(research.summary.slice(0, 600) + (research.summary.length > 600 ? '\n  [...truncated...]' : ''));
    log.separator('-');
    assertWithinBudget({ totalTokens: runLog.totals.totalTokens, estimatedCost: runLog.totals.totalCost }, budget);

    // STEP 2 — Write
    log.info('\nSTEP 2 — Kai (Writer) is drafting the blog post...');
    log.separator('-');
    const write = await orch.memoize<WriteResult>('write',
      () => runWritePhase(TOPIC, research.summary, router, pub, completedDriver, runLog, stop?.signal));

    log.info('\nDRAFT COMPLETE');
    log.separator('-');
    log.info(write.draft);
    log.separator('-');
    assertWithinBudget({ totalTokens: runLog.totals.totalTokens, estimatedCost: runLog.totals.totalCost }, budget);

    // STEP 3 — Editorial Review
    log.info('\nSTEP 3 — Morgan (Editor) is reviewing for accuracy...');
    log.separator('-');
    const edit = await orch.memoize<EditResult>('editorial',
      () => runEditorialPhase(TOPIC, research.summary, write.draft, router, pub, completedDriver, runLog, stop?.signal));

    log.header('EDITORIAL REVIEW BY MORGAN');
    log.info(edit.review);
    log.separator('=');
    log.info(`  Accuracy Score:  ${edit.score}`);
    log.info(`  Recommendation:  ${edit.recommendation}\n`);
    assertWithinBudget({ totalTokens: runLog.totals.totalTokens, estimatedCost: runLog.totals.totalCost }, budget);

    // STEP 4 — Human-in-the-Loop Decision (HITL)
    log.header('HUMAN REVIEW REQUIRED (HITL)');
    log.info(`Editorial: ${edit.recommendation} (Accuracy: ${edit.score})`);
    await handleBlogDecision({
      topic: TOPIC, redisUrl: REDIS_URL, gatewayUrl: GATEWAY_URL, research, write, edit, router, pub,
      driver: completedDriver, rl, runLog, ...(stop ? { signal: stop.signal } : {}),
    });

    // Terminal state reached — wipe the checkpoint so a re-run starts fresh.
    await orch.clear();

    log.separator('-');
    log.info(`View full trace: ${GATEWAY_URL}  |  Board: examples/blog-team/viewer/board.html`);
    log.separator('-');

  } catch (err: unknown) {
    exitCode = await endFailedRun(err, pub, runLog, orch);
  } finally {
    const logPath = await runLog.flush('examples/blog-team/runs').catch(() => null);
    if (logPath) log.info(`Run log saved to ${logPath}`);
    await cleanup();
  }
  return exitCode;
}

main().then((code) => {
  // An emergency stop leaves the killed phase's wait timers armed: exit now.
  if (code !== 0) process.exit(code);
}).catch((err: unknown) => {
  console.error('[BlogTeam] Fatal error:', err);
  process.exit(1);
});
