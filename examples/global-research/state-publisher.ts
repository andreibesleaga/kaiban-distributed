// SPDX-License-Identifier: GPL-3.0-only
/**
 * Global Research State Publisher
 *
 * Extends OrchestratorStatePublisher with research-swarm-specific board
 * publications. Extracted from the main orchestrator to reduce its line count.
 */
import { OrchestratorStatePublisher } from '../../src/shared';
import type { ResearchContext, SearchResult } from './types';

// ── Helper: build the full agent list for a given searcher count ──────────────

export function buildSwarmAgents(
  numSearchers: number,
): Array<{ agentId: string; name: string; role: string; status: 'IDLE'; currentTaskId: null }> {
  const fixed = [
    { agentId: 'writer',   name: 'Atlas',  role: 'Research Synthesiser',   status: 'IDLE' as const, currentTaskId: null },
    { agentId: 'reviewer', name: 'Sage',   role: 'AI Ethics & Compliance', status: 'IDLE' as const, currentTaskId: null },
    { agentId: 'editor',   name: 'Morgan', role: 'Chief Research Editor',  status: 'IDLE' as const, currentTaskId: null },
  ];
  const searchers = [];
  for (let i = 0; i < numSearchers; i++) {
    searchers.push({ agentId: `searcher-${i}`, name: `Zara-${i}`, role: 'Web Research Specialist', status: 'IDLE' as const, currentTaskId: null });
  }
  return [...searchers, ...fixed];
}

// ── Helper: extract structured SearchResult from raw agent output ─────────────

/** Longest searcher answer handed to the writer, in characters (bounds the writer's prompt). */
export const MAX_SEARCH_RESULT_CHARS = 20_000;

/**
 * Keep the searcher's answer whole (bounded by MAX_SEARCH_RESULT_CHARS): the
 * source references the searchers are asked for come late in the text, so a short
 * head would drop them. `sourceUrl` is the first URL the answer itself names, if
 * any; nothing is invented.
 */
export function extractSearchResults(
  agentOutput: string,
  agentId: string,
  subTopic: string,
): SearchResult {
  const sourceUrl = /https?:\/\/[^\s)\]>"']+/.exec(agentOutput)?.[0];
  return {
    ...(sourceUrl ? { sourceUrl } : {}),
    title: subTopic.slice(0, 80),
    snippet: agentOutput.slice(0, MAX_SEARCH_RESULT_CHARS),
    agentId,
    timestamp: new Date().toISOString(),
  };
}

// ── State publisher ───────────────────────────────────────────────────────────

export class ResearchStatePublisher extends OrchestratorStatePublisher {
  workflowStarted(numSearchers: number): void {
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

  searchPhaseComplete(
    results: Array<{ taskId: string; result?: string; error?: string }>,
  ): void {
    // Status only: the replica that ran each task already published itself as
    // the assignee (competing consumers take tasks in any order, so the
    // orchestrator cannot know which card ran which task).
    this.publish({
      tasks: results.map((r) => ({
        taskId: r.taskId, status: r.error ? 'BLOCKED' : 'DONE',
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

  /** The review task waiting for a human decision, if any (for reviewStopped). */
  private pendingReviewTaskId: string | null = null;

  /** The editor's verdict and Accuracy score, shown on the card the human decides on. */
  awaitingHITL(taskId: string, recommendation: string, accuracyScore: string): void {
    this.pendingReviewTaskId = taskId;
    this.publish({
      teamWorkflowStatus: 'RUNNING',
      tasks: [{
        taskId, title: 'Editorial Review — Human Decision Required', status: 'AWAITING_VALIDATION',
        assignedToAgentId: 'editor',
        result: `Editorial: ${recommendation} | Accuracy: ${accuracyScore} — Awaiting human decision`,
      }],
    });
  }

  workflowFinished(ctx: ResearchContext, editTaskId: string): void {
    this.publish({
      teamWorkflowStatus: 'FINISHED',
      agents: buildSwarmAgents(0),
      tasks: [{
        taskId: editTaskId, title: ctx.originalQuery.slice(0, 60), status: 'DONE',
        assignedToAgentId: 'editor',
        result: `Published | Tokens: ${ctx.metadata.totalTokens} | Cost: $${ctx.metadata.estimatedCost.toFixed(4)}`,
      }],
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

  /**
   * The review the orchestrator was waiting on ends STOPPED, so the board shows
   * no pending decision after the run exits — on an emergency STOP ALL (ADR-025,
   * the default reason) and on every other terminal path (budget stop, failure).
   */
  reviewStopped(reason = 'Emergency stop: no decision was taken'): void {
    if (!this.pendingReviewTaskId) return;
    this.publish({
      tasks: [{
        taskId: this.pendingReviewTaskId, title: 'Review stopped', status: 'STOPPED',
        assignedToAgentId: 'editor', result: reason,
      }],
    });
    this.pendingReviewTaskId = null;
  }
}
