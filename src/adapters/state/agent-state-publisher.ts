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
}

const STATE_CHANNEL = 'kaiban-state-events';
const MAX_RESULT_LEN = 800;

export class AgentStatePublisher {
  private redis: Redis;
  private agentInfo: AgentInfo;

  constructor(redisUrl: string, agentInfo: AgentInfo) {
    this.redis = new Redis(redisUrl, { lazyConnect: false });
    this.agentInfo = agentInfo;
  }

  /** Publish a partial state delta — board merges by agentId/taskId */
  private publish(delta: {
    agents?: AgentState[];
    tasks?: TaskState[];
    teamWorkflowStatus?: string;
  }): void {
    this.redis.publish(STATE_CHANNEL, JSON.stringify(delta)).catch((err: unknown) =>
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
    this.publish({
      agents: [{ ...this.agentInfo, status: 'IDLE', currentTaskId: null }],
      teamWorkflowStatus: 'RUNNING',
    });
    // Start heartbeat so late-connecting board viewers see this agent within 15s
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.publish({
        agents: [{ ...this.agentInfo, status: this.currentStatus as 'IDLE' | 'EXECUTING' | 'ERROR', currentTaskId: this.currentTaskId }],
        teamWorkflowStatus: 'RUNNING',
      });
    }, heartbeatIntervalMs);
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

      // → EXECUTING
      this.currentStatus = 'EXECUTING';
      this.currentTaskId = payload.taskId;
      pub({
        agents: [{ agentId, name, role, status: 'EXECUTING', currentTaskId: payload.taskId }],
        tasks: [{ taskId: payload.taskId, title, status: 'DOING', assignedToAgentId: agentId }],
        teamWorkflowStatus: 'RUNNING',
      });

      try {
        const result = await handler(payload);

        // → DONE
        this.currentStatus = 'IDLE';
        this.currentTaskId = null;
        pub({
          agents: [{ agentId, name, role, status: 'IDLE', currentTaskId: null }],
          tasks: [{
            taskId: payload.taskId,
            title,
            status: 'DONE',
            assignedToAgentId: agentId,
            result: String(result ?? '').slice(0, MAX_RESULT_LEN),
          }],
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
