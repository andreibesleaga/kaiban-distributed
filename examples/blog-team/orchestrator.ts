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
import { Redis } from 'ioredis';
import { createDriver, getDriverType } from './driver-factory';
import { COMPLETED_QUEUE } from './team-config';

const GATEWAY_URL      = process.env['GATEWAY_URL']      ?? 'http://localhost:3000';
const REDIS_URL        = process.env['REDIS_URL']        ?? 'redis://localhost:6379';
const TOPIC            = process.env['TOPIC']            ?? 'Latest developments in AI agents';
const RESEARCH_WAIT_MS = parseInt(process.env['RESEARCH_WAIT_MS'] ?? '120000', 10);
const WRITE_WAIT_MS    = parseInt(process.env['WRITE_WAIT_MS']    ?? '240000', 10);
const EDIT_WAIT_MS     = parseInt(process.env['EDIT_WAIT_MS']     ?? '300000', 10);

// ──────────────────────────────────────────────────────────────
// CompletionRouter — single BullMQ subscriber, dispatches by taskId
// Fixes: BullMQDriver.subscribe() reuses the same worker for a queue,
// so calling subscribe() twice for different handlers silently drops
// the second handler. One router handles all completions.
// ──────────────────────────────────────────────────────────────

/** All three blog-team agent descriptors (used to reset board state on completion) */
const BLOG_AGENTS = [
  { agentId: 'researcher', name: 'Ava',   role: 'News Researcher',        status: 'IDLE' as const, currentTaskId: null },
  { agentId: 'writer',     name: 'Kai',   role: 'Content Creator',        status: 'IDLE' as const, currentTaskId: null },
  { agentId: 'editor',     name: 'Morgan',role: 'Editorial Fact-Checker', status: 'IDLE' as const, currentTaskId: null },
];

/**
 * Publishes orchestration lifecycle states directly to Redis Pub/Sub → SocketGateway → board.
 *
 * Workers' AgentStatePublisher no longer emits teamWorkflowStatus — only the
 * OrchestratorStatePublisher controls the workflow lifecycle (RUNNING → FINISHED / STOPPED).
 * This prevents heartbeats from overriding terminal states.
 */
class OrchestratorStatePublisher {
  private redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { lazyConnect: false });
  }

  publish(delta: Record<string, unknown>): void {
    this.redis.publish('kaiban-state-events', JSON.stringify(delta)).catch((err: unknown) =>
      console.error('[OrchestratorStatePublisher] Publish failed:', err),
    );
  }

  /** Call once when the orchestrator starts — board shows workflow is active with topic */
  workflowStarted(topic: string): void {
    this.publish({ teamWorkflowStatus: 'RUNNING', agents: BLOG_AGENTS, inputs: { topic } });
  }

  /** Publish a task immediately after it is queued — board shows it in TODO column */
  taskQueued(taskId: string, title: string, agentId: string): void {
    this.publish({
      tasks: [{ taskId, title: title.slice(0, 60), status: 'TODO', assignedToAgentId: agentId }],
    });
  }

  awaitingHITL(taskId: string, reviewTitle: string, recommendation: string, score: string): void {
    this.publish({
      teamWorkflowStatus: 'RUNNING',
      agents: BLOG_AGENTS,
      tasks: [{
        taskId,
        title: `🔍 ${reviewTitle}`,
        status: 'AWAITING_VALIDATION',
        assignedToAgentId: 'editor',
        result: `Recommendation: ${recommendation} | Score: ${score} — Waiting for human decision`,
      }],
    });
  }

  taskFailed(taskId: string, agentId: string, title: string, error: string): void {
    this.publish({
      agents: [{ agentId, name: agentId, role: agentId, status: 'ERROR', currentTaskId: taskId }],
      tasks: [{ taskId, title: title.slice(0, 60), status: 'BLOCKED', assignedToAgentId: agentId, result: `ERROR: ${error.slice(0, 200)}` }],
    });
  }

  /** Publish FINISHED state — resets all agents to IDLE and clears all pending tasks */
  workflowFinished(finalTaskId: string, topic: string, editTaskId?: string): void {
    const tasks: Array<Record<string, unknown>> = [
      { taskId: finalTaskId, title: topic.slice(0, 60), status: 'DONE', assignedToAgentId: 'writer', result: '✅ Published' },
    ];
    if (editTaskId) {
      tasks.push({ taskId: editTaskId, title: 'Editorial Review', status: 'DONE', assignedToAgentId: 'editor', result: '✅ Approved for publication' });
    }
    this.publish({ teamWorkflowStatus: 'FINISHED', agents: BLOG_AGENTS, tasks });
  }

  /** Publish STOPPED state — clears all pending tasks including editorial review */
  workflowStopped(taskId: string, reason: string, editTaskId?: string): void {
    const tasks: Array<Record<string, unknown>> = [
      { taskId, title: 'Workflow ended', status: 'BLOCKED', assignedToAgentId: 'editor', result: `🗑 ${reason.slice(0, 200)}` },
    ];
    if (editTaskId && editTaskId !== taskId) {
      tasks.push({ taskId: editTaskId, title: 'Editorial Review', status: 'BLOCKED', assignedToAgentId: 'editor', result: '⏹ Workflow stopped' });
    }
    this.publish({ teamWorkflowStatus: 'STOPPED', agents: BLOG_AGENTS, tasks });
  }

  async disconnect(): Promise<void> { await this.redis.quit(); }
}

