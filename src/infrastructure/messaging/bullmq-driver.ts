import { Queue, Worker, QueueOptions } from "bullmq";
import { context as otelContext } from "@opentelemetry/api";
import { IMessagingDriver, MessagePayload } from "./interfaces";
import { injectTraceContext, extractTraceContext } from "../telemetry/TraceContext";

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
    const headers: Record<string, string> = {};
    injectTraceContext(headers);
    const enrichedPayload: MessagePayload = { ...payload, traceHeaders: headers };
    await queue.add(payload.taskId, enrichedPayload);
  }

  async subscribe(
    queueName: string,
    handler: (payload: MessagePayload) => Promise<void>,
  ): Promise<void> {
    if (!this.workers.has(queueName)) {
      const worker = new Worker(
        queueName,
        async (job) => {
          const ctx = extractTraceContext(job.data.traceHeaders ?? {});
          await otelContext.with(ctx, () => handler(job.data as MessagePayload));
        },
        this.config,
      );
      this.workers.set(queueName, worker);
    }
  }

  async unsubscribe(queueName: string): Promise<void> {
    const worker = this.workers.get(queueName);
    if (worker) {
      await worker.close();
      this.workers.delete(queueName);
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
