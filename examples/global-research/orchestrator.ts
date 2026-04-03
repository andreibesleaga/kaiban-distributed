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
  createDriver, getDriverType,
  CompletionRouter, OrchestratorStatePublisher,
  createRpcClient, waitForHITLDecision,
  parseHandlerResult, parseRecommendation, parseScore, normaliseEditorialText,
} from '../../src/shared';
import type { ResearchContext, SearchResult } from './types';
import { issueA2AToken } from '../../src/infrastructure/security/a2a-auth';

const GATEWAY_URL    = process.env['GATEWAY_URL']      ?? 'http://localhost:3000';
const REDIS_URL      = process.env['REDIS_URL']        ?? 'redis://localhost:6379';
const QUERY          = process.env['QUERY']            ?? 'The Future of AI Agents';
const NUM_SEARCHERS  = parseInt(process.env['NUM_SEARCHERS']  ?? '4',      10);
const SEARCH_WAIT_MS = parseInt(process.env['SEARCH_WAIT_MS'] ?? '120000', 10);
const WRITE_WAIT_MS  = parseInt(process.env['WRITE_WAIT_MS']  ?? '240000', 10);
const REVIEW_WAIT_MS = parseInt(process.env['REVIEW_WAIT_MS'] ?? '180000', 10);
const EDIT_WAIT_MS   = parseInt(process.env['EDIT_WAIT_MS']   ?? '300000', 10);

const rpcClient = createRpcClient(GATEWAY_URL);

/**
 * When AUTO_PUBLISH=1, skip all readline prompts and auto-approve HITL as PUBLISH.
 * Also activates automatically when stdin is not a TTY (CI / piped usage).
 */
const AUTO_PUBLISH = process.env['AUTO_PUBLISH'] === '1'
                  || process.env['AUTO_PUBLISH'] === 'true'
                  || !process.stdin.isTTY;

// ── Research sub-topics (fan-out split) ──────────────────────────────────────

function buildSubTopics(query: string, n: number): string[] {
  const angles = [
    `Current state and recent breakthroughs in: ${query}`,
    `Key challenges and limitations of: ${query}`,
    `Industry applications and real-world use cases of: ${query}`,
    `Ethical implications and governance concerns of: ${query}`,
    `Future predictions and research directions for: ${query}`,
    `Economic impact and market trends related to: ${query}`,
    `Technical architecture and infrastructure for: ${query}`,
    `Regulatory landscape and compliance issues around: ${query}`,
  ];
  return angles.slice(0, n);
}

// ── All research swarm agents ─────────────────────────────────────────────────

function buildSwarmAgents(numSearchers: number): Array<{ agentId: string; name: string; role: string; status: 'IDLE'; currentTaskId: null }> {
  const agents = [
    { agentId: 'writer',   name: 'Atlas',  role: 'Research Synthesiser',      status: 'IDLE' as const, currentTaskId: null },
    { agentId: 'reviewer', name: 'Sage',   role: 'AI Ethics & Compliance',    status: 'IDLE' as const, currentTaskId: null },
    { agentId: 'editor',   name: 'Morgan', role: 'Chief Research Editor',     status: 'IDLE' as const, currentTaskId: null },
  ];
  for (let i = 0; i < numSearchers; i++) {
    agents.unshift({ agentId: `searcher-${i}`, name: `Zara-${i}`, role: 'Web Research Specialist', status: 'IDLE' as const, currentTaskId: null });
  }
  return agents;
}

// ── Research-specific state publisher ────────────────────────────────────────

class ResearchStatePublisher extends OrchestratorStatePublisher {
  workflowStarted(numSearchers: number): void {
    this.redis.del('kaiban:searcher:reg').catch(() => {});
    this.publish({ teamWorkflowStatus: 'RUNNING', agents: buildSwarmAgents(numSearchers), metadata: { startTime: Date.now() } });
  }

  searchingPhase(taskIds: string[]): void {
    this.publish({
      teamWorkflowStatus: 'RUNNING',
      tasks: taskIds.map((id, i) => ({
        taskId: id, title: `Search ${i + 1}: Sub-topic research`,
        status: 'DOING', assignedToAgentId: `searcher-${i}`,
      })),
    });
  }