/**
 * CompletionRouter — single subscription hub dispatching by taskId.
 *
 * For BullMQ: one driver handles both completed + failed queues (different queue names).
 * For Kafka:  TWO separate drivers required (different consumer groups) because
 *             KafkaJS doesn't support subscribing to new topics after consumer.run() starts.
 *             Pass a separate failedDriver created with a different groupId suffix.
 */
class CompletionRouter {
  private pendingResolve = new Map<string, (result: string) => void>();
  private pendingReject  = new Map<string, (err: Error) => void>();
  private timers         = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    completedDriver: import('../../src/infrastructure/messaging/interfaces').IMessagingDriver,
    failedDriver?: import('../../src/infrastructure/messaging/interfaces').IMessagingDriver,
  ) {
    const dlqDriver = failedDriver ?? completedDriver;

    // Successful completions
    void completedDriver.subscribe(COMPLETED_QUEUE, async (payload) => {
      const resolve = this.pendingResolve.get(payload.taskId);
      if (resolve) {
        this.clearPending(payload.taskId);
        const result = payload.data['result'];
        resolve(typeof result === 'string' ? result : JSON.stringify(result ?? ''));
      }
    });

    // Failed tasks (after 3 retries → DLQ) — surfaces real LLM error
    void dlqDriver.subscribe('kaiban-events-failed', async (payload) => {
      const reject = this.pendingReject.get(payload.taskId);
      if (reject) {
        this.clearPending(payload.taskId);
        const errMsg = String(payload.data['error'] ?? 'Task failed after max retries');
        reject(new Error(`Agent failed: ${errMsg}`));
      }
    });
  }

  private clearPending(taskId: string): void {
    this.pendingResolve.delete(taskId);
    this.pendingReject.delete(taskId);
    const t = this.timers.get(taskId);
    if (t) { clearTimeout(t); this.timers.delete(taskId); }
  }

  wait(taskId: string, timeoutMs: number, label: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.pendingResolve.set(taskId, resolve);
      this.pendingReject.set(taskId, reject);
      this.timers.set(taskId, setTimeout(() => {
        if (this.pendingResolve.has(taskId)) {
          this.clearPending(taskId);
          reject(new Error(`[Orchestrator] Timeout waiting for ${label} (${timeoutMs / 1000}s)\n` +
            'Tip: increase RESEARCH_WAIT_MS / WRITE_WAIT_MS / EDIT_WAIT_MS'));
        }
      }, timeoutMs));
    });
  }
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

