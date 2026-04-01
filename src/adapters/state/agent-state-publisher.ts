/**
 * AgentStatePublisher — publishes agent and task state directly to Redis Pub/Sub.
 *
 * Bypasses BullMQ (which is for task queues) and writes to the same channel that
 * SocketGateway reads: 'kaiban-state-events'. The board receives these via Socket.io.
 *
 * Each worker node creates one publisher, registers its agent, and wraps its task
 * handler so the board sees IDLE → EXECUTING → DONE transitions in real-time.
 */
import { Redis } from 'ioredis';
import type { MessagePayload } from '../../infrastructure/messaging/interfaces';
import { STATE_CHANNEL } from '../../infrastructure/messaging/channels';
import { wrapSigned } from '../../infrastructure/security/channel-signing';

export interface AgentInfo {
  agentId: string;
  name: string;
  role: string;
}

interface AgentState extends AgentInfo {
  status: 'IDLE' | 'THINKING' | 'EXECUTING' | 'ERROR';
  currentTaskId: string | null;
}

interface TaskState {
  taskId: string;
  title: string;
  status: 'TODO' | 'DOING' | 'DONE' | 'BLOCKED' | 'AWAITING_VALIDATION';
  assignedToAgentId: string;
  result?: string;
  tokens?: number;
  cost?: number;
}


// 20 KB — large enough for a full blog post (typically 3–6 KB), still bounds message size
const MAX_RESULT_LEN = 20_000;

export interface AgentStatePublisherOpts {
  /** Max cumulative tokens before the publisher throws BudgetExceededError. 0 = unlimited. */
  maxTokenBudget?: number;
}

export class AgentStatePublisher {
  private redis: Redis;
  private agentInfo: AgentInfo;
  private totalTokensUsed = 0;
  private readonly maxTokenBudget: number;

  constructor(redisUrl: string, agentInfo: AgentInfo, opts?: AgentStatePublisherOpts) {
    this.redis = new Redis(redisUrl, { lazyConnect: false });
    this.agentInfo = agentInfo;
    this.maxTokenBudget = opts?.maxTokenBudget ?? 0;
  }

  /** Publish a partial state delta — board merges by agentId/taskId */
  private publish(delta: {
    agents?: AgentState[];
    tasks?: TaskState[];
    teamWorkflowStatus?: string;
  }): void {
    this.redis.publish(STATE_CHANNEL, wrapSigned(delta as Record<string, unknown>)).catch((err: unknown) =>
      console.error('[StatePublisher] Failed to publish:', err),
    );
  }

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private currentStatus: string = 'IDLE';
  private currentTaskId: string | null = null;

  /**
   * Call on node startup — board shows IDLE immediately.
   * Starts a periodic heartbeat so late-connecting boards/monitors see current state
   * within HEARTBEAT_INTERVAL_MS even if they missed the initial publish.
   */
  publishIdle(heartbeatIntervalMs = 15000): void {
    this.currentStatus = 'IDLE';
    this.currentTaskId = null;
    // publishIdle: only agent state — orchestrator controls teamWorkflowStatus
    this.publish({
      agents: [{ ...this.agentInfo, status: 'IDLE', currentTaskId: null }],
    });
    // Start heartbeat so late-connecting board viewers see this agent within 15s
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      // Heartbeat: only agent state — orchestrator controls teamWorkflowStatus
      this.publish({
        agents: [{ ...this.agentInfo, status: this.currentStatus as 'IDLE' | 'EXECUTING' | 'ERROR', currentTaskId: this.currentTaskId }],
      });
    }, heartbeatIntervalMs);
  }

  private formatDisplayResult(result: unknown): string {
    const kaibanResult = result !== null && typeof result === 'object'
      ? (result as Record<string, unknown>)
      : null;
    const displayResult = kaibanResult && 'answer' in kaibanResult
      ? String(kaibanResult['answer'] ?? '')
      : result;

    if (displayResult == null) return '';
    return (typeof displayResult === 'string' ? displayResult : JSON.stringify(displayResult)).slice(0, MAX_RESULT_LEN);
  }

  private extractTokenMetadata(result: unknown): { totalTokens: number; estimatedCost: number } | undefined {
    if (result !== null && typeof result === 'object') {
      const kaibanResult = result as Record<string, unknown>;
      if ('inputTokens' in kaibanResult && 'outputTokens' in kaibanResult) {
        return {
          totalTokens: Number(kaibanResult['inputTokens'] ?? 0) + Number(kaibanResult['outputTokens'] ?? 0),
          estimatedCost: Number(kaibanResult['estimatedCost'] ?? 0),
        };
      }
    }
    return undefined;
  }

  /**
   * Wraps a task handler to publish EXECUTING → DONE/ERROR state transitions.
   * The original handler's return value (LLM result) is preserved.
   */
  wrapHandler(
    handler: (payload: MessagePayload) => Promise<unknown>,
  ): (payload: MessagePayload) => Promise<unknown> {
    const { agentId, name, role } = this.agentInfo;
    const pub = (d: Parameters<AgentStatePublisher['publish']>[0]): void => this.publish(d);

    return async (payload: MessagePayload): Promise<unknown> => {
      const title = String(payload.data['instruction'] ?? payload.taskId).slice(0, 60);

      // → EXECUTING (task queued / starting)
      this.currentStatus = 'EXECUTING';
      this.currentTaskId = payload.taskId;
      pub({
        agents: [{ agentId, name, role, status: 'EXECUTING', currentTaskId: payload.taskId }],
        tasks: [{ taskId: payload.taskId, title, status: 'DOING', assignedToAgentId: agentId }],
      });

      // → THINKING (LLM call in progress)
      pub({
        agents: [{ agentId, name, role, status: 'THINKING', currentTaskId: payload.taskId }],
      });

      try {
        const result = await handler(payload);

        // → DONE
        this.currentStatus = 'IDLE';
        this.currentTaskId = null;
        const resultStr = this.formatDisplayResult(result);
        const tokenMeta = this.extractTokenMetadata(result);

        // Token budget check
        if (tokenMeta) {
          this.totalTokensUsed += tokenMeta.totalTokens;
          if (this.maxTokenBudget > 0 && this.totalTokensUsed >= this.maxTokenBudget) {
            pub({
              agents: [{ agentId, name, role, status: 'ERROR', currentTaskId: payload.taskId }],
              tasks: [{ taskId: payload.taskId, title, status: 'BLOCKED', assignedToAgentId: agentId }],
            });
            throw new Error(`Token budget exceeded: ${this.totalTokensUsed} >= ${this.maxTokenBudget}`);
          }
        }

        pub({
          agents: [{ agentId, name, role, status: 'IDLE', currentTaskId: null }],
          tasks: [{
            taskId: payload.taskId,
            title,
            status: 'DONE',
            assignedToAgentId: agentId,
            result: resultStr,
            ...(tokenMeta ? { tokens: tokenMeta.totalTokens, cost: tokenMeta.estimatedCost } : {}),
          }],
          ...(tokenMeta ? { metadata: tokenMeta } : {}),
        });

        return result;
      } catch (err) {
        // → ERROR
        this.currentStatus = 'ERROR';
        pub({
          agents: [{ agentId, name, role, status: 'ERROR', currentTaskId: payload.taskId }],
          tasks: [{ taskId: payload.taskId, title, status: 'BLOCKED', assignedToAgentId: agentId }],
        });
        throw err;
      }
    };
  }

  async disconnect(): Promise<void> {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    await this.redis.quit();
  }
}