  searchPhaseComplete(results: Array<{ taskId: string; result?: string; error?: string }>): void {
    this.publish({
      tasks: results.map((r, i) => ({
        taskId: r.taskId, status: r.error ? 'BLOCKED' : 'DONE',
        assignedToAgentId: `searcher-${i}`,
        ...(r.error ? { result: `Failed: ${r.error.slice(0, 100)}` } : {}),
      })),
    });
  }

  aggregatingPhase(writeTaskId: string, numResults: number): void {
    this.publish({ tasks: [{ taskId: writeTaskId, title: `Aggregating ${numResults} search results`, status: 'DOING', assignedToAgentId: 'writer' }] });
  }

  reviewingPhase(reviewTaskId: string): void {
    this.publish({ tasks: [{ taskId: reviewTaskId, title: 'Governance & Compliance Review', status: 'DOING', assignedToAgentId: 'reviewer' }] });
  }

  awaitingHITL(taskId: string, recommendation: string, complianceScore: string): void {
    this.publish({
      teamWorkflowStatus: 'RUNNING',
      tasks: [{ taskId, title: 'Editorial Review — Human Decision Required', status: 'AWAITING_VALIDATION', assignedToAgentId: 'editor',
        result: `Governance: ${recommendation} | Score: ${complianceScore} — Awaiting human decision` }],
    });
  }

  workflowFinished(ctx: ResearchContext, editTaskId: string): void {
    this.publish({
      teamWorkflowStatus: 'FINISHED',
      agents: buildSwarmAgents(0),
      tasks: [{ taskId: editTaskId, title: ctx.originalQuery.slice(0, 60), status: 'DONE',
        assignedToAgentId: 'editor',
        result: `Published | Tokens: ${ctx.metadata.totalTokens} | Cost: $${ctx.metadata.estimatedCost.toFixed(4)}` }],
      metadata: { ...ctx.metadata, endTime: ctx.metadata.endTime ?? Date.now() },
    });
  }

  workflowStopped(taskId: string, reason: string, ctx?: ResearchContext): void {
    this.publish({
      teamWorkflowStatus: 'STOPPED',
      tasks: [{ taskId, title: 'Workflow ended', status: 'BLOCKED', assignedToAgentId: 'editor', result: reason.slice(0, 200) }],
      metadata: ctx ? { ...ctx.metadata, endTime: ctx.metadata.endTime ?? Date.now() } : undefined,
    });
  }
}

function extractSearchResults(agentOutput: string, agentId: string, subTopic: string): SearchResult {
  return {
    sourceUrl: `research://${agentId}/${randomUUID()}`,
    title: subTopic.slice(0, 80),
    snippet: agentOutput.slice(0, 500),
    relevanceScore: 0.85 + Math.random() * 0.15,
    agentId,
    timestamp: new Date().toISOString(),
  };
}

// ── Phase result types ────────────────────────────────────────────────────────

interface GovernanceResult {
  recommendation: string; // APPROVED | CONDITIONAL | REJECTED
  score: string;          // e.g. "7.5/10"
  text: string;           // full governance review text
}

interface EditorialResult {
  taskId: string;
  recommendation: string; // PUBLISH | REVISE | REJECT
  score: string;          // accuracy score from editorial review
  text: string;           // full editorial review text
}

// ── Phase functions ───────────────────────────────────────────────────────────

