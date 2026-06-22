/**
 * Global Research Swarm Orchestrator
 *
 * Fan-Out / Fan-In distributed research pipeline:
 *
 *   [Fan-Out]  N × Zara (Searcher) ──→ kaiban-agents-searcher (competing consumers)
 *                                              │
 *   [Fan-In]   Atlas (Writer) ←── rawSearchData[] collected
 *                                              │
 *   [Govern]   Sage (Reviewer) ←── consolidatedDraft
 *                                              │
 *   [HITL]     Morgan (Editor) ←── governance verdict
 *                                              │
 *                               Human Decision: PUBLISH | REVISE | REJECT
 *
 * Usage:
 *   GATEWAY_URL=http://localhost:3000 REDIS_URL=redis://localhost:6379 \
 *   QUERY="The Future of AI Agents" NUM_SEARCHERS=4 \
 *   npx ts-node examples/global-research/orchestrator.ts
 */
import 'dotenv/config';
import readline from 'readline';
import { randomUUID } from 'crypto';
import { io, type Socket } from 'socket.io-client';
import {
  createDriver,
  getDriverType,
  CompletionRouter,
  WorkflowOrchestrator,
  RedisCheckpointStore,
  workflowBudgetFromEnv,
  assertWithinBudget,
  BudgetExceededError,
} from '../../src/shared';
import type { ResearchContext } from './types';
import type { IMessagingDriver } from '../../src/infrastructure/messaging/interfaces';
import { log, RunLogger } from './run-logger';
import { ResearchStatePublisher } from './state-publisher';
import {
  buildSubTopics,
  runSearchPhase,
  runWritePhase,
  runGovernancePhase,
  runEditorialPhase,
  handleDecision,
} from './phases';

const GATEWAY_URL    = process.env['GATEWAY_URL']      ?? 'http://localhost:3000';
const REDIS_URL      = process.env['REDIS_URL']        ?? 'redis://localhost:6379';
const QUERY          = process.env['QUERY']            ?? 'The Future of AI Agents';
const NUM_SEARCHERS  = parseInt(process.env['NUM_SEARCHERS']  ?? '4',      10);
const SEARCH_WAIT_MS = parseInt(process.env['SEARCH_WAIT_MS'] ?? '120000', 10);
const WRITE_WAIT_MS  = parseInt(process.env['WRITE_WAIT_MS']  ?? '240000', 10);
const REVIEW_WAIT_MS = parseInt(process.env['REVIEW_WAIT_MS'] ?? '180000', 10);
const EDIT_WAIT_MS   = parseInt(process.env['EDIT_WAIT_MS']   ?? '300000', 10);

/**
 * When AUTO_PUBLISH=1, skip all readline prompts and auto-approve HITL as PUBLISH.
 * Also activates automatically when stdin is not a TTY (CI / piped usage).
 */
const AUTO_PUBLISH = process.env['AUTO_PUBLISH'] === '1'
                  || process.env['AUTO_PUBLISH'] === 'true'
                  || !process.stdin.isTTY;

// ── Pipeline: all research steps extracted so main() stays under complexity 10 ──

interface PipelineDeps {
  ctx: ResearchContext;
  orch: WorkflowOrchestrator;
  router: CompletionRouter;
  pub: ResearchStatePublisher;
  driver: Pick<IMessagingDriver, 'publish'>;
  rl: readline.Interface | null;
  runLog: RunLogger;
}

/**
 * The ctx fields the fan-out/fan-in phases mutate in place. Snapshotting these
 * after each phase lets the shared orchestrator checkpoint→resume the pipeline
 * (a restart re-hydrates ctx and skips completed phases) without changing the
 * phase signatures. Redis-channel/workflow-status invariants are untouched.
 */
type CtxSnapshot = Pick<
  ResearchContext,
  'status' | 'rawSearchData' | 'consolidatedDraft' | 'feedback' | 'metadata'
>;

function snapshot(ctx: ResearchContext): CtxSnapshot {
  return {
    status: ctx.status,
    rawSearchData: ctx.rawSearchData,
    ...(ctx.consolidatedDraft !== undefined ? { consolidatedDraft: ctx.consolidatedDraft } : {}),
    ...(ctx.feedback !== undefined ? { feedback: ctx.feedback } : {}),
    metadata: ctx.metadata,
  };
}

