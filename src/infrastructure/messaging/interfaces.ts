export interface MessagePayload {
  taskId: string;
  agentId: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface IMessagingDriver {
  publish(queueName: string, payload: MessagePayload): Promise<void>;
  subscribe(
    queueName: string,
    handler: (payload: MessagePayload) => Promise<void>,
  ): Promise<void>;
  disconnect(): Promise<void>;
}