/** STEP 1 — Fan-Out: dispatch N search tasks in parallel, collect all results. */
async function runSearchPhase(
  ctx: ResearchContext,
  router: CompletionRouter,
  pub: ResearchStatePublisher,
): Promise<void> {

  console.log('═'.repeat(70));
  console.log(`STEP 1 — Fan-Out: ${NUM_SEARCHERS} Searcher nodes gathering data in parallel...`);
  console.log('═'.repeat(70));

  ctx.status = 'SEARCHING';
  const subTopics    = buildSubTopics(QUERY, NUM_SEARCHERS);
  const searchTaskIds: string[] = [];

  await Promise.all(subTopics.map(async (subTopic, i) => {
    const task = await rpcClient.call('tasks.create', {
      agentId: 'searcher',
      instruction: `Research the following specific aspect: "${subTopic}". Provide detailed findings with source references, key facts, and relevant statistics.`,
      expectedOutput: 'Detailed research findings with source URLs, key facts, and relevant data points.',
      inputs: { topic: QUERY, subTopic, searchIndex: i },
    });
    const taskId = String(task['taskId']);
    searchTaskIds.push(taskId);

    console.log(`  Search task ${i + 1}/${NUM_SEARCHERS} queued: ${taskId.slice(-12)}`);
  }));

  pub.searchingPhase(searchTaskIds);

  console.log(`\n  Waiting up to ${SEARCH_WAIT_MS / 1000}s for all ${NUM_SEARCHERS} searchers...\n`);

  const searchResults = await router.waitAll(searchTaskIds, SEARCH_WAIT_MS, 'search');

  console.log(`\nSEARCH PHASE COMPLETE`);
  console.log(`  Succeeded: ${searchResults.filter(r => r.result).length}/${NUM_SEARCHERS}`);

  const failedSearches = searchResults.filter(r => r.error);
  if (failedSearches.length > 0) console.log(`  Failed (DLQ): ${failedSearches.length}/${NUM_SEARCHERS}`);

  for (let i = 0; i < searchResults.length; i++) {
    const sr = searchResults[i];
    if (sr.result) {
      const parsed = parseHandlerResult(sr.result);
      ctx.metadata.totalTokens   += parsed.inputTokens + parsed.outputTokens;
      ctx.metadata.estimatedCost += parsed.estimatedCost;
      ctx.rawSearchData.push(extractSearchResults(parsed.answer || sr.result, `searcher-${i}`, subTopics[i] ?? ''));
      ctx.metadata.activeNodes.push(`searcher-${i}`);
    }
  }

  if (ctx.rawSearchData.length === 0) throw new Error('All searcher tasks failed — no data to synthesise');

  console.log(`  ResearchContext populated with ${ctx.rawSearchData.length} search results`);
  console.log(`  Active nodes: [${ctx.metadata.activeNodes.join(', ')}]`);

  pub.searchPhaseComplete(searchResults);
}

/** STEP 2 — Fan-In: writer synthesises all search results into a consolidated draft. */
async function runWritePhase(
  ctx: ResearchContext,
  router: CompletionRouter,
  pub: ResearchStatePublisher,
): Promise<void> {

  console.log('\n' + '═'.repeat(70));
  console.log('STEP 2 — Fan-In: Atlas (Writer) synthesising research...');
  console.log('═'.repeat(70));

  ctx.status = 'AGGREGATING';
  const searchSummary = ctx.rawSearchData
    .map((r, i) => `[Source ${i + 1}] ${r.agentId}\nTopic: ${r.title}\n${r.snippet}`)
    .join('\n\n---\n\n');

  const writeTask = await rpcClient.call('tasks.create', {
    agentId: 'writer',
    instruction: `Synthesise the following ${ctx.rawSearchData.length} research results into a comprehensive, well-structured research report about: "${QUERY}". Cover all angles, highlight key findings, and note any conflicting information. Include an executive summary, main sections, and conclusions.`,
    expectedOutput: 'A comprehensive research report in Markdown format, 800-1200 words, covering all research angles.',
    inputs: { topic: QUERY, numSources: ctx.rawSearchData.length },
    context: `--- RESEARCH CONTEXT ID: ${ctx.id} ---\n\n${searchSummary}`,
  });
  const writeTaskId = String(writeTask['taskId']);
  pub.aggregatingPhase(writeTaskId, ctx.rawSearchData.length);

  console.log(`  Aggregation task queued: ${writeTaskId.slice(-12)}`);
  console.log(`  Waiting up to ${WRITE_WAIT_MS / 1000}s...\n`);

  const raw = await router.wait(writeTaskId, WRITE_WAIT_MS, 'writing')
    .catch((err: Error) => { pub.taskFailed(writeTaskId, 'writer', 'Research Synthesis', err.message); throw err; });

  const parsed = parseHandlerResult(raw);

  ctx.metadata.totalTokens   += parsed.inputTokens + parsed.outputTokens;
  ctx.metadata.estimatedCost += parsed.estimatedCost;
  ctx.consolidatedDraft = parsed.answer || raw;
  ctx.metadata.activeNodes.push('writer');
  pub.taskDone(writeTaskId, 'writer');

  console.log(`\nSYNTHESIS COMPLETE (${ctx.consolidatedDraft.length} chars)`);
  console.log(ctx.consolidatedDraft);
}

