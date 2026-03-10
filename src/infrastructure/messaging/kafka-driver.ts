import { IMessagingDriver, MessagePayload } from "./interfaces";

export class KafkaDriver implements IMessagingDriver {
  constructor() {}

  async publish(queueName: string, payload: MessagePayload): Promise<void> {
    console.log(`[Kafka] Publishing to ${queueName}:`, payload);
  }

  async subscribe(queueName: string): Promise<void> {
    console.log(`[Kafka] Subscribed to ${queueName}`);
  }

  async disconnect(): Promise<void> {
    console.log("[Kafka] Disconnected");
  }
}
