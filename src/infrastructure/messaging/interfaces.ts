export interface MessagePayload {
  taskId: string;
  agentId: string;
  data: Record<string, unknown>;
  timestamp: number;
  traceHeaders?: Record<string, string>;
}

export interface IMessagingDriver {
  publish(queueName: string, payload: MessagePayload): Promise<void>;
  subscribe(
    queueName: string,
    handler: (payload: MessagePayload) => Promise<void>,
  ): Promise<void>;
  unsubscribe(queueName: string): Promise<void>;
  disconnect(): Promise<void>;
}