/** STEP 3 — Governance: reviewer checks the draft for compliance and ethics. */
async function runGovernancePhase(
  ctx: ResearchContext,
  router: CompletionRouter,
  pub: ResearchStatePublisher,
): Promise<GovernanceResult> {

  console.log('\n' + '═'.repeat(70));
  console.log('STEP 3 — Sage (Reviewer) running governance compliance check...');
  console.log('═'.repeat(70));

  ctx.status = 'REVIEWING';
  const reviewTask = await rpcClient.call('tasks.create', {
    agentId: 'reviewer',
    instruction: `Review the following research report for compliance with AI governance standards: IEEE AI 7000, EU AI Act, GDPR, OWASP AI Security Top 10, and NIST AI RMF. Check for: bias, privacy violations, unsubstantiated claims, security risks, and ethical concerns. Output your review in the exact structured format from your background instructions.`,
    expectedOutput: 'Structured governance review with compliance score, violations found, and APPROVED/CONDITIONAL/REJECTED recommendation.',
    inputs: { topic: QUERY, contextId: ctx.id },
    context: `--- ORIGINAL QUERY ---\n${QUERY}\n\n--- RESEARCH REPORT ---\n${ctx.consolidatedDraft}`,
  });
  const reviewTaskId = String(reviewTask['taskId']);
  pub.reviewingPhase(reviewTaskId);

  console.log(`  Governance review queued: ${reviewTaskId.slice(-12)}`);
  console.log(`  Waiting up to ${REVIEW_WAIT_MS / 1000}s...\n`);

  const raw = await router.wait(reviewTaskId, REVIEW_WAIT_MS, 'governance review')
    .catch((err: Error) => { pub.taskFailed(reviewTaskId, 'reviewer', 'Governance Review', err.message); throw err; });

  const parsed = parseHandlerResult(raw);
  ctx.metadata.totalTokens   += parsed.inputTokens + parsed.outputTokens;
  ctx.metadata.estimatedCost += parsed.estimatedCost;
  const text = parsed.answer || raw;
  ctx.metadata.activeNodes.push('reviewer');
  pub.taskDone(reviewTaskId, 'reviewer');

  const recommendation = parseRecommendation(text);
  const score          = parseScore(text, 'Compliance');

  const violations: string[] = [];
  for (const m of text.matchAll(/- (.+?) — Standard: .+? — Severity:/g)) { violations.push(m[1].trim()); }

  ctx.feedback = {
    isApproved: recommendation === 'APPROVED' || recommendation === 'CONDITIONAL',
    critique: text.slice(0, 500),
    complianceViolations: violations,
  };

  console.log('\n' + '='.repeat(70));
  console.log('GOVERNANCE REVIEW BY SAGE');
  console.log('='.repeat(70));
  console.log(text.split('\n').slice(0, 15).join('\n'));
  console.log(`\n  Compliance Score:  ${score}`);
  console.log(`  Recommendation:   ${recommendation}`);

  if (violations.length > 0) console.log(`  Violations:       ${violations.join(', ')}`);

  return { recommendation, score, text };
}

