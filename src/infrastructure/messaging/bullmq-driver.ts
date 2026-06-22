import { Queue, Worker, QueueOptions, JobsOptions } from "bullmq";
import { context as otelContext } from "@opentelemetry/api";
import { IMessagingDriver, MessagePayload } from "./interfaces";
import {
  injectTraceContext,
  extractTraceContext,
  sanitizeTraceHeaders,
} from "../telemetry/TraceContext";
import type { TlsConfig } from "../../main/config";
import { createStructuredLogger } from "../../shared/structured-logger";

const log = createStructuredLogger({ component: "BullMQDriver" });

/**
 * Job retention (S9): without this, completed/failed jobs accumulate in Redis
 * forever and eventually exhaust memory. Keep completed jobs for 1h (capped at
 * 1000) and failed jobs for 24h so the DLQ stays inspectable but bounded.
 */
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
};

export interface BullMQDriverOptions extends QueueOptions {
  tls?: TlsConfig;
}

export class BullMQDriver implements IMessagingDriver {
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();
  private config: QueueOptions;

  constructor(options: BullMQDriverOptions) {
    const { tls, ...baseConfig } = options;
    // Merge caller-supplied defaultJobOptions over our retention defaults so an
    // explicit override still wins, but retention is never silently dropped.
    const withRetention: QueueOptions = {
      ...baseConfig,
      defaultJobOptions: {
        ...DEFAULT_JOB_OPTIONS,
        ...baseConfig.defaultJobOptions,
      },
    };
    if (tls) {
      this.config = {
        ...withRetention,
        connection: {
          ...(withRetention.connection as Record<string, unknown>),
          tls: {
            ca: tls.ca,
            cert: tls.cert,
            key: tls.key,
            rejectUnauthorized: tls.rejectUnauthorized,
          },
        },
      };
    } else {
      this.config = withRetention;
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
      const worker = new Worker(
        queueName,
        async (job) => {
          // Sanitize possibly-crafted trace headers (incl. malformed traceparent)
          // before extraction — shared with the Kafka driver.
          const ctx = extractTraceContext(
            sanitizeTraceHeaders(job.data.traceHeaders),
          );
          await otelContext.with(ctx, () =>
            handler(job.data as MessagePayload),
          );
        },
        this.config,
      );
      // Surface worker-level failures (Redis drops, processor crashes). Without
      // this listener BullMQ emits an 'error' on an EventEmitter with no
      // handler, which can crash the process (S9).
      worker.on("error", (err: Error) => {
        log.error({ err: err.message, queue: queueName }, "BullMQ worker error");
      });
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