function restore(ctx: ResearchContext, snap: CtxSnapshot): void {
  Object.assign(ctx, snap);
}

async function runPipeline(deps: PipelineDeps): Promise<void> {
  const { ctx, orch, router, pub, driver, rl, runLog } = deps;
  const budget = workflowBudgetFromEnv();

  pub.workflowStarted(NUM_SEARCHERS);
  if (await orch.isResuming()) log.info('Resuming from a prior checkpoint (completed phases will be skipped)\n');

  // STEP 1 — Fan-Out (checkpoint→resume via the shared orchestrator)
  const subTopics = buildSubTopics(QUERY, NUM_SEARCHERS);

  log.separator('='); log.info(`STEP 1 — Fan-Out: ${NUM_SEARCHERS} Searcher nodes gathering data...`); log.separator('=');
  log.info(`Sub-topics: ${subTopics.map((t, i) => `\n  ${i + 1}. ${t}`).join('')}\n`);

  restore(ctx, await orch.memoize<CtxSnapshot>('search', async () => {
    await runSearchPhase(ctx, QUERY, NUM_SEARCHERS, SEARCH_WAIT_MS, router, pub, driver, runLog);
    return snapshot(ctx);
  }));

  log.info(`\nSEARCH PHASE COMPLETE — ${ctx.rawSearchData.length}/${NUM_SEARCHERS} results`);
  assertWithinBudget(ctx.metadata, budget);

  // STEP 2 — Fan-In
  log.separator('='); log.info('STEP 2 — Fan-In: Atlas (Writer) synthesising research...'); log.separator('=');

  restore(ctx, await orch.memoize<CtxSnapshot>('write', async () => {
    await runWritePhase(ctx, QUERY, WRITE_WAIT_MS, router, pub, driver, runLog);
    return snapshot(ctx);
  }));

  log.info(`\nSYNTHESIS COMPLETE (${(ctx.consolidatedDraft ?? '').length} chars)`);
  assertWithinBudget(ctx.metadata, budget);

  // STEP 3 — Governance (checkpoints both its verdict AND the ctx delta)
  log.separator('='); log.info('STEP 3 — Sage (Reviewer) running governance compliance check...'); log.separator('=');

  const govStep = await orch.memoize('governance', async () => {
    const result = await runGovernancePhase(ctx, QUERY, REVIEW_WAIT_MS, router, pub, driver, runLog);
    return { gov: result, snap: snapshot(ctx) };
  });
  restore(ctx, govStep.snap);
  const gov = govStep.gov;

  log.info(`\n  Compliance Score: ${gov.score}   Recommendation: ${gov.recommendation}`);

  if (gov.recommendation === 'REJECTED') {
    ctx.metadata.endTime = Date.now();
    pub.workflowStopped(randomUUID(), `Governance rejected: ${ctx.feedback?.complianceViolations.join('; ') ?? gov.text.slice(0, 200)}`, ctx);
    runLog.finish('REJECTED');
    await orch.clear();

    log.info('\nGovernance review REJECTED the report. Workflow stopped.\n');
    return;
  }

  // STEP 4 — Editorial (checkpoints its verdict AND the ctx delta)
  log.separator('='); log.info('STEP 4 — Morgan (Editor) preparing HITL review...'); log.separator('=');

  const editStep = await orch.memoize('editorial', async () => {
    const result = await runEditorialPhase(ctx, QUERY, gov, EDIT_WAIT_MS, router, pub, driver, runLog);
    return { edit: result, snap: snapshot(ctx) };
  });
  restore(ctx, editStep.snap);
  const edit = editStep.edit;

  log.info(`\n  Governance: ${gov.score} (${gov.recommendation})`);
  log.info(`  Editorial:  ${edit.score}  — Recommendation: ${edit.recommendation}`);

  // STEP 5 — Human Decision
  log.separator('='); log.info(' HUMAN DECISION REQUIRED (HITL)'); log.separator('=');
  log.info(`\n  [${edit.recommendation}] Editor recommends ${edit.recommendation}`);
  log.info('\n  Options:\n  [1] PUBLISH\n  [2] REVISE → send back to writer\n  [3] REJECT\n  [4] VIEW full report\n');

  await handleDecision({
    ctx, query: QUERY, redisUrl: REDIS_URL, gov, edit,
    writeWaitMs: WRITE_WAIT_MS, autoPub: AUTO_PUBLISH,
    router, pub, driver, rl, runLog,
  });

  // Terminal state reached — wipe the checkpoint so a re-run starts fresh.
  await orch.clear();

  log.info(`\n  Tokens used:    ${ctx.metadata.totalTokens}`);
  log.info(`  Estimated cost: $${ctx.metadata.estimatedCost.toFixed(4)}`);
  log.info(`  Active nodes:   ${ctx.metadata.activeNodes.join(', ')}`);
  log.separator('-');
  log.info(`View board: examples/global-research/viewer/board.html`);
  log.info(`Context ID: ${ctx.id}`);
  log.separator('-');
}

