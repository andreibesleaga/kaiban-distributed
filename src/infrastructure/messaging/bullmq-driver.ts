import { Queue, Worker, QueueOptions } from "bullmq";
import { IMessagingDriver, MessagePayload } from "./interfaces";

export class BullMQDriver implements IMessagingDriver {
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();
  private config: QueueOptions;

  constructor(config: QueueOptions) {
    this.config = config;
  }

  async publish(queueName: string, payload: MessagePayload): Promise<void> {
    if (!this.queues.has(queueName)) {
      this.queues.set(queueName, new Queue(queueName, this.config));
    }
    const queue = this.queues.get(queueName)!;
    await queue.add(payload.taskId, payload);
  }

  async subscribe(
    queueName: string,
    handler: (payload: MessagePayload) => Promise<void>,
  ): Promise<void> {
    if (!this.workers.has(queueName)) {
      const worker = new Worker(
        queueName,
        async (job) => {
          await handler(job.data);
        },
        this.config,
      );
      this.workers.set(queueName, worker);
    }
  }

  async disconnect(): Promise<void> {
    const queuePromises = Array.from(this.queues.values()).map((q) =>
      q.close(),
    );
    const workerPromises = Array.from(this.workers.values()).map((w) =>
      w.close(),
    );
    await Promise.all([...queuePromises, ...workerPromises]);
    this.queues.clear();
    this.workers.clear();
  }
}
