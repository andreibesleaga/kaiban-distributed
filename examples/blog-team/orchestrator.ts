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
  createDriver, getDriverType,
  CompletionRouter, OrchestratorStatePublisher,
  createRpcClient, waitForHITLDecision,
  parseHandlerResult, parseRecommendation, parseScore,
} from '../../src/shared';
import { issueA2AToken } from '../../src/infrastructure/security/a2a-auth';

const GATEWAY_URL      = process.env['GATEWAY_URL']      ?? 'http://localhost:3000';
const REDIS_URL        = process.env['REDIS_URL']        ?? 'redis://localhost:6379';
const TOPIC            = process.env['TOPIC']            ?? 'Latest developments in AI agents';
const RESEARCH_WAIT_MS = parseInt(process.env['RESEARCH_WAIT_MS'] ?? '120000', 10);
const WRITE_WAIT_MS    = parseInt(process.env['WRITE_WAIT_MS']    ?? '240000', 10);
const EDIT_WAIT_MS     = parseInt(process.env['EDIT_WAIT_MS']     ?? '300000', 10);

// ── Agent descriptors — resets board state on completion ──────

const BLOG_AGENTS = [
  { agentId: 'researcher', name: 'Ava',    role: 'News Researcher',        status: 'IDLE' as const, currentTaskId: null },
  { agentId: 'writer',     name: 'Kai',    role: 'Content Creator',        status: 'IDLE' as const, currentTaskId: null },
  { agentId: 'editor',     name: 'Morgan', role: 'Editorial Fact-Checker', status: 'IDLE' as const, currentTaskId: null },
];

// ── Blog-specific state publisher ─────────────────────────────

class BlogStatePublisher extends OrchestratorStatePublisher {
  workflowStarted(topic: string): void {
    this.publish({ teamWorkflowStatus: 'RUNNING', agents: BLOG_AGENTS, inputs: { topic }, metadata: { startTime: Date.now() } });
  }

  awaitingHITL(taskId: string, reviewTitle: string, recommendation: string, score: string): void {
    this.publish({
      teamWorkflowStatus: 'RUNNING',
      agents: BLOG_AGENTS,
      tasks: [{
        taskId,
        title: `${reviewTitle}`,
        status: 'AWAITING_VALIDATION',
        assignedToAgentId: 'editor',
        result: `Recommendation: ${recommendation} | Score: ${score} — Waiting for human decision`,
      }],
    });
  }

  workflowFinished(finalTaskId: string, topic: string, totalTokens: number, estimatedCost: number, editTaskId?: string): void {
    const tasks: Array<Record<string, unknown>> = [
      { taskId: finalTaskId, title: topic.slice(0, 60), status: 'DONE', assignedToAgentId: 'writer', result: 'Published' },
    ];
    if (editTaskId) {
      tasks.push({ taskId: editTaskId, title: 'Editorial Review', status: 'DONE', assignedToAgentId: 'editor', result: 'Approved for publication' });
    }
    this.publish({ teamWorkflowStatus: 'FINISHED', agents: BLOG_AGENTS, tasks, metadata: { totalTokens, estimatedCost, endTime: Date.now() } });
  }

  workflowStopped(taskId: string, reason: string, totalTokens: number, estimatedCost: number, editTaskId?: string): void {
    const tasks: Array<Record<string, unknown>> = [
      { taskId, title: 'Workflow ended', status: 'BLOCKED', assignedToAgentId: 'editor', result: reason.slice(0, 200) },
    ];
    if (editTaskId && editTaskId !== taskId) {
      tasks.push({ taskId: editTaskId, title: 'Editorial Review', status: 'BLOCKED', assignedToAgentId: 'editor', result: 'Workflow stopped' });
    }
    this.publish({ teamWorkflowStatus: 'STOPPED', agents: BLOG_AGENTS, tasks, metadata: { totalTokens, estimatedCost, endTime: Date.now() } });
  }
}


// ── Main orchestration flow ───────────────────────────────────

interface RevisionCtx {
  editTaskId: string;
  editorialReview: string;
  blogDraft: string;
  researchSummary: string;
  totalTokens: number;
  totalCost: number;
}

