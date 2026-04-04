/**
 * Blog Team State Publisher
 *
 * Extends OrchestratorStatePublisher with blog-pipeline–specific lifecycle
 * events: workflow start, HITL gating, finish, and stop.
 */
import { OrchestratorStatePublisher } from '../../src/shared';

// ── Agent descriptors — resets board state on workflow start ──

export const BLOG_AGENTS = [
  { agentId: 'researcher', name: 'Ava',    role: 'News Researcher',        status: 'IDLE' as const, currentTaskId: null },
  { agentId: 'writer',     name: 'Kai',    role: 'Content Creator',        status: 'IDLE' as const, currentTaskId: null },
  { agentId: 'editor',     name: 'Morgan', role: 'Editorial Fact-Checker', status: 'IDLE' as const, currentTaskId: null },
];

export class BlogStatePublisher extends OrchestratorStatePublisher {
  workflowStarted(topic: string): void {
    this.publish({
      teamWorkflowStatus: 'RUNNING',
      agents: BLOG_AGENTS,
      inputs: { topic },
      metadata: { startTime: Date.now() },
    });
  }

  awaitingHITL(taskId: string, reviewTitle: string, recommendation: string, score: string): void {
    this.publish({
      teamWorkflowStatus: 'RUNNING',
      agents: BLOG_AGENTS,
      tasks: [{
        taskId,
        title: reviewTitle,
        status: 'AWAITING_VALIDATION',
        assignedToAgentId: 'editor',
        result: `Recommendation: ${recommendation} | Score: ${score} — Waiting for human decision`,
      }],
    });
  }

  workflowFinished(
    finalTaskId: string,
    topic: string,
    totalTokens: number,
    estimatedCost: number,
    editTaskId?: string,
  ): void {
    const tasks: Array<Record<string, unknown>> = [
      { taskId: finalTaskId, title: topic.slice(0, 60), status: 'DONE', assignedToAgentId: 'writer', result: 'Published' },
    ];
    if (editTaskId) {
      tasks.push({ taskId: editTaskId, title: 'Editorial Review', status: 'DONE', assignedToAgentId: 'editor', result: 'Approved for publication' });
    }
    this.publish({ teamWorkflowStatus: 'FINISHED', agents: BLOG_AGENTS, tasks, metadata: { totalTokens, estimatedCost, endTime: Date.now() } });
  }

  workflowStopped(
    taskId: string,
    reason: string,
    totalTokens: number,
    estimatedCost: number,
    editTaskId?: string,
  ): void {
    const tasks: Array<Record<string, unknown>> = [
      { taskId, title: 'Workflow ended', status: 'BLOCKED', assignedToAgentId: 'editor', result: reason.slice(0, 200) },
    ];
    if (editTaskId && editTaskId !== taskId) {
      tasks.push({ taskId: editTaskId, title: 'Editorial Review', status: 'BLOCKED', assignedToAgentId: 'editor', result: 'Workflow stopped' });
    }
    this.publish({ teamWorkflowStatus: 'STOPPED', agents: BLOG_AGENTS, tasks, metadata: { totalTokens, estimatedCost, endTime: Date.now() } });
  }
}