/** STEP 4 — Editorial: editor reviews the draft and queues the HITL decision on the board. */
async function runEditorialPhase(
  ctx: ResearchContext,
  gov: GovernanceResult,
  router: CompletionRouter,
  pub: ResearchStatePublisher,
): Promise<EditorialResult> {

  console.log('\n' + '═'.repeat(70));
  console.log('STEP 4 — Morgan (Editor) preparing HITL review...');
  console.log('═'.repeat(70));

  ctx.status = 'AWAITING_VALIDATION';
  const editTask = await rpcClient.call('tasks.create', {
    agentId: 'editor',
    instruction: `Perform a final editorial review of this research report about "${QUERY}". The governance review scored ${gov.score} (${gov.recommendation}). Check for quality, clarity, completeness, and proper attribution. Provide your editorial verdict.`,
    expectedOutput: 'Structured editorial review with recommendation: PUBLISH, REVISE, or REJECT.',
    inputs: { topic: QUERY, contextId: ctx.id },
    context: `--- GOVERNANCE REVIEW (${gov.recommendation}) ---\n${gov.text}\n\n--- RESEARCH REPORT ---\n${ctx.consolidatedDraft}`,
  });
  const editTaskId = String(editTask['taskId']);

  console.log(`  Editorial review queued: ${editTaskId.slice(-12)}`);
  console.log(`  Waiting up to ${EDIT_WAIT_MS / 1000}s...\n`);

  const raw = await router.wait(editTaskId, EDIT_WAIT_MS, 'editorial review')
    .catch((err: Error) => { pub.taskFailed(editTaskId, 'editor', 'Editorial Review', err.message); throw err; });

  const parsed = parseHandlerResult(raw);
  ctx.metadata.totalTokens   += parsed.inputTokens + parsed.outputTokens;
  ctx.metadata.estimatedCost += parsed.estimatedCost;

  const text = normaliseEditorialText(parsed.answer || raw);
  ctx.metadata.activeNodes.push('editor');

  const recommendation = parseRecommendation(text);
  const score          = parseScore(text, 'Compliance');

  pub.awaitingHITL(editTaskId, recommendation, score);

  console.log('\n' + '='.repeat(70));
  console.log('EDITORIAL REVIEW BY MORGAN');
  console.log('='.repeat(70));
  console.log(text.split('\n').slice(0, 12).join('\n'));
  console.log(`\n  Compliance Score: ${gov.score} (Governance)`);
  console.log(`  Editorial Score:  ${score}`);
  console.log(`  Recommendation:   ${recommendation}\n`);

  return { taskId: editTaskId, recommendation, score, text };
}

/** STEP 5 — Human Decision: present options and handle PUBLISH / REVISE / REJECT. */
async function handleDecision(
  ctx: ResearchContext,
  gov: GovernanceResult,
  edit: EditorialResult,
  router: CompletionRouter,
  pub: ResearchStatePublisher,
  rl: readline.Interface | null,
): Promise<void> {

  console.log('═'.repeat(70));
  console.log(' HUMAN DECISION REQUIRED (HITL)');
  console.log('═'.repeat(70));

  const icon = (edit.recommendation === 'PUBLISH' || edit.recommendation === 'APPROVED') ? '[APPROVED]'
             : (edit.recommendation === 'REVISE'  || edit.recommendation === 'CONDITIONAL') ? '[REVISE]' : '[REJECTED]';

  console.log(`\n${icon} Editor recommends ${edit.recommendation}`);
  console.log(`   Governance: ${gov.recommendation} (${gov.score})`);
  console.log(`   Searchers used: ${ctx.rawSearchData.length}/${NUM_SEARCHERS}`);
  console.log(`   Active nodes: [${ctx.metadata.activeNodes.join(', ')}]\n`);
  console.log('Options:\n  [1] PUBLISH — accept and finalise\n  [2] REVISE  — send back to writer with notes\n  [3] REJECT  — discard\n  [4] VIEW    — show full report\n');

  const decision: string = AUTO_PUBLISH
    ? 'PUBLISH'
    : await waitForHITLDecision({
        taskId: edit.taskId,
        rl,
        redisUrl: REDIS_URL,
        onView: () => {
          console.log('\n' + '-'.repeat(70));
          console.log(ctx.consolidatedDraft);
          console.log('-'.repeat(70) + '\n');
        },
      });
  if (AUTO_PUBLISH) console.log('[AUTO_PUBLISH] Skipping human prompt — auto-approving as PUBLISH.');

  ctx.metadata.endTime = Date.now();

  if (decision === 'PUBLISH') {
    ctx.status = 'COMPLETED';
    ctx.editorApproval = true;
    pub.workflowFinished(ctx, edit.taskId);

    console.log('\n' + '='.repeat(70));
    console.log('RESEARCH PUBLISHED');
    console.log('='.repeat(70));
    console.log(ctx.consolidatedDraft!.split('\n').slice(0, 20).join('\n'));
    console.log(`\n  ECONOMICS REPORT:`);
    console.log(`     Total Tokens:   ${ctx.metadata.totalTokens}`);
    console.log(`     Estimated Cost: $${ctx.metadata.estimatedCost.toFixed(4)}`);
    console.log(`     Nodes Active:   ${ctx.metadata.activeNodes.length} (${ctx.metadata.activeNodes.join(', ')})`);
    console.log(`     Started:        ${new Date(ctx.metadata.startTime).toISOString()}`);
    console.log(`     Completed:      ${new Date(ctx.metadata.endTime).toISOString()}\n`);

  } else if (decision === 'REVISE') {
    await runRevisionPhase(ctx, gov, edit, router, pub, rl);
  } else {
    ctx.status = 'FAILED';
    pub.workflowStopped(edit.taskId, 'Report rejected by human editor', ctx);

    console.log('\nResearch report rejected.\n');
  }
}