async function rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${GATEWAY_URL}/a2a/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const body = await res.json() as { result: Record<string, unknown>; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

/**
 * Wait for a HITL decision from either the terminal (readline) or the board (Socket.io → Redis).
 * The first source to deliver a valid decision wins; the other is cleaned up.
 *
 * Terminal: [1] PUBLISH  [2] REVISE  [3] REJECT  [4] VIEW (re-prompts)
 * Board:    emits hitl:decision → SocketGateway → kaiban-hitl-decisions Redis channel
 */
async function waitForHITLDecision(
  taskId: string,
  rl: readline.Interface,
  redisUrl: string,
  blogDraft: string,
): Promise<'PUBLISH' | 'REVISE' | 'REJECT'> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (decision: 'PUBLISH' | 'REVISE' | 'REJECT') => {
      if (resolved) return;
      resolved = true;
      resolve(decision);
    };

    // ── Terminal path (preserves existing behaviour) ──────────────────────
    const askTerminal = () => {
      rl.question('\nYour decision [1] PUBLISH  [2] REVISE  [3] REJECT  [4] VIEW: ', (answer) => {
        if (resolved) return;
        const a = answer.trim();
        if (a === '1') finish('PUBLISH');
        else if (a === '2') finish('REVISE');
        else if (a === '3') finish('REJECT');
        else {
          if (a === '4') {
            console.log('\n─── FULL BLOG DRAFT ──────────────────────────────────');
            console.log(blogDraft);
            console.log('──────────────────────────────────────────────────────\n');
          }
          askTerminal();
        }
      });
    };
    askTerminal();

    // ── Board path (new): subscribe to Redis HITL channel ────────────────
    const sub = new Redis(redisUrl, { lazyConnect: false });
    sub.subscribe('kaiban-hitl-decisions').then(() => {
      sub.on('message', (_ch: string, msg: string) => {
        if (resolved) { void sub.quit(); return; }
        try {
          const parsed = JSON.parse(msg) as { taskId: string; decision: string };
          if (parsed.taskId === taskId && ['PUBLISH', 'REVISE', 'REJECT'].includes(parsed.decision)) {
            console.log(`\n🖥  Board decision received: ${parsed.decision}`);
            void sub.quit();
            finish(parsed.decision as 'PUBLISH' | 'REVISE' | 'REJECT');
          }
        } catch { /* ignore malformed messages */ }
      });
    }).catch(() => { /* Redis unavailable — terminal-only fallback */ });
  });
}

function parseRecommendation(review: string): 'PUBLISH' | 'REVISE' | 'REJECT' | 'UNKNOWN' {
  // Handle plain, bold (**Recommendation:**), and variations
  const match = /\*{0,2}Recommendation:?\*{0,2}\s*\*{0,2}(PUBLISH|REVISE|REJECT)\*{0,2}/i.exec(review);
  if (!match) return 'UNKNOWN';
  return match[1].toUpperCase() as 'PUBLISH' | 'REVISE' | 'REJECT';
}

function parseAccuracyScore(review: string): string {
  const match = /Accuracy Score:\s*([0-9.]+\/10)/i.exec(review);
  return match ? match[1] : 'N/A';
}

