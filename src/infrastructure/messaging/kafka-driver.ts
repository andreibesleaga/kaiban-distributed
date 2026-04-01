import { Kafka, Producer, Consumer } from 'kafkajs';
import { context as otelContext } from "@opentelemetry/api";
import { IMessagingDriver, MessagePayload } from './interfaces';
import { injectTraceContext, extractTraceContext } from '../telemetry/TraceContext';
import type { TlsConfig } from '../../main/config';

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

  constructor(config: KafkaDriverConfig) {
    const kafka = new Kafka({
      brokers: config.brokers,
      clientId: config.clientId,
      ...(config.ssl ? {
        ssl: {
          rejectUnauthorized: config.ssl.rejectUnauthorized,
          ca: [config.ssl.ca.toString()],
          cert: config.ssl.cert.toString(),
          key: config.ssl.key.toString(),
        },
      } : {}),
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
    if (err && typeof err === 'object') {
      const e = err as { type?: string; message?: string };
      return e.type === 'UNKNOWN_TOPIC_OR_PARTITION' ||
             !!e.message?.includes('does not host this topic-partition') ||
             !!e.message?.includes('KafkaJSProtocolError');
    }
    return false;
  }

  async publish(topic: string, payload: MessagePayload, retries = 5): Promise<void> {
    await this.ensureProducerConnected();
    const headers: Record<string, string> = {};
    injectTraceContext(headers);
    const enrichedPayload: MessagePayload = { ...payload, traceHeaders: headers };
    
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
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
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
    if (!this.consumerConnected) {
      await this.consumer.connect();
      this.consumerConnected = true;
    }
    await this.consumer.subscribe({ topic, fromBeginning: false });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        const parsed = JSON.parse(message.value.toString()) as MessagePayload;
        const ctx = extractTraceContext(parsed.traceHeaders ?? {});
        await otelContext.with(ctx, () => handler(parsed));
      },
    });
  }

   
  async unsubscribe(_topic: string): Promise<void> {
    if (this.consumerConnected) {
      await this.consumer.disconnect();
      this.consumerConnected = false;
    }
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
  }
}
