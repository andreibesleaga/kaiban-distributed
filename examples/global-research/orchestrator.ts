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
import { Redis } from 'ioredis';
import { createDriver, getDriverType } from './driver-factory';
import { COMPLETED_QUEUE } from './team-config';
import type { ResearchContext, SearchResult } from './types';
import { wrapSigned } from '../../src/infrastructure/security/channel-signing';
import { issueA2AToken } from '../../src/infrastructure/security/a2a-auth';

const GATEWAY_URL    = process.env['GATEWAY_URL']      ?? 'http://localhost:3000';
const REDIS_URL      = process.env['REDIS_URL']        ?? 'redis://localhost:6379';
const QUERY          = process.env['QUERY']            ?? 'The Future of AI Agents';
const NUM_SEARCHERS  = parseInt(process.env['NUM_SEARCHERS']  ?? '4',      10);
const SEARCH_WAIT_MS = parseInt(process.env['SEARCH_WAIT_MS'] ?? '120000', 10);
const WRITE_WAIT_MS  = parseInt(process.env['WRITE_WAIT_MS']  ?? '240000', 10);
const REVIEW_WAIT_MS = parseInt(process.env['REVIEW_WAIT_MS'] ?? '180000', 10);
const EDIT_WAIT_MS   = parseInt(process.env['EDIT_WAIT_MS']   ?? '300000', 10);

let a2aToken = '';

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