async function runRevisionPhase(
  ctx: ResearchContext,
  gov: GovernanceResult,
  edit: EditorialResult,
  router: CompletionRouter,
  pub: ResearchStatePublisher,
  rl: readline.Interface | null,
): Promise<void> {

  console.log('\nSending back to Atlas with editorial notes...\n');

  // Clear the original editorial-review task from AWAITING_VALIDATION so the
  // board banner disappears while the revision is being written.
  pub.taskDone(edit.taskId, 'editor');

  const revisionTask = await rpcClient.call('tasks.create', {
    agentId: 'writer',
    instruction: `Revise the research report about "${QUERY}" addressing all editorial feedback. Maintain compliance with governance standards (score: ${gov.score}).`,
    expectedOutput: 'A revised comprehensive research report addressing all editorial concerns.',
    inputs: { topic: QUERY, contextId: ctx.id },
    context: `--- EDITORIAL FEEDBACK ---\n${edit.text}\n\n--- GOVERNANCE NOTES ---\n${gov.text}\n\n--- ORIGINAL REPORT ---\n${ctx.consolidatedDraft}`,
  });
  const revisionTaskId = String(revisionTask['taskId']);
  const revisedRaw = await router.wait(revisionTaskId, WRITE_WAIT_MS, 'revision');
  const revisedParsed = parseHandlerResult(revisedRaw);
  ctx.metadata.totalTokens   += revisedParsed.inputTokens + revisedParsed.outputTokens;
  ctx.metadata.estimatedCost += revisedParsed.estimatedCost;
  ctx.consolidatedDraft = revisedParsed.answer || revisedRaw;
  ctx.metadata.activeNodes.push('writer-revision');

  // Full HITL gate for revision (board + terminal), not just a y/n prompt
  pub.awaitingHITL(revisionTaskId, 'PUBLISH', 'N/A');

  console.log('\n' + '='.repeat(70));
  console.log(' REVISED REPORT READY — HUMAN REVIEW REQUIRED (HITL)');
  console.log('='.repeat(70));
  console.log('\nOptions:\n  [1] PUBLISH\n  [2] REVISE → save draft, stop\n  [3] REJECT\n  [4] VIEW full report\n');
  console.log('  (Decide here or click Approve / Revise / Reject on the board)');

  const revisionDecision: string = AUTO_PUBLISH
    ? 'PUBLISH'
    : await waitForHITLDecision({
        taskId: revisionTaskId,
        rl,
        redisUrl: REDIS_URL,
        onView: () => {
          console.log('\n' + '-'.repeat(70));
          console.log(ctx.consolidatedDraft);
          console.log('-'.repeat(70) + '\n');
        },
      });
  if (AUTO_PUBLISH) console.log('[AUTO_PUBLISH] Auto-approving revision.');

  if (revisionDecision === 'PUBLISH') {
    ctx.status = 'COMPLETED';
    ctx.editorApproval = true;
    pub.workflowFinished(ctx, revisionTaskId);

    console.log('\nRevised research report published.\n');
  } else {
    ctx.status = 'FAILED';
    pub.workflowStopped(revisionTaskId, 'Report saved pending further review', ctx);

    console.log('\nReport saved. Re-run to continue.\n');
  }
}

