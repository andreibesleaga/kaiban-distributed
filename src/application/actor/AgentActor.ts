import { createHash } from 'crypto';
import {
  IMessagingDriver,
  MessagePayload,
} from "../../infrastructure/messaging/interfaces";
import type { ISemanticFirewall } from '../../domain/security/semantic-firewall';
import type { ICircuitBreaker } from '../../domain/security/circuit-breaker';

export type TaskHandler = (payload: MessagePayload) => Promise<unknown>;

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 100;
const DLQ_CHANNEL = 'kaiban-events-failed';
const COMPLETED_CHANNEL = 'kaiban-events-completed';
const MAX_PUBLISH_DATA_LEN = 65_536; // 64 KB — cap outbound message data

function sanitizeId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 8);
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Truncate data values so published messages stay under MAX_PUBLISH_DATA_LEN */
function capDataSize(data: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(data);
  if (json.length <= MAX_PUBLISH_DATA_LEN) return data;
  return { ...data, result: String(data['result'] ?? '').slice(0, MAX_PUBLISH_DATA_LEN), _truncated: true };
}

export interface AgentActorDeps {
  firewall?: ISemanticFirewall;
  circuitBreaker?: ICircuitBreaker;
}

export class AgentActor {
  private id: string;
  private driver: IMessagingDriver;
  private queueName: string;
  private taskHandler?: TaskHandler;
  private firewall?: ISemanticFirewall;
  private circuitBreaker?: ICircuitBreaker;

  constructor(
    id: string,
    driver: IMessagingDriver,
    queueName: string,
    taskHandler?: TaskHandler,
    deps?: AgentActorDeps,
  ) {
    this.id = id;
    this.driver = driver;
    this.queueName = queueName;
    this.taskHandler = taskHandler;
    this.firewall = deps?.firewall;
    this.circuitBreaker = deps?.circuitBreaker;
  }

  public async start(): Promise<void> {
    if (!this.taskHandler) {
      console.warn(`[Actor ${sanitizeId(this.id)}] No taskHandler provided — received messages will be silently dropped`);
    }
    console.log(`[Actor ${sanitizeId(this.id)}] Starting on queue ${this.queueName}`);
    await this.driver.subscribe(this.queueName, this.processTask.bind(this));
  }

  private async processTask(payload: MessagePayload): Promise<void> {
    if (payload.agentId !== this.id && payload.agentId !== '*') {
      console.log(`[Actor ${sanitizeId(this.id)}] Ignored task for different agent`);
      return;
    }

    if (await this.isBlockedByGuards(payload)) return;

    await this.executeWithRetries(payload);
  }

  private async isBlockedByGuards(payload: MessagePayload): Promise<boolean> {
    if (this.circuitBreaker?.isOpen()) {
      console.warn(`[Actor ${sanitizeId(this.id)}] Circuit breaker OPEN — rejecting task`);
      await this.publishToDlq(payload, 'circuit_breaker_open');
      return true;
    }

    if (this.firewall) {
      const verdict = await this.firewall.evaluate(payload);
      if (!verdict.allowed) {
        console.warn(`[Actor ${sanitizeId(this.id)}] Blocked by firewall: ${verdict.reason}`);
        await this.publishToDlq(payload, 'blocked_by_semantic_firewall', verdict.reason);
        return true;
      }
    }

    return false;
  }

  private async executeWithRetries(payload: MessagePayload): Promise<void> {
    let lastError = 'Max retries exceeded';
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        const taskResult = await this.executeTask(payload);
        this.circuitBreaker?.recordSuccess();
        await this.driver.publish(COMPLETED_CHANNEL, {
          taskId: payload.taskId,
          agentId: this.id,
          timestamp: Date.now(),
          data: capDataSize({ status: 'success', result: taskResult ?? `Actor ${sanitizeId(this.id)} executed successfully` }),
        });
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error(`[Actor ${sanitizeId(this.id)}] Attempt ${attempt} failed: ${lastError}`);
        if (attempt < RETRY_ATTEMPTS) {
          await delay(RETRY_BASE_DELAY_MS * attempt);
        }
      }
    }

    this.circuitBreaker?.recordFailure();
    await this.publishToDlq(payload, lastError);
  }

  private async publishToDlq(payload: MessagePayload, error: string, reason?: string): Promise<void> {
    await this.driver.publish(DLQ_CHANNEL, {
      taskId: payload.taskId,
      agentId: this.id,
      timestamp: Date.now(),
      data: capDataSize({ status: 'failed', error, ...(reason ? { reason } : {}) }),
    });
  }

  private async executeTask(payload: MessagePayload): Promise<unknown> {
    if (this.taskHandler) {
      return this.taskHandler(payload);
    }
    await delay(50);
    return null;
  }

  public async stop(): Promise<void> {
    console.log(`[Actor ${sanitizeId(this.id)}] Stopping`);
    await this.driver.unsubscribe(this.queueName);
  }
}