async function runBlogRevision(
  pub: BlogStatePublisher,
  router: CompletionRouter,
  rpc: ReturnType<typeof createRpcClient>,
  rl: readline.Interface,
  { editTaskId, editorialReview, blogDraft, researchSummary, totalTokens, totalCost }: RevisionCtx,
): Promise<void> {

  console.log('\nSending back to Kai with editorial notes...\n');

  pub.publish({
    tasks: [{ taskId: editTaskId, title: 'Editorial Review', status: 'DOING',
      assignedToAgentId: 'editor', result: 'Revision requested — sending back to writer' }],
  });

  const revisionTask = await rpc.call('tasks.create', {
    agentId: 'writer',
    instruction: `Revise your blog post about "${TOPIC}" addressing all editorial feedback below.`,
    expectedOutput: 'A fully revised blog post in Markdown addressing all editorial issues.',
    inputs: { topic: TOPIC },
    context: `--- ORIGINAL DRAFT ---\n${blogDraft}\n\n--- EDITORIAL FEEDBACK ---\n${editorialReview}\n\n--- RESEARCH ---\n${researchSummary}`,
  });
  const revisionTaskId = String(revisionTask['taskId']);
  pub.taskQueued(revisionTaskId, `Revision: ${TOPIC}`, 'writer');

  console.log(`  ↳ Revision task queued: ${revisionTaskId}`);

  const revisionRaw = await router.wait(revisionTaskId, WRITE_WAIT_MS, 'revision');
  const revisionParsed = parseHandlerResult(revisionRaw);
  const revisedDraft = revisionParsed.answer;
  totalTokens += revisionParsed.inputTokens + revisionParsed.outputTokens;
  totalCost   += revisionParsed.estimatedCost;
  pub.publishMetadata({ totalTokens, estimatedCost: totalCost });

  console.log('\n--- REVISED DRAFT ---');
  console.log(revisedDraft);
  console.log('---\n');

  pub.awaitingHITL(revisionTaskId, 'Revised Draft — Approve for publication?', 'PUBLISH', 'N/A');

  console.log('='.repeat(60));
  console.log(' REVISED DRAFT READY — HUMAN REVIEW REQUIRED (HITL)');
  console.log('='.repeat(60));
  console.log('\nOptions:\n  [1] PUBLISH\n  [2] REVISE → save draft, stop\n  [3] REJECT\n  [4] VIEW full draft\n');
  console.log('  (Decide here or click Approve / Revise / Reject on the board)');

  const revisionDecision = await waitForHITLDecision({
    taskId: revisionTaskId, rl, redisUrl: REDIS_URL,
    onView: () => { console.log('\n--- REVISED DRAFT ---\n' + revisedDraft + '\n---\n'); },
  });
  if (revisionDecision === 'PUBLISH') {
    console.log('\nRevised draft published.\n');
    pub.workflowFinished(revisionTaskId, TOPIC, totalTokens, totalCost, editTaskId);
  } else {
    console.log('\nDraft saved. Run again to review further.\n');
    pub.workflowStopped(revisionTaskId, 'Draft saved pending further review', totalTokens, totalCost, editTaskId);
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // For BullMQ: one driver handles both completed + failed queues.
  // For Kafka: separate consumer groups prevent the KafkaJS "can't subscribe after run()" issue.
  const isKafka = getDriverType() === 'kafka';
  const completedDriver = createDriver('-orchestrator-completed');
  const failedDriver = isKafka ? createDriver('-orchestrator-failed') : completedDriver;

  // Single shared router — must be created BEFORE any tasks are submitted
  const completionRouter = new CompletionRouter(completedDriver, failedDriver);

  // Blog-specific state publisher (extends base OrchestratorStatePublisher)
  const statePublisher = new BlogStatePublisher(REDIS_URL);
  const rpcClient = createRpcClient(GATEWAY_URL);

  let socket: Socket | null = null;

  const cleanup = async (): Promise<void> => {
    socket?.disconnect();
    await completedDriver.disconnect();
    if (isKafka) await failedDriver.disconnect();
    await statePublisher.disconnect();
    rl.close();
  };

  try {

    console.log(`\n${'='.repeat(60)}`);
    console.log(' KAIBAN DISTRIBUTED — BLOG TEAM ORCHESTRATOR');
    console.log(`${'='.repeat(60)}\n`);

    // Issue A2A bearer token if secret is configured
    if (process.env['A2A_JWT_SECRET']) {
      rpcClient.setToken(issueA2AToken('blog-team-orchestrator'));
      console.log('✓ A2A auth token issued');
    }

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

    // Running totals for EconomicsPanel on the board
    let totalTokens = 0;
    let totalCost = 0;

    // Broadcast workflow start — board shows RUNNING + topic + all agents IDLE + startTime
    statePublisher.workflowStarted(TOPIC);

    // ──────────────────────────────────────────────────────────
    // STEP 1 — Research
    // ──────────────────────────────────────────────────────────
    console.log('─'.repeat(60));
    console.log('STEP 1 — Ava (Researcher) is gathering information...');
    console.log('─'.repeat(60));

    const researchTask = await rpcClient.call('tasks.create', {
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

    const researchRaw = await completionRouter.wait(researchTaskId, RESEARCH_WAIT_MS, 'research')
      .catch((err: Error) => {
        statePublisher.taskFailed(researchTaskId, 'researcher', 'Research task', err.message);
        throw err;
      });
    const researchParsed = parseHandlerResult(researchRaw);
    const researchSummary = researchParsed.answer;
    totalTokens += researchParsed.inputTokens + researchParsed.outputTokens;
    totalCost   += researchParsed.estimatedCost;
    statePublisher.publishMetadata({ totalTokens, estimatedCost: totalCost });

    console.log('\n✅ RESEARCH COMPLETE');
    console.log('─'.repeat(60));
    console.log(researchSummary.slice(0, 600) + (researchSummary.length > 600 ? '\n  [...truncated...]' : ''));
    console.log('─'.repeat(60) + '\n');

    // ──────────────────────────────────────────────────────────
    // STEP 2 — Write
    // ──────────────────────────────────────────────────────────
    console.log('STEP 2 — Kai (Writer) is drafting the blog post...');
    console.log('─'.repeat(60));

    const writeTask = await rpcClient.call('tasks.create', {
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

    const writeRaw = await completionRouter.wait(writeTaskId, WRITE_WAIT_MS, 'writing')
      .catch((err: Error) => {
        statePublisher.taskFailed(writeTaskId, 'writer', 'Writing task', err.message);
        throw err;
      });
    const writeParsed = parseHandlerResult(writeRaw);
    const blogDraft = writeParsed.answer;
    totalTokens += writeParsed.inputTokens + writeParsed.outputTokens;
    totalCost   += writeParsed.estimatedCost;
    statePublisher.publishMetadata({ totalTokens, estimatedCost: totalCost });

    console.log('\n✅ DRAFT COMPLETE');
    console.log('─'.repeat(60));
    console.log(blogDraft);
    console.log('─'.repeat(60) + '\n');

    // ──────────────────────────────────────────────────────────
    // STEP 3 — Editorial Review
    // ──────────────────────────────────────────────────────────
    
    console.log('STEP 3 — Morgan (Editor) is reviewing for accuracy...');
    console.log('─'.repeat(60));

    const editTask = await rpcClient.call('tasks.create', {
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

    const editRaw = await completionRouter.wait(editTaskId, EDIT_WAIT_MS, 'editorial review')
      .catch((err: Error) => {
        statePublisher.taskFailed(editTaskId, 'editor', 'Editorial review', err.message);
        throw err;
      });
    const editParsed = parseHandlerResult(editRaw);
    const editorialReview = editParsed.answer;
    totalTokens += editParsed.inputTokens + editParsed.outputTokens;
    totalCost   += editParsed.estimatedCost;
    statePublisher.publishMetadata({ totalTokens, estimatedCost: totalCost });

    const recommendation = parseRecommendation(editorialReview);
    const accuracyScore  = parseScore(editorialReview, 'Accuracy');

    console.log('\n');
    console.log('='.repeat(60));
    console.log(' EDITORIAL REVIEW BY MORGAN');
    console.log('='.repeat(60));
    console.log(editorialReview);
    console.log('='.repeat(60));
    console.log(`\n  Accuracy Score:  ${accuracyScore}`);
    console.log(`  Recommendation:  ${recommendation}\n`);

    // ── STEP 4 — Human-in-the-Loop Decision ──────────────────
    // Broadcast AWAITING_VALIDATION so the board shows the paused state
    statePublisher.awaitingHITL(editTaskId, 'Editorial Review — Human Decision Required', recommendation, accuracyScore);

    console.log('='.repeat(60));
    console.log(' HUMAN REVIEW REQUIRED (HITL)');
    console.log('='.repeat(60));

    const icon = recommendation === 'PUBLISH' ? '[PUBLISH]' : recommendation === 'REVISE' ? '[REVISE]' : '[REJECT]';

    console.log(`\n${icon} Editor recommends ${recommendation} (Accuracy: ${accuracyScore})\n`);
    console.log('Options:\n  [1] PUBLISH\n  [2] REVISE → send back to Kai with notes\n  [3] REJECT\n  [4] VIEW full draft\n');

    console.log('  (Decide here or click Approve / Revise / Reject on the board)');

    const decision = await waitForHITLDecision({
      taskId: editTaskId, rl, redisUrl: REDIS_URL,
      onView: () => { console.log('\n--- FULL BLOG DRAFT ---\n' + blogDraft + '\n---\n'); },
    });

    if (decision === 'PUBLISH') {

      console.log('\n' + '='.repeat(60));
      console.log(' PUBLISHED — FINAL BLOG POST');
      console.log('='.repeat(60));
      console.log(blogDraft);
      console.log(`\nPublished. Accuracy: ${accuracyScore}\n`);

      statePublisher.workflowFinished(writeTaskId, TOPIC, totalTokens, totalCost, editTaskId);

    } else if (decision === 'REVISE') {
      await runBlogRevision(
        statePublisher, completionRouter, rpcClient, rl,
        { editTaskId, editorialReview, blogDraft, researchSummary, totalTokens, totalCost },
      );

    } else { // REJECT

      console.log('\nPost rejected.\n');
      
      const rationaleMatch = /Rationale\s*\n([\s\S]+)$/i.exec(editorialReview);
      const rationale = rationaleMatch ? rationaleMatch[1].trim() : 'Rejected by human reviewer';
      if (rationaleMatch) console.log(rationale);
      statePublisher.workflowStopped(editTaskId, rationale, totalTokens, totalCost, editTaskId);
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
