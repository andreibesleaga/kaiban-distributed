/**
 * Global Research Pipeline Phases
 *
 * Each discrete pipeline step as a standalone async function so the
 * orchestrator stays under 300 lines and ESLint complexity limits are respected.
 *
 * Pipeline:  runSearchPhase → runWritePhase → runGovernancePhase
 *              → runEditorialPhase → handleDecision [→ runRevisionPhase]
 */
import readline from 'readline';
import {
  CompletionRouter,
  createRpcClient,
  parseHandlerResult,
  parseRecommendation,
  parseScore,
  normaliseEditorialText,
  waitForHITLDecision,
} from '../../src/shared';
import { ResearchStatePublisher, extractSearchResults } from './state-publisher';
import { RunLogger } from './run-logger';
import type { ResearchContext } from './types';

// ── Phase result types ────────────────────────────────────────────────────────

export interface GovernanceResult {
  recommendation: string; // APPROVED | CONDITIONAL | REJECTED
  score: string;
  text: string;
}

export interface EditorialResult {
  taskId: string;
  recommendation: string; // PUBLISH | REVISE | REJECT
  score: string;
  text: string;
}

// ── Sub-topic builder ─────────────────────────────────────────────────────────

export function buildSubTopics(query: string, n: number): string[] {
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

// ── Step 1 — Fan-Out search ───────────────────────────────────────────────────

export async function runSearchPhase(
  ctx: ResearchContext,
  query: string,
  numSearchers: number,
  searchWaitMs: number,
  router: CompletionRouter,
  pub: ResearchStatePublisher,
  rpc: ReturnType<typeof createRpcClient>,
  runLog: RunLogger,
): Promise<void> {
  ctx.status = 'SEARCHING';
  const subTopics = buildSubTopics(query, numSearchers);

  const taskIds = await Promise.all(subTopics.map(async (subTopic, i) => {
    const task = await rpc.call('tasks.create', {
      agentId: 'searcher',
      instruction: `Research this specific aspect: "${subTopic}". Provide detailed findings with source references.`,
      expectedOutput: 'Detailed research findings with source URLs, key facts, and relevant data points.',
      inputs: { topic: query, subTopic, searchIndex: i },
    });
    return String(task['taskId']);
  }));

  pub.searchingPhase(taskIds);

  const results = await router.waitAll(taskIds, searchWaitMs, 'search');

  for (let i = 0; i < results.length; i++) {
    const sr = results[i];
    if (sr.result) {
      const parsed = parseHandlerResult(sr.result);
      ctx.metadata.totalTokens   += parsed.inputTokens + parsed.outputTokens;
      ctx.metadata.estimatedCost += parsed.estimatedCost;
      ctx.rawSearchData.push(extractSearchResults(parsed.answer || sr.result, `searcher-${i}`, subTopics[i] ?? ''));
      ctx.metadata.activeNodes.push(`searcher-${i}`);
      runLog.logTask('search', taskIds[i] ?? '', `searcher-${i}`, { ...parsed, answer: parsed.answer });
    } else if (sr.error) {
      runLog.logError('search', taskIds[i] ?? '', `searcher-${i}`, sr.error);
    }
  }

  if (ctx.rawSearchData.length === 0) throw new Error('All searcher tasks failed — no data to synthesise');

  pub.searchPhaseComplete(results);
}

// ── Step 2 — Fan-In synthesis ─────────────────────────────────────────────────

export async function runWritePhase(
  ctx: ResearchContext,
  query: string,
  writeWaitMs: number,
  router: CompletionRouter,
  pub: ResearchStatePublisher,
  rpc: ReturnType<typeof createRpcClient>,
  runLog: RunLogger,
): Promise<void> {
  ctx.status = 'AGGREGATING';
  const searchSummary = ctx.rawSearchData
    .map((r, i) => `[Source ${i + 1}] ${r.agentId}\nTopic: ${r.title}\n${r.snippet}`)
    .join('\n\n---\n\n');

  const task = await rpc.call('tasks.create', {
    agentId: 'writer',
    instruction: `Synthesise the following ${ctx.rawSearchData.length} research results into a comprehensive report about: "${query}". Cover all angles, highlight key findings, note conflicts. Include executive summary, main sections, and conclusions.`,
    expectedOutput: 'A comprehensive research report in Markdown format, 800-1200 words.',
    inputs: { topic: query, numSources: ctx.rawSearchData.length },
    context: `--- RESEARCH CONTEXT ID: ${ctx.id} ---\n\n${searchSummary}`,
  });
  const taskId = String(task['taskId']);
  pub.aggregatingPhase(taskId, ctx.rawSearchData.length);

  const raw = await router.wait(taskId, writeWaitMs, 'writing')
    .catch((err: Error) => { pub.taskFailed(taskId, 'writer', 'Research Synthesis', err.message); throw err; });

  const parsed = parseHandlerResult(raw);
  ctx.metadata.totalTokens   += parsed.inputTokens + parsed.outputTokens;
  ctx.metadata.estimatedCost += parsed.estimatedCost;
  ctx.consolidatedDraft = parsed.answer || raw;
  ctx.metadata.activeNodes.push('writer');
  pub.taskDone(taskId, 'writer');
  runLog.logTask('write', taskId, 'writer', { ...parsed, answer: parsed.answer });
}

// ── Step 3 — Governance review ────────────────────────────────────────────────

export async function runGovernancePhase(
  ctx: ResearchContext,
  query: string,
  reviewWaitMs: number,
  router: CompletionRouter,
  pub: ResearchStatePublisher,
  rpc: ReturnType<typeof createRpcClient>,
  runLog: RunLogger,
): Promise<GovernanceResult> {
  ctx.status = 'REVIEWING';
  const task = await rpc.call('tasks.create', {
    agentId: 'reviewer',
    instruction: 'Review the following research report for compliance with IEEE AI 7000, EU AI Act, GDPR, OWASP AI Security Top 10, and NIST AI RMF. Check for bias, privacy violations, unsubstantiated claims, security risks, and ethical concerns. Output in the exact structured format from your background instructions.',
    expectedOutput: 'Structured governance review with compliance score, violations, and APPROVED/CONDITIONAL/REJECTED recommendation.',
    inputs: { topic: query, contextId: ctx.id },
    context: `--- ORIGINAL QUERY ---\n${query}\n\n--- RESEARCH REPORT ---\n${ctx.consolidatedDraft}`,
  });
  const taskId = String(task['taskId']);
  pub.reviewingPhase(taskId);

  const raw = await router.wait(taskId, reviewWaitMs, 'governance review')
    .catch((err: Error) => { pub.taskFailed(taskId, 'reviewer', 'Governance Review', err.message); throw err; });

  const parsed = parseHandlerResult(raw);
  ctx.metadata.totalTokens   += parsed.inputTokens + parsed.outputTokens;
  ctx.metadata.estimatedCost += parsed.estimatedCost;
  const text = parsed.answer || raw;
  ctx.metadata.activeNodes.push('reviewer');
  pub.taskDone(taskId, 'reviewer');
  runLog.logTask('governance', taskId, 'reviewer', { ...parsed, answer: text });

  const recommendation = parseRecommendation(text);
  const score          = parseScore(text, 'Compliance');
  const violations: string[] = [];
  for (const m of text.matchAll(/- (.+?) — Standard: .+? — Severity:/g)) { violations.push(m[1].trim()); }
  ctx.feedback = { isApproved: recommendation !== 'REJECTED', critique: text.slice(0, 500), complianceViolations: violations };

  return { recommendation, score, text };
}

// ── Step 4 — Editorial review ─────────────────────────────────────────────────

export async function runEditorialPhase(
  ctx: ResearchContext,
  query: string,
  gov: GovernanceResult,
  editWaitMs: number,
  router: CompletionRouter,
  pub: ResearchStatePublisher,
  rpc: ReturnType<typeof createRpcClient>,
  runLog: RunLogger,
): Promise<EditorialResult> {
  ctx.status = 'AWAITING_VALIDATION';
  const task = await rpc.call('tasks.create', {
    agentId: 'editor',
    instruction: `Perform a final editorial review of this research report about "${query}". The governance review scored ${gov.score} (${gov.recommendation}). Check for quality, clarity, completeness, and proper attribution. Provide your editorial verdict.`,
    expectedOutput: 'Structured editorial review with recommendation: PUBLISH, REVISE, or REJECT.',
    inputs: { topic: query, contextId: ctx.id },
    context: `--- GOVERNANCE REVIEW (${gov.recommendation}) ---\n${gov.text}\n\n--- RESEARCH REPORT ---\n${ctx.consolidatedDraft}`,
  });
  const taskId = String(task['taskId']);

  const raw = await router.wait(taskId, editWaitMs, 'editorial review')
    .catch((err: Error) => { pub.taskFailed(taskId, 'editor', 'Editorial Review', err.message); throw err; });

  const parsed = parseHandlerResult(raw);
  ctx.metadata.totalTokens   += parsed.inputTokens + parsed.outputTokens;
  ctx.metadata.estimatedCost += parsed.estimatedCost;
  const text = normaliseEditorialText(parsed.answer || raw);
  ctx.metadata.activeNodes.push('editor');
  pub.awaitingHITL(taskId, parseRecommendation(text), parseScore(text, 'Compliance'));
  runLog.logTask('editorial', taskId, 'editor', { ...parsed, answer: text });

  return { taskId, recommendation: parseRecommendation(text), score: parseScore(text, 'Compliance'), text };
}

// ── Step 5 — Revision (called on REVISE decision) ─────────────────────────────

export interface RevisionDeps {
  ctx: ResearchContext;
  query: string;
  redisUrl: string;
  gov: GovernanceResult;
  edit: EditorialResult;
  writeWaitMs: number;
  autoPub: boolean;
  router: CompletionRouter;
  pub: ResearchStatePublisher;
  rpc: ReturnType<typeof createRpcClient>;
  rl: readline.Interface | null;
  runLog: RunLogger;
}

export async function runRevisionPhase(deps: RevisionDeps): Promise<void> {
  const { ctx, query, redisUrl, gov, edit, writeWaitMs, autoPub, router, pub, rpc, rl, runLog } = deps;

  pub.taskDone(edit.taskId, 'editor');

  const task = await rpc.call('tasks.create', {
    agentId: 'writer',
    instruction: `Revise the research report about "${query}" addressing all editorial feedback. Maintain compliance with governance standards (score: ${gov.score}).`,
    expectedOutput: 'A revised comprehensive research report addressing all editorial concerns.',
    inputs: { topic: query, contextId: ctx.id },
    context: `--- EDITORIAL FEEDBACK ---\n${edit.text}\n\n--- GOVERNANCE NOTES ---\n${gov.text}\n\n--- ORIGINAL REPORT ---\n${ctx.consolidatedDraft}`,
  });
  const taskId = String(task['taskId']);
  const raw    = await router.wait(taskId, writeWaitMs, 'revision');
  const parsed = parseHandlerResult(raw);
  ctx.metadata.totalTokens   += parsed.inputTokens + parsed.outputTokens;
  ctx.metadata.estimatedCost += parsed.estimatedCost;
  ctx.consolidatedDraft = parsed.answer || raw;
  ctx.metadata.activeNodes.push('writer-revision');
  runLog.logTask('revision', taskId, 'writer', { ...parsed, answer: parsed.answer });

  pub.awaitingHITL(taskId, 'PUBLISH', 'N/A');

  const decision = autoPub ? 'PUBLISH' : await waitForHITLDecision({
    taskId, rl, redisUrl,
    onView: () => { process.stdout.write('\n' + '-'.repeat(70) + '\n' + (ctx.consolidatedDraft ?? '') + '\n' + '-'.repeat(70) + '\n\n'); },
  });

  ctx.metadata.endTime = Date.now();
  if (decision === 'PUBLISH') {
    ctx.status = 'COMPLETED'; ctx.editorApproval = true;
    pub.workflowFinished(ctx, taskId);
    runLog.finish('REVISED');
  } else {
    ctx.status = 'FAILED';
    pub.workflowStopped(taskId, 'Report saved pending further review', ctx);
    runLog.finish('STOPPED');
  }
}

// ── Step 5 — Handle PUBLISH / REVISE / REJECT decision ────────────────────────

export interface DecisionDeps {
  ctx: ResearchContext;
  query: string;
  redisUrl: string;
  gov: GovernanceResult;
  edit: EditorialResult;
  writeWaitMs: number;
  autoPub: boolean;
  router: CompletionRouter;
  pub: ResearchStatePublisher;
  rpc: ReturnType<typeof createRpcClient>;
  rl: readline.Interface | null;
  runLog: RunLogger;
}

export async function handleDecision(deps: DecisionDeps): Promise<void> {
  const { ctx, query, redisUrl, gov, edit, writeWaitMs, autoPub, router, pub, rpc, rl, runLog } = deps;

  const decision = autoPub ? 'PUBLISH' : await waitForHITLDecision({
    taskId: edit.taskId, rl, redisUrl,
    onView: () => {
      process.stdout.write('\n' + '-'.repeat(70) + '\n' + (ctx.consolidatedDraft ?? '') + '\n' + '-'.repeat(70) + '\n\n');
    },
  });

  ctx.metadata.endTime = Date.now();

  if (decision === 'PUBLISH') {
    ctx.status = 'COMPLETED'; ctx.editorApproval = true;
    pub.workflowFinished(ctx, edit.taskId);
    runLog.finish('PUBLISHED');

  } else if (decision === 'REVISE') {
    await runRevisionPhase({ ctx, query, redisUrl, gov, edit, writeWaitMs, autoPub, router, pub, rpc, rl, runLog });

  } else {
    ctx.status = 'FAILED';
    pub.workflowStopped(edit.taskId, 'Report rejected by human editor', ctx);
    runLog.finish('REJECTED');
  }
}
