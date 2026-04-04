/**
 * Blog Team Pipeline Phases
 *
 * Contains each discrete pipeline step as a standalone async function so the
 * orchestrator stays under 300 lines and complexity limits are respected.
 *
 * Functions follow the news-debaters pattern:
 *   runXxxPhase(deps...) → returns the phase output the next phase needs
 */
import readline from 'readline';
import {
  CompletionRouter,
  createRpcClient,
  parseHandlerResult,
  parseRecommendation,
  parseScore,
  waitForHITLDecision,
} from '../../src/shared';
import { BlogStatePublisher } from './state-publisher';
import { RunLogger } from './run-logger';

export const RESEARCH_WAIT_MS = parseInt(process.env['RESEARCH_WAIT_MS'] ?? '120000', 10);
export const WRITE_WAIT_MS    = parseInt(process.env['WRITE_WAIT_MS']    ?? '240000', 10);
export const EDIT_WAIT_MS     = parseInt(process.env['EDIT_WAIT_MS']     ?? '300000', 10);

// ── Phase result types ────────────────────────────────────────

export interface ResearchResult { taskId: string; summary: string; tokens: number; cost: number }
export interface WriteResult    { taskId: string; draft: string;   tokens: number; cost: number }
export interface EditResult     { taskId: string; review: string;  tokens: number; cost: number; recommendation: string; score: string }

// ── Phase functions ───────────────────────────────────────────

export async function runResearchPhase(
  topic: string,
  router: CompletionRouter,
  pub: BlogStatePublisher,
  rpc: ReturnType<typeof createRpcClient>,
  runLog: RunLogger,
): Promise<ResearchResult> {
  const task = await rpc.call('tasks.create', {
    agentId: 'researcher',
    instruction: `Research the latest news, key developments, and verifiable facts on: "${topic}". Include specific data points, statistics, and notable developments.`,
    expectedOutput: 'A detailed research summary with key facts, trends, and developments. Distinguish confirmed facts from speculation.',
    inputs: { topic },
  });
  const taskId = String(task['taskId']);
  pub.taskQueued(taskId, `Research: ${topic}`, 'researcher');

  const raw = await router.wait(taskId, RESEARCH_WAIT_MS, 'research')
    .catch((err: Error) => { pub.taskFailed(taskId, 'researcher', 'Research task', err.message); throw err; });

  const parsed = parseHandlerResult(raw);
  runLog.logTask('research', taskId, 'researcher', { ...parsed, answer: parsed.answer });
  pub.publishMetadata({ totalTokens: runLog.totals.totalTokens, estimatedCost: runLog.totals.totalCost });

  return { taskId, summary: parsed.answer, tokens: parsed.inputTokens + parsed.outputTokens, cost: parsed.estimatedCost };
}

export async function runWritePhase(
  topic: string,
  researchSummary: string,
  router: CompletionRouter,
  pub: BlogStatePublisher,
  rpc: ReturnType<typeof createRpcClient>,
  runLog: RunLogger,
): Promise<WriteResult> {
  const task = await rpc.call('tasks.create', {
    agentId: 'writer',
    instruction: `Write an engaging blog post about: "${topic}". Use the research provided in the context. Structure: headline, introduction, 3–4 sections, conclusion. Only include verified facts.`,
    expectedOutput: 'A complete blog post in Markdown format, 500–800 words.',
    inputs: { topic },
    context: researchSummary,
  });
  const taskId = String(task['taskId']);
  pub.taskQueued(taskId, `Write blog: ${topic}`, 'writer');

  const raw = await router.wait(taskId, WRITE_WAIT_MS, 'writing')
    .catch((err: Error) => { pub.taskFailed(taskId, 'writer', 'Writing task', err.message); throw err; });

  const parsed = parseHandlerResult(raw);
  runLog.logTask('write', taskId, 'writer', { ...parsed, answer: parsed.answer });
  pub.publishMetadata({ totalTokens: runLog.totals.totalTokens, estimatedCost: runLog.totals.totalCost });

  return { taskId, draft: parsed.answer, tokens: parsed.inputTokens + parsed.outputTokens, cost: parsed.estimatedCost };
}

