import { Kafka, Producer, Consumer } from "kafkajs";
import { context as otelContext } from "@opentelemetry/api";
import { IMessagingDriver, MessagePayload } from "./interfaces";
import {
  injectTraceContext,
  extractTraceContext,
  sanitizeTraceHeaders,
} from "../telemetry/TraceContext";
import type { TlsConfig } from "../../main/config";
import { createStructuredLogger } from "../../shared/structured-logger";

const log = createStructuredLogger({ component: "KafkaDriver" });

export interface KafkaDriverConfig {
  brokers: string[];
  clientId: string;
  groupId: string;
  ssl?: TlsConfig;
}

export class KafkaDriver implements IMessagingDriver {
  private producer: Producer;
  private consumer: Consumer;
  private producerConnected = false;
  private consumerConnected = false;
  /**
   * Set once subscribe() has wired this consumer to a topic. KafkaJS forbids a
   * 2nd subscribe()+run() on the same consumer, so a 2nd subscribe() is rejected
   * explicitly (C2) instead of relying on every call site using a fresh driver.
   */
  private subscribedTopic: string | null = null;

  constructor(config: KafkaDriverConfig) {
    const kafka = new Kafka({
      brokers: config.brokers,
      clientId: config.clientId,
      ...(config.ssl
        ? {
            ssl: {
              rejectUnauthorized: config.ssl.rejectUnauthorized,
              ca: [config.ssl.ca.toString()],
              cert: config.ssl.cert.toString(),
              key: config.ssl.key.toString(),
            },
          }
        : {}),
    });
    this.producer = kafka.producer();
    this.consumer = kafka.consumer({ groupId: config.groupId });
  }

  private async ensureProducerConnected(): Promise<void> {
    if (!this.producerConnected) {
      await this.producer.connect();
      this.producerConnected = true;
    }
  }

  private isRetryableError(err: unknown): boolean {
    if (err && typeof err === "object") {
      const e = err as { type?: string; message?: string };
      return (
        e.type === "UNKNOWN_TOPIC_OR_PARTITION" ||
        !!e.message?.includes("does not host this topic-partition") ||
        !!e.message?.includes("KafkaJSProtocolError")
      );
    }
    return false;
  }

  async publish(
    topic: string,
    payload: MessagePayload,
    retries = 5,
  ): Promise<void> {
    await this.ensureProducerConnected();
    const headers: Record<string, string> = {};
    injectTraceContext(headers);
    const enrichedPayload: MessagePayload = {
      ...payload,
      traceHeaders: headers,
    };

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await this.producer.send({
          topic,
          messages: [{ value: JSON.stringify(enrichedPayload) }],
        });
        return;
      } catch (err: unknown) {
        if (this.isRetryableError(err)) {
          if (attempt === retries - 1) throw err;
          await new Promise((resolve) =>
            setTimeout(resolve, Math.pow(2, attempt) * 100),
          );
        } else {
          throw err;
        }
      }
    }
  }

  async subscribe(
    topic: string,
    handler: (payload: MessagePayload) => Promise<void>,
  ): Promise<void> {
    if (this.subscribedTopic !== null) {
      throw new Error(
        "KafkaDriver supports a single topic per driver; create a separate " +
          "driver for additional topics",
      );
    }
    // The single-topic guard above guarantees we only get here on a fresh /
    // unsubscribed consumer (subscribedTopic and consumerConnected are reset
    // together), so the consumer is always disconnected at this point.
    await this.consumer.connect();
    this.consumerConnected = true;
    await this.consumer.subscribe({ topic, fromBeginning: false });
    this.subscribedTopic = topic;
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        let parsed: MessagePayload;
        try {
          parsed = JSON.parse(message.value.toString()) as MessagePayload;
        } catch (err) {
          // Poison / non-JSON message: skip it so the offset advances instead of
          // crash-looping the consumer on the same unparseable record (HOL block).
          log.warn(
            { err: String(err), topic },
            "Skipping unparseable Kafka message",
          );
          return;
        }
        const ctx = extractTraceContext(
          sanitizeTraceHeaders(parsed.traceHeaders),
        );
        await otelContext.with(ctx, () => handler(parsed));
      },
    });
  }

  async unsubscribe(_topic: string): Promise<void> {
    if (this.consumerConnected) {
      await this.consumer.disconnect();
      this.consumerConnected = false;
    }
    this.subscribedTopic = null;
  }

  async disconnect(): Promise<void> {
    if (this.producerConnected) {
      await this.producer.disconnect();
      this.producerConnected = false;
    }
    if (this.consumerConnected) {
      await this.consumer.disconnect();
      this.consumerConnected = false;
    }
    this.subscribedTopic = null;
  }
}
