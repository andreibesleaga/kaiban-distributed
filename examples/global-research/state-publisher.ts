/**
 * Global Research State Publisher
 *
 * Extends OrchestratorStatePublisher with research-swarm-specific board
 * publications. Extracted from the main orchestrator to reduce its line count.
 */
import { OrchestratorStatePublisher } from '../../src/shared';
import { randomUUID } from 'crypto';
import type { ResearchContext } from './types';

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

export function extractSearchResults(
  agentOutput: string,
  agentId: string,
  subTopic: string,
): { sourceUrl: string; title: string; snippet: string; relevanceScore: number; agentId: string; timestamp: string } {
  return {
    sourceUrl: `research://${agentId}/${randomUUID()}`,
    title: subTopic.slice(0, 80),
    snippet: agentOutput.slice(0, 500),
    relevanceScore: 0.85 + Math.random() * 0.15,
    agentId,
    timestamp: new Date().toISOString(),
  };
}

// ── State publisher ───────────────────────────────────────────────────────────

export class ResearchStatePublisher extends OrchestratorStatePublisher {
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
      tasks: [{
        taskId, title: 'Editorial Review — Human Decision Required', status: 'AWAITING_VALIDATION',
        assignedToAgentId: 'editor',
        result: `Governance: ${recommendation} | Score: ${complianceScore} — Awaiting human decision`,
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
}
