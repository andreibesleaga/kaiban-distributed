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
  createRpcClient,
} from '../../src/shared';
import type { ResearchContext } from './types';
import { issueA2AToken } from '../../src/infrastructure/security/a2a-auth';
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
  router: CompletionRouter;
  pub: ResearchStatePublisher;
  rpc: ReturnType<typeof createRpcClient>;
  rl: readline.Interface | null;
  runLog: RunLogger;
}

async function runPipeline(deps: PipelineDeps): Promise<void> {
  const { ctx, router, pub, rpc, rl, runLog } = deps;

  pub.workflowStarted(NUM_SEARCHERS);

  // STEP 1 — Fan-Out
  const subTopics = buildSubTopics(QUERY, NUM_SEARCHERS);
  
  log.separator('='); log.info(`STEP 1 — Fan-Out: ${NUM_SEARCHERS} Searcher nodes gathering data...`); log.separator('=');
  log.info(`Sub-topics: ${subTopics.map((t, i) => `\n  ${i + 1}. ${t}`).join('')}\n`);

  await runSearchPhase(ctx, QUERY, NUM_SEARCHERS, SEARCH_WAIT_MS, router, pub, rpc, runLog);
  
  log.info(`\nSEARCH PHASE COMPLETE — ${ctx.rawSearchData.length}/${NUM_SEARCHERS} results`);

  // STEP 2 — Fan-In
  log.separator('='); log.info('STEP 2 — Fan-In: Atlas (Writer) synthesising research...'); log.separator('=');
  
  await runWritePhase(ctx, QUERY, WRITE_WAIT_MS, router, pub, rpc, runLog);

  log.info(`\nSYNTHESIS COMPLETE (${(ctx.consolidatedDraft ?? '').length} chars)`);

  // STEP 3 — Governance
  log.separator('='); log.info('STEP 3 — Sage (Reviewer) running governance compliance check...'); log.separator('=');
  
  const gov = await runGovernancePhase(ctx, QUERY, REVIEW_WAIT_MS, router, pub, rpc, runLog);
  
  log.info(`\n  Compliance Score: ${gov.score}   Recommendation: ${gov.recommendation}`);

  if (gov.recommendation === 'REJECTED') {
    ctx.metadata.endTime = Date.now();
    pub.workflowStopped(randomUUID(), `Governance rejected: ${ctx.feedback?.complianceViolations.join('; ') ?? gov.text.slice(0, 200)}`, ctx);
    runLog.finish('REJECTED');
    
    log.info('\nGovernance review REJECTED the report. Workflow stopped.\n');
    return;
  }

  // STEP 4 — Editorial
  log.separator('='); log.info('STEP 4 — Morgan (Editor) preparing HITL review...'); log.separator('=');

  const edit = await runEditorialPhase(ctx, QUERY, gov, EDIT_WAIT_MS, router, pub, rpc, runLog);

  log.info(`\n  Governance: ${gov.score} (${gov.recommendation})`);
  log.info(`  Editorial:  ${edit.score}  — Recommendation: ${edit.recommendation}`);

  // STEP 5 — Human Decision
  log.separator('='); log.info(' HUMAN DECISION REQUIRED (HITL)'); log.separator('=');
  log.info(`\n  [${edit.recommendation}] Editor recommends ${edit.recommendation}`);
  log.info('\n  Options:\n  [1] PUBLISH\n  [2] REVISE → send back to writer\n  [3] REJECT\n  [4] VIEW full report\n');

  await handleDecision({
    ctx, query: QUERY, redisUrl: REDIS_URL, gov, edit,
    numSearchers: NUM_SEARCHERS, writeWaitMs: WRITE_WAIT_MS, autoPub: AUTO_PUBLISH,
    router, pub, rpc, rl, runLog,
  });

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
  const rpc            = createRpcClient(GATEWAY_URL);
  const ctx: ResearchContext = {
    id: randomUUID(), originalQuery: QUERY, status: 'INITIALIZED',
    rawSearchData: [], editorApproval: false,
    metadata: { totalTokens: 0, estimatedCost: 0, startTime: Date.now(), activeNodes: [] },
  };
  const runLog = new RunLogger(QUERY, GATEWAY_URL, getDriverType(), NUM_SEARCHERS, ctx.id);
  let socket: Socket | null = null;

  const cleanup = async (): Promise<void> => {
    socket?.disconnect();
    await completedDriver.disconnect();
    if (isKafka) await failedDriver.disconnect();
    await pub.disconnect();
    rl?.close();
  };

  try {
    log.header('KAIBAN DISTRIBUTED — GLOBAL RESEARCH SWARM ORCHESTRATOR');
    log.info(`Query: "${QUERY}"  |  Searchers: ${NUM_SEARCHERS}  |  Context: ${ctx.id}\n`);

    if (process.env['A2A_JWT_SECRET']) {
      rpc.setToken(issueA2AToken('global-research-orchestrator'));
      log.info('A2A auth token issued');
    }

    const health = await fetch(`${GATEWAY_URL}/health`).then((r) => r.json()) as { data: { status: string } };
    log.info(`Gateway: ${health.data.status.toUpperCase()} at ${GATEWAY_URL}`);

    socket = io(GATEWAY_URL, { transports: ['websocket'] });
    socket.on('state:update', onBoardUpdate);

    await runPipeline({ ctx, router, pub, rpc, rl, runLog });

  } catch (err: unknown) {
    runLog.finish('FAILED');
    throw err;
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
