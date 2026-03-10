import { createHash } from 'crypto';
import {
  IMessagingDriver,
  MessagePayload,
} from "../../infrastructure/messaging/interfaces";

export type TaskHandler = (payload: MessagePayload) => Promise<unknown>;

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 100;
const DLQ_CHANNEL = 'kaiban-events-failed';
const COMPLETED_CHANNEL = 'kaiban-events-completed';

function sanitizeId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 8);
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AgentActor {
  private id: string;
  private driver: IMessagingDriver;
  private queueName: string;
  private taskHandler?: TaskHandler;

  constructor(
    id: string,
    driver: IMessagingDriver,
    queueName: string,
    taskHandler?: TaskHandler,
  ) {
    this.id = id;
    this.driver = driver;
    this.queueName = queueName;
    this.taskHandler = taskHandler;
  }

  public async start(): Promise<void> {
    console.log(`[Actor ${sanitizeId(this.id)}] Starting on queue ${this.queueName}`);
    await this.driver.subscribe(this.queueName, this.processTask.bind(this));
  }

  private async processTask(payload: MessagePayload): Promise<void> {
    if (payload.agentId !== this.id && payload.agentId !== '*') {
      console.log(`[Actor ${sanitizeId(this.id)}] Ignored task for different agent`);
      return;
    }

    let lastError = 'Max retries exceeded';
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        const taskResult = await this.executeTask(payload);
        await this.driver.publish(COMPLETED_CHANNEL, {
          taskId: payload.taskId,
          agentId: this.id,
          timestamp: Date.now(),
          data: { status: 'success', result: taskResult ?? `Actor ${sanitizeId(this.id)} executed successfully` },
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

    await this.driver.publish(DLQ_CHANNEL, {
      taskId: payload.taskId,
      agentId: this.id,
      timestamp: Date.now(),
      data: { status: 'failed', error: lastError },
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