// ── Main orchestration flow ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const rl = AUTO_PUBLISH ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const isKafka = getDriverType() === 'kafka';
  const completedDriver = createDriver('-orchestrator-completed');
  const failedDriver    = isKafka ? createDriver('-orchestrator-failed') : completedDriver;

  const router = new CompletionRouter(completedDriver, failedDriver);
  const pub    = new ResearchStatePublisher(REDIS_URL);

  const ctx: ResearchContext = {
    id: randomUUID(),
    originalQuery: QUERY,
    status: 'INITIALIZED',
    rawSearchData: [],
    editorApproval: false,
    metadata: { totalTokens: 0, estimatedCost: 0, startTime: Date.now(), activeNodes: [] },
  };

  let socket: Socket | null = null;

  const cleanup = async (): Promise<void> => {
    socket?.disconnect();
    await completedDriver.disconnect();
    if (isKafka) await failedDriver.disconnect();
    await pub.disconnect();
    rl?.close();
  };

  try {

    console.log(`\n${'═'.repeat(70)}`);
    console.log(' KAIBAN DISTRIBUTED — GLOBAL RESEARCH SWARM ORCHESTRATOR');
    console.log(`${'═'.repeat(70)}\n`);

    // Issue A2A bearer token if secret is configured
    if (process.env['A2A_JWT_SECRET']) {
      rpcClient.setToken(issueA2AToken('global-research-orchestrator'));
      console.log('✓ A2A auth token issued');
    }

    const health = await fetch(`${GATEWAY_URL}/health`).then((r) => r.json()) as { data: { status: string } };
    console.log(`Gateway: ${health.data.status.toUpperCase()} at ${GATEWAY_URL}`);

    socket = io(GATEWAY_URL, { transports: ['websocket'] });
    socket.on('state:update', (delta: Record<string, unknown>) => {
      const status = delta['teamWorkflowStatus'] ?? delta['status'];
      if (status) process.stdout.write(`  Board: ${String(status)}\n`);
    });

    console.log(`\nQuery:    "${QUERY}"`);
    console.log(`Searchers: ${NUM_SEARCHERS} parallel nodes`);
    console.log(`Context:  ${ctx.id}\n`);

    pub.workflowStarted(NUM_SEARCHERS);

    await runSearchPhase(ctx, router, pub);
    await runWritePhase(ctx, router, pub);

    const gov = await runGovernancePhase(ctx, router, pub);
    if (gov.recommendation === 'REJECTED') {
      ctx.metadata.endTime = Date.now();
      pub.workflowStopped(randomUUID(), `Governance rejected: ${ctx.feedback?.complianceViolations.join('; ') ?? gov.text.slice(0, 200)}`, ctx);
      console.log('\nGovernance review REJECTED the report. Workflow stopped.');
      console.log('   Review violations above and re-run with corrected query or constraints.\n');
      return;
    }

    const edit = await runEditorialPhase(ctx, gov, router, pub);
    await handleDecision(ctx, gov, edit, router, pub, rl);

    console.log('─'.repeat(70));
    console.log(`View board: examples/global-research/viewer/board.html`);
    console.log(`Context ID: ${ctx.id}`);
    console.log('─'.repeat(70) + '\n');

  } finally {
    await cleanup();
  }
}

main().catch((err: unknown) => {
  console.error('[Orchestrator] Fatal error:', err);
  process.exit(1);
});