export async function runEditorialPhase(
  topic: string,
  researchSummary: string,
  blogDraft: string,
  router: CompletionRouter,
  pub: BlogStatePublisher,
  rpc: ReturnType<typeof createRpcClient>,
  runLog: RunLogger,
): Promise<EditResult> {
  const task = await rpc.call('tasks.create', {
    agentId: 'editor',
    instruction: 'Review the blog post draft for factual accuracy. Cross-reference every claim against the research summary. Output your review in the exact structured format from your background instructions.',
    expectedOutput: 'Structured editorial review: accuracy score, issues with severity, required changes, PUBLISH/REVISE/REJECT recommendation, rationale.',
    inputs: { topic },
    context: `--- RESEARCH SUMMARY ---\n${researchSummary}\n\n--- BLOG DRAFT ---\n${blogDraft}`,
  });
  const taskId = String(task['taskId']);
  pub.taskQueued(taskId, 'Editorial Review', 'editor');

  const raw = await router.wait(taskId, EDIT_WAIT_MS, 'editorial review')
    .catch((err: Error) => { pub.taskFailed(taskId, 'editor', 'Editorial review', err.message); throw err; });

  const parsed = parseHandlerResult(raw);
  const recommendation = parseRecommendation(parsed.answer);
  const score          = parseScore(parsed.answer, 'Accuracy');
  runLog.logTask('editorial', taskId, 'editor', { ...parsed, answer: parsed.answer });
  pub.publishMetadata({ totalTokens: runLog.totals.totalTokens, estimatedCost: runLog.totals.totalCost });

  return { taskId, review: parsed.answer, tokens: parsed.inputTokens + parsed.outputTokens, cost: parsed.estimatedCost, recommendation, score };
}

// ── Revision loop (called on REVISE decision) ─────────────────

export interface RevisionDeps {
  topic: string;
  redisUrl: string;
  editTaskId: string;
  editorialReview: string;
  blogDraft: string;
  researchSummary: string;
  router: CompletionRouter;
  pub: BlogStatePublisher;
  rpc: ReturnType<typeof createRpcClient>;
  rl: readline.Interface;
  runLog: RunLogger;
  totalTokens: number;
  totalCost: number;
}

export async function runBlogRevision(deps: RevisionDeps): Promise<'PUBLISHED' | 'STOPPED'> {
  const { topic, redisUrl, editTaskId, editorialReview, blogDraft, researchSummary } = deps;
  const { router, pub, rpc, rl, runLog } = deps;

  pub.publish({
    tasks: [{ taskId: editTaskId, title: 'Editorial Review', status: 'DOING',
      assignedToAgentId: 'editor', result: 'Revision requested — sending back to writer' }],
  });

  const revTask = await rpc.call('tasks.create', {
    agentId: 'writer',
    instruction: `Revise your blog post about "${topic}" addressing all editorial feedback below.`,
    expectedOutput: 'A fully revised blog post in Markdown addressing all editorial issues.',
    inputs: { topic },
    context: `--- ORIGINAL DRAFT ---\n${blogDraft}\n\n--- EDITORIAL FEEDBACK ---\n${editorialReview}\n\n--- RESEARCH ---\n${researchSummary}`,
  });
  const revTaskId = String(revTask['taskId']);
  pub.taskQueued(revTaskId, `Revision: ${topic}`, 'writer');

  const revRaw    = await router.wait(revTaskId, WRITE_WAIT_MS, 'revision');
  const revParsed = parseHandlerResult(revRaw);
  runLog.logTask('revision', revTaskId, 'writer', { ...revParsed, answer: revParsed.answer });
  pub.publishMetadata({ totalTokens: runLog.totals.totalTokens, estimatedCost: runLog.totals.totalCost });

  pub.awaitingHITL(revTaskId, 'Revised Draft — Approve for publication?', 'PUBLISH', 'N/A');

  const revDecision = await waitForHITLDecision({
    taskId: revTaskId, rl, redisUrl,
    onView: () => { process.stdout.write('\n--- REVISED DRAFT ---\n' + revParsed.answer + '\n---\n'); },
  });

  const { totalTokens, totalCost } = runLog.totals;

  if (revDecision === 'PUBLISH') {
    pub.workflowFinished(revTaskId, topic, totalTokens, totalCost, editTaskId);
    return 'PUBLISHED';
  }
  pub.workflowStopped(revTaskId, 'Draft saved pending further review', totalTokens, totalCost, editTaskId);
  return 'STOPPED';
}

