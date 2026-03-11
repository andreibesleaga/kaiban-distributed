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

  async publish(topic: string, payload: MessagePayload): Promise<void> {
    if (!this.producerConnected) {
      await this.producer.connect();
      this.producerConnected = true;
    }
    const headers: Record<string, string> = {};
    injectTraceContext(headers);
    const enrichedPayload: MessagePayload = { ...payload, traceHeaders: headers };
    await this.producer.send({
      topic,
      messages: [{ value: JSON.stringify(enrichedPayload) }],
    });
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
