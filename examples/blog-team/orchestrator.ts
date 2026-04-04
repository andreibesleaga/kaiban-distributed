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
import { io, type Socket } from 'socket.io-client';
import {
  createDriver,
  createRpcClient,
  CompletionRouter,
  getDriverType,
} from '../../src/shared';
import { issueA2AToken } from '../../src/infrastructure/security/a2a-auth';
import { log, RunLogger } from './run-logger';
import { BlogStatePublisher } from './state-publisher';
import {
  runResearchPhase,
  runWritePhase,
  runEditorialPhase,
  handleBlogDecision,
} from './phases';

const GATEWAY_URL = process.env['GATEWAY_URL'] ?? 'http://localhost:3000';
const REDIS_URL   = process.env['REDIS_URL']   ?? 'redis://localhost:6379';
const TOPIC       = process.env['TOPIC']       ?? 'Latest developments in AI agents';

// ── Main orchestration flow ───────────────────────────────────

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // For BullMQ: one driver handles both completed + failed queues.
  // For Kafka: separate consumer groups prevent the KafkaJS "can't subscribe after run()" issue.
  const isKafka         = getDriverType() === 'kafka';
  const completedDriver = createDriver('-orchestrator-completed');
  const failedDriver    = isKafka ? createDriver('-orchestrator-failed') : completedDriver;
  const router          = new CompletionRouter(completedDriver, failedDriver);
  const pub             = new BlogStatePublisher(REDIS_URL);
  const rpc             = createRpcClient(GATEWAY_URL);
  const runLog          = new RunLogger(TOPIC, GATEWAY_URL, getDriverType());

  let socket: Socket | null = null;

  const cleanup = async (): Promise<void> => {
    socket?.disconnect();
    await completedDriver.disconnect();
    if (isKafka) await failedDriver.disconnect();
    await pub.disconnect();
    rl.close();
  };

  try {
    log.header('KAIBAN DISTRIBUTED — BLOG TEAM ORCHESTRATOR');

    if (process.env['A2A_JWT_SECRET']) {
      rpc.setToken(issueA2AToken('blog-team-orchestrator'));
      log.info('A2A auth token issued');
    }

    const health = await fetch(`${GATEWAY_URL}/health`).then((r) => r.json()) as { data: { status: string } };
    log.info(`Gateway: ${health.data.status.toUpperCase()} at ${GATEWAY_URL}`);

    const card = await fetch(`${GATEWAY_URL}/.well-known/agent-card.json`).then((r) => r.json()) as {
      name: string; capabilities: string[];
    };
    log.info(`Agent: ${card.name} — [${card.capabilities.join(', ')}]\n`);

    socket = io(GATEWAY_URL, { transports: ['websocket'] });
    socket.on('state:update', (delta: Record<string, unknown>) => {
      const status = delta['teamWorkflowStatus'] ?? delta['status'];
      if (status) process.stdout.write(`  ⬡ Board: ${String(status)}\n`);
    });

    log.info(`Topic: "${TOPIC}"\n`);
    pub.workflowStarted(TOPIC);

    // STEP 1 — Research
    log.separator('-'); log.info('STEP 1 — Ava (Researcher) is gathering information...'); log.separator('-');
    const research = await runResearchPhase(TOPIC, router, pub, rpc, runLog);

    log.info('\nRESEARCH COMPLETE');
    log.separator('-');
    log.info(research.summary.slice(0, 600) + (research.summary.length > 600 ? '\n  [...truncated...]' : ''));
    log.separator('-');

    // STEP 2 — Write
    log.info('\nSTEP 2 — Kai (Writer) is drafting the blog post...');
    log.separator('-');
    const write = await runWritePhase(TOPIC, research.summary, router, pub, rpc, runLog);

    log.info('\nDRAFT COMPLETE');
    log.separator('-');
    log.info(write.draft);
    log.separator('-');

    // STEP 3 — Editorial Review
    log.info('\nSTEP 3 — Morgan (Editor) is reviewing for accuracy...');
    log.separator('-');
    const edit = await runEditorialPhase(TOPIC, research.summary, write.draft, router, pub, rpc, runLog);

    log.header('EDITORIAL REVIEW BY MORGAN');
    log.info(edit.review);
    log.separator('=');
    log.info(`  Accuracy Score:  ${edit.score}`);
    log.info(`  Recommendation:  ${edit.recommendation}\n`);

    // STEP 4 — Human-in-the-Loop Decision (HITL)
    log.header('HUMAN REVIEW REQUIRED (HITL)');
    log.info(`Editorial: ${edit.recommendation} (Accuracy: ${edit.score})`);
    await handleBlogDecision({ topic: TOPIC, redisUrl: REDIS_URL, gatewayUrl: GATEWAY_URL, research, write, edit, router, pub, rpc, rl, runLog });

    log.separator('-');
    log.info(`View full trace: ${GATEWAY_URL}  |  Board: examples/blog-team/viewer/board.html`);
    log.separator('-');

  } catch (err: unknown) {
    runLog.finish('FAILED');
    throw err;
  } finally {
    const logPath = await runLog.flush('examples/blog-team/runs').catch(() => null);
    if (logPath) log.info(`Run log saved to ${logPath}`);
    await cleanup();
  }
}

main().catch((err: unknown) => {
  console.error('[BlogTeam] Fatal error:', err);
  process.exit(1);
});