function buildSwarmAgents(numSearchers: number) {
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

// ── OrchestratorStatePublisher ────────────────────────────────────────────────

class OrchestratorStatePublisher {
  private redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { lazyConnect: false });
  }

  publish(delta: Record<string, unknown>): void {
    this.redis.publish('kaiban-state-events', wrapSigned(delta)).catch((err: unknown) =>
      console.error('[OrchestratorStatePublisher] Publish failed:', err),
    );
  }

  workflowStarted(numSearchers: number): void {
    // Reset the searcher self-registration counter so nodes starting up
    // for this run claim indices searcher-0, searcher-1, etc. from scratch.
    this.redis.del('kaiban:searcher:reg').catch(() => {});
    this.publish({ teamWorkflowStatus: 'RUNNING', agents: buildSwarmAgents(numSearchers) });
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

  taskDone(taskId: string, agentId: string): void {
    this.publish({ tasks: [{ taskId, status: 'DONE', assignedToAgentId: agentId }] });
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

  taskFailed(taskId: string, agentId: string, title: string, error: string): void {
    this.publish({
      agents: [{ agentId, name: agentId, role: agentId, status: 'ERROR', currentTaskId: taskId }],
      tasks: [{ taskId, title: title.slice(0, 60), status: 'BLOCKED', assignedToAgentId: agentId, result: `ERROR: ${error.slice(0, 200)}` }],
    });
  }

  workflowFinished(ctx: ResearchContext, editTaskId: string): void {
    this.publish({
      teamWorkflowStatus: 'FINISHED',
      agents: buildSwarmAgents(0),
      tasks: [{ taskId: editTaskId, title: ctx.originalQuery.slice(0, 60), status: 'DONE',
        assignedToAgentId: 'editor',
        result: `Published | Tokens: ${ctx.metadata.totalTokens} | Cost: $${ctx.metadata.estimatedCost.toFixed(4)}` }],
      metadata: ctx.metadata,
    });
  }

  workflowStopped(taskId: string, reason: string): void {
    this.publish({
      teamWorkflowStatus: 'STOPPED',
      tasks: [{ taskId, title: 'Workflow ended', status: 'BLOCKED', assignedToAgentId: 'editor', result: reason.slice(0, 200) }],
    });
  }

  async disconnect(): Promise<void> { await this.redis.quit(); }
}

// ── CompletionRouter ──────────────────────────────────────────────────────────

class CompletionRouter {
  private pendingResolve = new Map<string, (result: string) => void>();
  private pendingReject  = new Map<string, (err: Error) => void>();
  private timers         = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    completedDriver: import('../../src/infrastructure/messaging/interfaces').IMessagingDriver,
    failedDriver?: import('../../src/infrastructure/messaging/interfaces').IMessagingDriver,
  ) {
    const dlqDriver = failedDriver ?? completedDriver;

    void completedDriver.subscribe(COMPLETED_QUEUE, async (payload) => {
      const resolve = this.pendingResolve.get(payload.taskId);
      if (resolve) {
        this.clearPending(payload.taskId);
        const result = payload.data['result'];
        resolve(typeof result === 'string' ? result : JSON.stringify(result ?? ''));
      }
    });

    void dlqDriver.subscribe('kaiban-events-failed', async (payload) => {
      const reject = this.pendingReject.get(payload.taskId);
      if (reject) {
        this.clearPending(payload.taskId);
        reject(new Error(`Agent failed: ${String(payload.data['error'] ?? 'Task failed after max retries')}`));
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
          reject(new Error(`[Orchestrator] Timeout waiting for ${label} (${timeoutMs / 1000}s)`));
        }
      }, timeoutMs));
    });
  }

  /** Wait for ALL taskIds to complete (fan-in aggregation). */
  async waitAll(taskIds: string[], timeoutMs: number, label: string): Promise<Array<{ taskId: string; result?: string; error?: string }>> {
    const results: Array<{ taskId: string; result?: string; error?: string }> = [];
    await Promise.all(taskIds.map(taskId =>
      this.wait(taskId, timeoutMs, `${label}[${taskId}]`)
        .then(result => { results.push({ taskId, result }); })
        .catch((err: Error) => { results.push({ taskId, error: err.message }); }),
    ));
    return results;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (a2aToken) headers['Authorization'] = `Bearer ${a2aToken}`;
  const res = await fetch(`${GATEWAY_URL}/a2a/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const body = await res.json() as { result: Record<string, unknown>; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

/** Parse the structured KaibanHandlerResult returned by the bridge. Falls back gracefully for plain text. */
function parseHandlerResult(raw: string): { answer: string; inputTokens: number; outputTokens: number; estimatedCost: number } {
  try {
    const parsed = JSON.parse(raw) as { answer?: string; inputTokens?: number; outputTokens?: number; estimatedCost?: number };
    if (typeof parsed === 'object' && parsed !== null && 'answer' in parsed) {
      return {
        answer:        String(parsed.answer ?? ''),
        inputTokens:   Number(parsed.inputTokens  ?? 0),
        outputTokens:  Number(parsed.outputTokens ?? 0),
        estimatedCost: Number(parsed.estimatedCost ?? 0),
      };
    }
  } catch { /* not JSON — treat as plain text */ }
  return { answer: raw, inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
}

function parseRecommendation(review: string): string {
  const match =
    /\*{0,2}Recommendation:?\*{0,2}[*\s"]*\**\s*(APPROVED|CONDITIONAL|REJECTED|PUBLISH|REVISE|REJECT)/i.exec(review) ??
    /"[Rr]ecommendation"\s*:\s*"(APPROVED|CONDITIONAL|REJECTED|PUBLISH|REVISE|REJECT)"/i.exec(review);
  return match ? match[1].toUpperCase() : 'UNKNOWN';
}

function parseComplianceScore(review: string): string {
  const match = /(?:Compliance|Accuracy)\s+Score[*\s"]*:[*\s"]*([0-9]+(?:\.[0-9]+)?\/10)/i.exec(review);
  return match ? match[1] : 'N/A';
}

/** When the editor returns JSON format instead of markdown, reformat it for display. */
function normaliseEditorialText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const lines = ['## EDITORIAL REVIEW'];
    if (obj['Topic'])                lines.push(`**Topic:** ${obj['Topic']}`);
    if (obj['Accuracy Score'])       lines.push(`**Accuracy Score:** ${obj['Accuracy Score']}`);
    if (obj['Editorial Assessment']) lines.push(`### Editorial Assessment\n${obj['Editorial Assessment']}`);
    if (obj['Issues Found'])         lines.push(`### Issues Found\n${String(obj['Issues Found'])}`);
    if (obj['Required Changes'])     lines.push(`### Required Changes\n${String(obj['Required Changes'])}`);
    if (obj['Recommendation'])       lines.push(`### Recommendation: ${obj['Recommendation']}`);
    if (obj['Rationale'])            lines.push(`### Rationale\n${obj['Rationale']}`);
    return lines.join('\n');
  } catch {
    return trimmed;
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
  pub: OrchestratorStatePublisher,
): Promise<void> {
  console.log('═'.repeat(70));
  console.log(`STEP 1 — Fan-Out: ${NUM_SEARCHERS} Searcher nodes gathering data in parallel...`);
  console.log('═'.repeat(70));

  ctx.status = 'SEARCHING';
  const subTopics    = buildSubTopics(QUERY, NUM_SEARCHERS);
  const searchTaskIds: string[] = [];

  await Promise.all(subTopics.map(async (subTopic, i) => {
    const task = await rpc('tasks.create', {
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
  pub: OrchestratorStatePublisher,
): Promise<void> {
  console.log('\n' + '═'.repeat(70));
  console.log('STEP 2 — Fan-In: Atlas (Writer) synthesising research...');
  console.log('═'.repeat(70));

  ctx.status = 'AGGREGATING';
  const searchSummary = ctx.rawSearchData
    .map((r, i) => `[Source ${i + 1}] ${r.agentId}\nTopic: ${r.title}\n${r.snippet}`)
    .join('\n\n---\n\n');

  const writeTask = await rpc('tasks.create', {
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
  pub: OrchestratorStatePublisher,
): Promise<GovernanceResult> {
  console.log('\n' + '═'.repeat(70));
  console.log('STEP 3 — Sage (Reviewer) running governance compliance check...');
  console.log('═'.repeat(70));

  ctx.status = 'REVIEWING';
  const reviewTask = await rpc('tasks.create', {
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
  const score          = parseComplianceScore(text);

  const violations: string[] = [];
  for (const m of text.matchAll(/- (.+?) — Standard: .+? — Severity:/g)) { violations.push(m[1].trim()); }

  ctx.feedback = {
    isApproved: recommendation === 'APPROVED' || recommendation === 'CONDITIONAL',
    critique: text.slice(0, 500),
    complianceViolations: violations,
  };

  console.log('\n');
  console.log('╔' + '═'.repeat(68) + '╗');
  console.log('║  GOVERNANCE REVIEW BY SAGE' + ' '.repeat(41) + '║');
  console.log('╠' + '═'.repeat(68) + '╣');
  text.split('\n').slice(0, 15).forEach((l) => console.log(`║  ${l.slice(0, 66).padEnd(66)}║`));
  console.log('╚' + '═'.repeat(68) + '╝');
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
  pub: OrchestratorStatePublisher,
): Promise<EditorialResult> {
  console.log('\n' + '═'.repeat(70));
  console.log('STEP 4 — Morgan (Editor) preparing HITL review...');
  console.log('═'.repeat(70));

  ctx.status = 'AWAITING_VALIDATION';
  const editTask = await rpc('tasks.create', {
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
  const score          = parseComplianceScore(text);

  pub.awaitingHITL(editTaskId, recommendation, score);

  console.log('\n');
  console.log('╔' + '═'.repeat(68) + '╗');
  console.log('║  EDITORIAL REVIEW BY MORGAN' + ' '.repeat(40) + '║');
  console.log('╠' + '═'.repeat(68) + '╣');
  text.split('\n').slice(0, 12).forEach((l) => console.log(`║  ${l.slice(0, 66).padEnd(66)}║`));
  console.log('╚' + '═'.repeat(68) + '╝');
  console.log(`\n  Compliance Score: ${gov.score} (Governance)`);
  console.log(`  Editorial Score:  ${score}`);
  console.log(`  Recommendation:   ${recommendation}\n`);

  return { taskId: editTaskId, recommendation, score, text };
}

/**
 * Wait for a HITL decision from either the terminal (readline) or the board (Socket.io → Redis).
 * The first source to deliver a valid decision wins; the other is cleaned up.
 *
 * Terminal: [1] PUBLISH  [2] REVISE  [3] REJECT  [4] VIEW (re-prompts)
 * Board:    emits hitl:decision → SocketGateway → kaiban-hitl-decisions Redis channel
 *
 * Returns '1', '2', or '3' matching the terminal numbering.
 */
async function waitForHITLDecision(
  taskId: string,
  rl: readline.Interface | null,
  redisUrl: string,
  onView: () => void,
): Promise<'1' | '2' | '3'> {
  return new Promise((resolve) => {
    let resolved = false;

    // ── Board path: subscribe to Redis HITL channel ──────────────────────
    // Register handler BEFORE subscribe to avoid race where a message
    // arrives between subscribe completing and .then() firing.
    const BOARD_MAP: Record<string, '1' | '2' | '3'> = { PUBLISH: '1', REVISE: '2', REJECT: '3' };
    const sub = new Redis(redisUrl, { lazyConnect: false });
    sub.on('message', (_ch: string, msg: string) => {
      if (resolved) return;
      try {
        const parsed = JSON.parse(msg) as { taskId: string; decision: string };
        const mapped = BOARD_MAP[parsed.decision];
        if (parsed.taskId === taskId && mapped) {
          console.log(`\n🖥  Board decision received: ${parsed.decision}`);
          finish(mapped);
        }
      } catch { /* ignore malformed messages */ }
    });
    sub.subscribe('kaiban-hitl-decisions').catch(() => { /* Redis unavailable — terminal-only */ });

    const finish = (d: '1' | '2' | '3') => {
      if (resolved) return;
      resolved = true;
      sub.disconnect();
      // Feed empty line to release any pending rl.question callback so the
      // readline interface is ready for a potential second HITL round (REVISE).
      if (rl) rl.write('\n');
      resolve(d);
    };

    // ── Terminal path ────────────────────────────────────────────────────
    if (rl) {
      const askTerminal = () => {
        rl.question('\nYour decision [1] PUBLISH  [2] REVISE  [3] REJECT  [4] VIEW: ', (answer) => {
          if (resolved) return;
          const a = answer.trim();
          if (a === '1') finish('1');
          else if (a === '2') finish('2');
          else if (a === '3') finish('3');
          else {
            if (a === '4') onView();
            askTerminal();
          }
        });
      };
      askTerminal();
    }
  });
}

/** STEP 5 — Human Decision: present options and handle PUBLISH / REVISE / REJECT. */
async function handleDecision(
  ctx: ResearchContext,
  gov: GovernanceResult,
  edit: EditorialResult,
  router: CompletionRouter,
  pub: OrchestratorStatePublisher,
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

  let decision = '';
  if (AUTO_PUBLISH) {
    decision = '1';
    console.log('[AUTO_PUBLISH] Skipping human prompt — auto-approving as PUBLISH.');
  } else {
    decision = await waitForHITLDecision(
      edit.taskId,
      rl,
      REDIS_URL,
      () => {
        console.log('\n─── FULL RESEARCH REPORT ─────────────────────────────────────────────');
        console.log(ctx.consolidatedDraft);
        console.log('──────────────────────────────────────────────────────────────────────\n');
      },
    );
  }

  ctx.metadata.endTime = new Date().toISOString();

  if (decision === '1') {
    ctx.status = 'COMPLETED';
    ctx.editorApproval = true;
    pub.workflowFinished(ctx, edit.taskId);

    console.log('\n╔' + '═'.repeat(68) + '╗');
    console.log('║  RESEARCH PUBLISHED' + ' '.repeat(49) + '║');
    console.log('╠' + '═'.repeat(68) + '╣');
    ctx.consolidatedDraft!.split('\n').slice(0, 20).forEach((l) => console.log(`║  ${l.slice(0, 66).padEnd(66)}║`));
    console.log('╚' + '═'.repeat(68) + '╝');
    console.log(`\n  ECONOMICS REPORT:`);
    console.log(`     Total Tokens:   ${ctx.metadata.totalTokens}`);
    console.log(`     Estimated Cost: $${ctx.metadata.estimatedCost.toFixed(4)}`);
    console.log(`     Nodes Active:   ${ctx.metadata.activeNodes.length} (${ctx.metadata.activeNodes.join(', ')})`);
    console.log(`     Started:        ${ctx.metadata.startTime}`);
    console.log(`     Completed:      ${ctx.metadata.endTime}\n`);

  } else if (decision === '2') {
    console.log('\nSending back to Atlas with editorial notes...\n');

    // Clear the original editorial-review task from AWAITING_VALIDATION so the
    // board banner disappears while the revision is being written.
    pub.taskDone(edit.taskId, 'editor');

    const revisionTask = await rpc('tasks.create', {
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

    console.log('\n' + '═'.repeat(70));
    console.log(' REVISED REPORT READY — HUMAN REVIEW REQUIRED (HITL)');
    console.log('═'.repeat(70));
    console.log('\nOptions:\n  [1] PUBLISH\n  [2] REVISE → save draft, stop\n  [3] REJECT\n  [4] VIEW full report\n');
    console.log('  (Decide here or click Approve / Revise / Reject on the board)');

    let revisionDecision: string;
    if (AUTO_PUBLISH) {
      revisionDecision = '1';
      console.log('[AUTO_PUBLISH] Auto-approving revision.');
    } else {
      revisionDecision = await waitForHITLDecision(
        revisionTaskId,
        rl,
        REDIS_URL,
        () => {
          console.log('\n─── REVISED REPORT ──────────────────────────────────────────────────');
          console.log(ctx.consolidatedDraft);
          console.log('─────────────────────────────────────────────────────────────────────\n');
        },
      );
    }

    if (revisionDecision === '1') {
      ctx.status = 'COMPLETED';
      ctx.editorApproval = true;
      pub.workflowFinished(ctx, revisionTaskId);
      console.log('\nRevised research report published.\n');
    } else {
      ctx.status = 'FAILED';
      pub.workflowStopped(revisionTaskId, 'Report saved pending further review');
      console.log('\nReport saved. Re-run to continue.\n');
    }

  } else {
    ctx.status = 'FAILED';
    pub.workflowStopped(edit.taskId, 'Report rejected by human editor');
    console.log('\nResearch report rejected.\n');
  }
}

// ── Main orchestration flow ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const rl = AUTO_PUBLISH ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const isKafka = getDriverType() === 'kafka';
  const completedDriver = createDriver('-orchestrator-completed');
  const failedDriver    = isKafka ? createDriver('-orchestrator-failed') : completedDriver;

  const router = new CompletionRouter(completedDriver, failedDriver);
  const pub    = new OrchestratorStatePublisher(REDIS_URL);

  const ctx: ResearchContext = {
    id: randomUUID(),
    originalQuery: QUERY,
    status: 'INITIALIZED',
    rawSearchData: [],
    editorApproval: false,
    metadata: { totalTokens: 0, estimatedCost: 0, startTime: new Date().toISOString(), activeNodes: [] },
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
      a2aToken = issueA2AToken('global-research-orchestrator');
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
      pub.workflowStopped(randomUUID(), `Governance rejected: ${ctx.feedback?.complianceViolations.join('; ') ?? gov.text.slice(0, 200)}`);
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