// ── HITL decision handler (keeps main() under complexity limit) ───────────────

export interface BlogDecisionDeps {
  topic: string;
  redisUrl: string;
  gatewayUrl: string;
  research: ResearchResult;
  write: WriteResult;
  edit: EditResult;
  router: CompletionRouter;
  pub: BlogStatePublisher;
  rpc: ReturnType<typeof createRpcClient>;
  rl: readline.Interface;
  runLog: RunLogger;
}

export async function handleBlogDecision(deps: BlogDecisionDeps): Promise<void> {
  const { topic, redisUrl, gatewayUrl, research, write, edit, router, pub, rpc, rl, runLog } = deps;

  pub.awaitingHITL(edit.taskId, 'Editorial Review — Human Decision Required', edit.recommendation, edit.score);

  const recIcon = edit.recommendation === 'PUBLISH' ? '[PUBLISH]' : edit.recommendation === 'REVISE' ? '[REVISE]' : '[REJECT]';
  process.stdout.write(`${recIcon} Editor recommends ${edit.recommendation} (Accuracy: ${edit.score})\n`);
  process.stdout.write('Options:\n  [1] PUBLISH\n  [2] REVISE → send back to Kai with notes\n  [3] REJECT\n  [4] VIEW full draft\n\n');
  process.stdout.write('  (Decide here or click Approve / Revise / Reject on the board)\n');

  const decision = await waitForHITLDecision({
    taskId: edit.taskId, rl, redisUrl,
    onView: () => { process.stdout.write('\n--- FULL BLOG DRAFT ---\n' + write.draft + '\n---\n'); },
  });

  const { totalTokens, totalCost } = runLog.totals;

  if (decision === 'PUBLISH') {
    process.stdout.write('\n--- PUBLISHED — FINAL BLOG POST ---\n' + write.draft + '\n');
    process.stdout.write(`\nPublished. Accuracy: ${edit.score}\n`);
    pub.workflowFinished(write.taskId, topic, totalTokens, totalCost, edit.taskId);
    runLog.finish('PUBLISHED');
    return;
  }

  if (decision === 'REVISE') {
    process.stdout.write('\nSending back to Kai with editorial notes...\n\n');
    const revOutcome = await runBlogRevision({
      topic, redisUrl, editTaskId: edit.taskId,
      editorialReview: edit.review, blogDraft: write.draft, researchSummary: research.summary,
      router, pub, rpc, rl, runLog, totalTokens, totalCost,
    });
    runLog.finish(revOutcome === 'PUBLISHED' ? 'REVISED' : 'STOPPED');
    return;
  }

  // REJECT
  process.stdout.write('\nPost rejected.\n\n');
  const rationaleMatch = /Rationale\s*\n([\s\S]+)$/i.exec(edit.review);
  const rationale = rationaleMatch ? rationaleMatch[1].trim() : 'Rejected by human reviewer';
  if (rationaleMatch) process.stdout.write(rationale + '\n');
  pub.workflowStopped(edit.taskId, rationale, totalTokens, totalCost, edit.taskId);
  runLog.finish('REJECTED');

  process.stdout.write(`\nView full trace: ${gatewayUrl}  |  Board: examples/blog-team/viewer/board.html\n`);
}

