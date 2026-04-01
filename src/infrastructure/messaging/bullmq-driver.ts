import { Queue, Worker, QueueOptions } from "bullmq";
import { context as otelContext } from "@opentelemetry/api";
import { IMessagingDriver, MessagePayload } from "./interfaces";
import {
  injectTraceContext,
  extractTraceContext,
} from "../telemetry/TraceContext";
import type { TlsConfig } from "../../main/config";

export interface BullMQDriverOptions extends QueueOptions {
  tls?: TlsConfig;
}

export class BullMQDriver implements IMessagingDriver {
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();
  private config: QueueOptions;

  constructor(options: BullMQDriverOptions) {
    const { tls, ...baseConfig } = options;
    if (tls) {
      this.config = {
        ...baseConfig,
        connection: {
          ...(baseConfig.connection as Record<string, unknown>),
          tls: {
            ca: tls.ca,
            cert: tls.cert,
            key: tls.key,
            rejectUnauthorized: tls.rejectUnauthorized,
          },
        },
      };
    } else {
      this.config = baseConfig;
    }
  }

  async publish(queueName: string, payload: MessagePayload): Promise<void> {
    if (!this.queues.has(queueName)) {
      this.queues.set(queueName, new Queue(queueName, this.config));
    }
    const queue = this.queues.get(queueName)!;
    const headers: Record<string, string> = {};
    injectTraceContext(headers);
    const enrichedPayload: MessagePayload = {
      ...payload,
      traceHeaders: headers,
    };
    await queue.add(payload.taskId, enrichedPayload);
  }

  async subscribe(
    queueName: string,
    handler: (payload: MessagePayload) => Promise<void>,
  ): Promise<void> {
    if (!this.workers.has(queueName)) {
      // Validate W3C traceparent format before passing to extractTraceContext.
      // Prevents crafted job payloads from injecting malformed trace headers.
      const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
      const worker = new Worker(
        queueName,
        async (job) => {
          const rawHeaders =
            typeof job.data.traceHeaders === "object" &&
            job.data.traceHeaders !== null
              ? (job.data.traceHeaders as Record<string, unknown>)
              : {};
          const safeHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(rawHeaders)) {
            if (typeof k === "string" && typeof v === "string") {
              if (k === "traceparent" && !TRACEPARENT_RE.test(v)) continue;
              safeHeaders[k] = v;
            }
          }
          const ctx = extractTraceContext(safeHeaders);
          await otelContext.with(ctx, () =>
            handler(job.data as MessagePayload),
          );
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
