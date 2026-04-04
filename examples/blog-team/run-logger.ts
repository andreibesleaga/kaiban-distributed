/**
 * Blog Team Run Logger
 *
 * Wraps the shared console logger and accumulates a structured JSON record of
 * every step in the blog pipeline (system info, per-task tokens/cost/answer,
 * errors and the final outcome). Flushed to `runs/` at the end of each run.
 *
 * JSON schema mirrors the news-debaters transcript pattern so tooling that
 * reads those files can be reused here.
 */
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { createLogger } from '../../src/shared';

export const log = createLogger('BlogTeam');

export interface TaskEntry {
  phase: string;
  taskId: string;
  agentId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  answer?: string;
  timestamp: string;
}

export interface ErrorEntry {
  phase: string;
  taskId: string;
  agentId: string;
  error: string;
  timestamp: string;
}

export interface BlogRunLog {
  capturedAt: string;
  topic: string;
  gatewayUrl: string;
  driverType: string;
  tasks: TaskEntry[];
  errors: ErrorEntry[];
  outcome?: 'PUBLISHED' | 'REVISED' | 'REJECTED' | 'STOPPED' | 'FAILED';
  totalTokens: number;
  totalCost: number;
  durationMs?: number;
  startTime: number;
  endTime?: number;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export class RunLogger {
  private readonly record: BlogRunLog;

  constructor(topic: string, gatewayUrl: string, driverType: string) {
    this.record = {
      capturedAt: new Date().toISOString(),
      topic,
      gatewayUrl,
      driverType,
      tasks: [],
      errors: [],
      totalTokens: 0,
      totalCost: 0,
      startTime: Date.now(),
    };
  }

  logTask(
    phase: string,
    taskId: string,
    agentId: string,
    parsed: { inputTokens: number; outputTokens: number; estimatedCost: number; answer?: string },
  ): void {
    this.record.tasks.push({
      phase,
      taskId,
      agentId,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      estimatedCost: parsed.estimatedCost,
      answer: parsed.answer?.slice(0, 2000),
      timestamp: new Date().toISOString(),
    });
    this.record.totalTokens += parsed.inputTokens + parsed.outputTokens;
    this.record.totalCost   += parsed.estimatedCost;
  }

  logError(phase: string, taskId: string, agentId: string, error: string): void {
    this.record.errors.push({ phase, taskId, agentId, error, timestamp: new Date().toISOString() });
  }

  get totals(): { totalTokens: number; totalCost: number } {
    return { totalTokens: this.record.totalTokens, totalCost: this.record.totalCost };
  }

  finish(outcome: BlogRunLog['outcome']): void {
    this.record.outcome  = outcome;
    this.record.endTime  = Date.now();
    this.record.durationMs = this.record.endTime - this.record.startTime;
  }

  async flush(dir: string): Promise<string> {
    const target = path.resolve(
      process.cwd(),
      dir,
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${slugify(this.record.topic || 'blog-run')}.json`,
    );
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(this.record, null, 2));
    return target;
  }
}