// ── Main: setup / teardown only ───────────────────────────────

async function main(): Promise<void> {
  const rl             = AUTO_PUBLISH ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const isKafka        = getDriverType() === 'kafka';
  const completedDriver = createDriver('-orchestrator-completed');
  const failedDriver   = isKafka ? createDriver('-orchestrator-failed') : completedDriver;
  const router         = new CompletionRouter(completedDriver, failedDriver);
  const pub            = new ResearchStatePublisher(REDIS_URL);
  const ctx: ResearchContext = {
    id: randomUUID(), originalQuery: QUERY, status: 'INITIALIZED',
    rawSearchData: [], editorApproval: false,
    metadata: { totalTokens: 0, estimatedCost: 0, startTime: Date.now(), activeNodes: [] },
  };
  const runLog = new RunLogger(QUERY, GATEWAY_URL, getDriverType(), NUM_SEARCHERS, ctx.id);

  // Phase R — crash-safe single-active orchestrator: Redis checkpoint→resume.
  // WORKFLOW_ID namespaces the checkpoint; default to the context id (override to
  // resume a specific run). A restart resumes from the last completed phase.
  const workflowId     = process.env['WORKFLOW_ID'] ?? `research-${ctx.id}`;
  const store          = new RedisCheckpointStore(REDIS_URL);
  const orch           = new WorkflowOrchestrator({ workflowId, router, store });

  let socket: Socket | null = null;

  const cleanup = async (): Promise<void> => {
    socket?.disconnect();
    await completedDriver.disconnect();
    if (isKafka) await failedDriver.disconnect();
    await pub.disconnect();
    await store.disconnect();
    rl?.close();
  };

  try {
    log.header('KAIBAN DISTRIBUTED — GLOBAL RESEARCH SWARM ORCHESTRATOR');
    log.info(`Query: "${QUERY}"  |  Searchers: ${NUM_SEARCHERS}  |  Context: ${ctx.id}\n`);

    const health = await fetch(`${GATEWAY_URL}/health`).then((r) => r.json()) as { data: { status: string } };
    log.info(`Gateway: ${health.data.status.toUpperCase()} at ${GATEWAY_URL}`);

    socket = io(GATEWAY_URL, { transports: ['websocket'] });
    socket.on('state:update', onBoardUpdate);

    await runPipeline({ ctx, orch, router, pub, driver: completedDriver, rl, runLog });

  } catch (err: unknown) {
    // Budget guard tripped → stop gracefully (STOPPED), not the generic FAILED path.
    if (err instanceof BudgetExceededError) {
      ctx.metadata.endTime = Date.now();
      pub.workflowStopped(randomUUID(), `Budget guard: ${err.reason}`, ctx);
      runLog.finish('STOPPED');
      await orch.clear();
      log.info(`\nBudget guard tripped — ${err.reason}. Workflow stopped.\n`);
    } else {
      // Publish a terminal state so the board reflects the failure instead of
      // hanging on RUNNING forever, then surface the error to the CLI.
      ctx.metadata.endTime = Date.now();
      const msg = err instanceof Error ? err.message : String(err);
      pub.workflowStopped(randomUUID(), `Workflow error: ${msg}`, ctx);
      runLog.finish('FAILED');
      throw err;
    }
  } finally {
    const logPath = await runLog.flush('examples/global-research/runs').catch(() => null);
    if (logPath) log.info(`Run log saved to ${logPath}`);
    await cleanup();
  }
}

function onBoardUpdate(delta: Record<string, unknown>): void {
  const status = delta['teamWorkflowStatus'] ?? delta['status'];
  if (status) process.stdout.write(`  Board: ${String(status)}\n`);
}

main().catch((err: unknown) => {
  console.error('[GlobalResearch] Fatal error:', err);
  process.exit(1);
});