// ──────────────────────────────────────────────────────────────
// Main orchestration flow
// ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // For BullMQ: one driver handles both completed + failed queues.
  // For Kafka: separate consumer groups prevent the KafkaJS "can't subscribe after run()" issue.
  const isKafka = getDriverType() === 'kafka';
  const completedDriver = createDriver('-orchestrator-completed');
  const failedDriver = isKafka ? createDriver('-orchestrator-failed') : completedDriver;

  // Single shared router — must be created BEFORE any tasks are submitted
  const completionRouter = new CompletionRouter(completedDriver, failedDriver);

  // Direct Redis Pub/Sub publisher for orchestration states (HITL, errors, finish)
  const statePublisher = new OrchestratorStatePublisher(REDIS_URL);

  let socket: Socket | null = null;

  const cleanup = async (): Promise<void> => {
    socket?.disconnect();
    await completedDriver.disconnect();
    if (isKafka) await failedDriver.disconnect();
    await statePublisher.disconnect();
    rl.close();
  };

  try {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(' KAIBAN DISTRIBUTED — BLOG TEAM ORCHESTRATOR');
    console.log(`${'═'.repeat(60)}\n`);

    const health = await fetch(`${GATEWAY_URL}/health`).then((r) => r.json()) as { data: { status: string } };
    console.log(`✓ Gateway: ${health.data.status.toUpperCase()} at ${GATEWAY_URL}`);

    const card = await fetch(`${GATEWAY_URL}/.well-known/agent-card.json`).then((r) => r.json()) as {
      name: string; capabilities: string[];
    };
    console.log(`✓ Agent:   ${card.name} — [${card.capabilities.join(', ')}]\n`);

    socket = io(GATEWAY_URL, { transports: ['websocket'] });
    socket.on('state:update', (delta: Record<string, unknown>) => {
      const status = delta['teamWorkflowStatus'] ?? delta['status'];
      if (status) process.stdout.write(`  ⬡ Board: ${String(status)}\n`);
    });

    console.log(`📋 Topic: "${TOPIC}"\n`);

    // Broadcast workflow start — board shows RUNNING + topic + all agents IDLE
    statePublisher.workflowStarted(TOPIC);

    // ──────────────────────────────────────────────────────────
    // STEP 1 — Research
    // ──────────────────────────────────────────────────────────
    console.log('─'.repeat(60));
    console.log('STEP 1 — Ava (Researcher) is gathering information...');
    console.log('─'.repeat(60));

    const researchTask = await rpc('tasks.create', {
      agentId: 'researcher',
      instruction: `Research the latest news, key developments, and verifiable facts on: "${TOPIC}". Include specific data points, statistics, and notable developments.`,
      expectedOutput: 'A detailed research summary with key facts, trends, and developments. Distinguish confirmed facts from speculation.',
      inputs: { topic: TOPIC },
    });
    const researchTaskId = String(researchTask['taskId']);
    // Publish immediately — board shows task in TODO before researcher picks it up
    statePublisher.taskQueued(researchTaskId, `Research: ${TOPIC}`, 'researcher');
    console.log(`  ↳ Task queued: ${researchTaskId}`);
    console.log(`  ↳ Waiting up to ${RESEARCH_WAIT_MS / 1000}s for research...\n`);

    const researchSummary = await completionRouter.wait(researchTaskId, RESEARCH_WAIT_MS, 'research')
      .catch((err: Error) => {
        statePublisher.taskFailed(researchTaskId, 'researcher', 'Research task', err.message);
        throw err;
      });

    console.log('\n✅ RESEARCH COMPLETE');
    console.log('─'.repeat(60));
    console.log(researchSummary.slice(0, 600) + (researchSummary.length > 600 ? '\n  [...truncated...]' : ''));
    console.log('─'.repeat(60) + '\n');

    // ──────────────────────────────────────────────────────────
    // STEP 2 — Write
    // ──────────────────────────────────────────────────────────
    console.log('STEP 2 — Kai (Writer) is drafting the blog post...');
    console.log('─'.repeat(60));

    const writeTask = await rpc('tasks.create', {
      agentId: 'writer',
      instruction: `Write an engaging blog post about: "${TOPIC}". Use the research provided in the context. Structure: headline, introduction, 3–4 sections, conclusion. Only include verified facts.`,
      expectedOutput: 'A complete blog post in Markdown format, 500–800 words.',
      inputs: { topic: TOPIC },
      context: researchSummary,
    });
    const writeTaskId = String(writeTask['taskId']);
    statePublisher.taskQueued(writeTaskId, `Write blog: ${TOPIC}`, 'writer');
    console.log(`  ↳ Task queued: ${writeTaskId}`);
    console.log(`  ↳ Waiting up to ${WRITE_WAIT_MS / 1000}s for draft...\n`);

    const blogDraft = await completionRouter.wait(writeTaskId, WRITE_WAIT_MS, 'writing')
      .catch((err: Error) => {
        statePublisher.taskFailed(writeTaskId, 'writer', 'Writing task', err.message);
        throw err;
      });

    console.log('\n✅ DRAFT COMPLETE');
    console.log('─'.repeat(60));
    console.log(blogDraft.slice(0, 800) + (blogDraft.length > 800 ? '\n  [...full draft sent to editor...]' : ''));
    console.log('─'.repeat(60) + '\n');

    // ──────────────────────────────────────────────────────────
    // STEP 3 — Editorial Review
    // ──────────────────────────────────────────────────────────
    console.log('STEP 3 — Morgan (Editor) is reviewing for accuracy...');
    console.log('─'.repeat(60));

    const editTask = await rpc('tasks.create', {
      agentId: 'editor',
      instruction: 'Review the blog post draft for factual accuracy. Cross-reference every claim against the research summary. Output your review in the exact structured format from your background instructions.',
      expectedOutput: 'Structured editorial review: accuracy score, issues with severity, required changes, PUBLISH/REVISE/REJECT recommendation, rationale.',
      inputs: { topic: TOPIC },
      context: `--- RESEARCH SUMMARY ---\n${researchSummary}\n\n--- BLOG DRAFT ---\n${blogDraft}`,
    });
    const editTaskId = String(editTask['taskId']);
    statePublisher.taskQueued(editTaskId, 'Editorial Review', 'editor');
    console.log(`  ↳ Task queued: ${editTaskId}`);
    console.log(`  ↳ Waiting up to ${EDIT_WAIT_MS / 1000}s for editorial review...\n`);

    const editorialReview = await completionRouter.wait(editTaskId, EDIT_WAIT_MS, 'editorial review')
      .catch((err: Error) => {
        statePublisher.taskFailed(editTaskId, 'editor', 'Editorial review', err.message);
        throw err;
      });

    const recommendation = parseRecommendation(editorialReview);
    const accuracyScore  = parseAccuracyScore(editorialReview);

    console.log('\n');
    console.log('╔' + '═'.repeat(58) + '╗');
    console.log('║  📝 EDITORIAL REVIEW BY MORGAN' + ' '.repeat(27) + '║');
    console.log('╠' + '═'.repeat(58) + '╣');
    editorialReview.split('\n').forEach((l) => console.log(`║  ${l.slice(0, 56).padEnd(56)}║`));
    console.log('╚' + '═'.repeat(58) + '╝');
    console.log(`\n  Accuracy Score:  ${accuracyScore}`);
    console.log(`  Recommendation:  ${recommendation}\n`);

    // ──────────────────────────────────────────────────────────
    // STEP 4 — Human-in-the-Loop Decision
    // ──────────────────────────────────────────────────────────
    // Broadcast AWAITING_VALIDATION so the board shows the paused state
    statePublisher.awaitingHITL(editTaskId, 'Editorial Review — Human Decision Required', recommendation, accuracyScore);

    console.log('═'.repeat(60));
    console.log(' HUMAN REVIEW REQUIRED (HITL)');
    console.log('═'.repeat(60));

    const icon = recommendation === 'PUBLISH' ? '🟢' : recommendation === 'REVISE' ? '🟡' : '🔴';
    console.log(`\n${icon} Editor recommends ${recommendation} (Accuracy: ${accuracyScore})\n`);
    console.log('Options:\n  [1] PUBLISH\n  [2] REVISE → send back to Kai with notes\n  [3] REJECT\n  [4] VIEW full draft\n');

    console.log('  (Decide here or click Approve / Revise / Reject on the board)');
    const decision = await waitForHITLDecision(editTaskId, rl, REDIS_URL, blogDraft);

    if (decision === 'PUBLISH') {
      console.log('\n╔' + '═'.repeat(58) + '╗');
      console.log('║  🚀 PUBLISHED — FINAL BLOG POST' + ' '.repeat(26) + '║');
      console.log('╠' + '═'.repeat(58) + '╣');
      blogDraft.split('\n').forEach((l) => console.log(`║  ${l.slice(0, 56).padEnd(56)}║`));
      console.log('╚' + '═'.repeat(58) + '╝');
      console.log(`\n✅ Published. Accuracy: ${accuracyScore}\n`);
      statePublisher.workflowFinished(writeTaskId, TOPIC, editTaskId);

    } else if (decision === 'REVISE') {
      console.log('\n🔄 Sending back to Kai with editorial notes...\n');

      // Clear AWAITING_VALIDATION from the edit task so the board banner disappears
      statePublisher.publish({
        tasks: [{ taskId: editTaskId, title: 'Editorial Review', status: 'DOING',
          assignedToAgentId: 'editor', result: '🔄 Revision requested — sending back to writer' }],
      });

      const revisionTask = await rpc('tasks.create', {
        agentId: 'writer',
        instruction: `Revise your blog post about "${TOPIC}" addressing all editorial feedback below.`,
        expectedOutput: 'A fully revised blog post in Markdown addressing all editorial issues.',
        inputs: { topic: TOPIC },
        context: `--- ORIGINAL DRAFT ---\n${blogDraft}\n\n--- EDITORIAL FEEDBACK ---\n${editorialReview}\n\n--- RESEARCH ---\n${researchSummary}`,
      });
      const revisionTaskId = String(revisionTask['taskId']);
      statePublisher.taskQueued(revisionTaskId, `Revision: ${TOPIC}`, 'writer');
      console.log(`  ↳ Revision task queued: ${revisionTaskId}`);

      const revisedDraft = await completionRouter.wait(revisionTaskId, WRITE_WAIT_MS, 'revision');

      console.log('╔' + '═'.repeat(58) + '╗');
      console.log('║  ✏️  REVISED DRAFT' + ' '.repeat(40) + '║');
      console.log('╠' + '═'.repeat(58) + '╣');
      revisedDraft.split('\n').forEach((l) => console.log(`║  ${l.slice(0, 56).padEnd(56)}║`));
      console.log('╚' + '═'.repeat(58) + '╝');

      // Show AWAITING_VALIDATION for the revised draft — board displays the banner again
      statePublisher.awaitingHITL(revisionTaskId, 'Revised Draft — Approve for publication?', 'PUBLISH', 'N/A');

      console.log('\n═'.repeat(60));
      console.log(' REVISED DRAFT READY — HUMAN REVIEW REQUIRED (HITL)');
      console.log('═'.repeat(60));
      console.log('\nOptions:\n  [1] PUBLISH\n  [2] REVISE → save draft, stop\n  [3] REJECT\n  [4] VIEW full draft\n');
      console.log('  (Decide here or click Approve / Revise / Reject on the board)');

      const revisionDecision = await waitForHITLDecision(revisionTaskId, rl, REDIS_URL, revisedDraft);
      if (revisionDecision === 'PUBLISH') {
        console.log('\n✅ Revised draft published.\n');
        statePublisher.workflowFinished(revisionTaskId, TOPIC, editTaskId);
      } else {
        console.log('\n⏸  Draft saved. Run again to review further.\n');
        statePublisher.workflowStopped(revisionTaskId, 'Draft saved pending further review', editTaskId);
      }

    } else { // REJECT
      console.log('\n🗑  Post rejected.\n');
      const rationaleMatch = /Rationale\s*\n([\s\S]+)$/i.exec(editorialReview);
      const rationale = rationaleMatch ? rationaleMatch[1].trim() : 'Rejected by human reviewer';
      if (rationaleMatch) console.log(rationale);
      statePublisher.workflowStopped(editTaskId, rationale, editTaskId);
    }

    console.log('─'.repeat(60));
    console.log(`View full trace: ${GATEWAY_URL}  |  Board: examples/blog-team/viewer/board.html`);
    console.log('─'.repeat(60) + '\n');

  } finally {
    await cleanup();
  }
}

main().catch((err: unknown) => {
  console.error('[Orchestrator] Fatal error:', err);
  process.exit(1);
});
