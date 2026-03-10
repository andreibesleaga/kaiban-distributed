import {
  IMessagingDriver,
  MessagePayload,
} from "../../infrastructure/messaging/interfaces";

export class AgentActor {
  private id: string;
  private driver: IMessagingDriver;
  private queueName: string;

  constructor(id: string, driver: IMessagingDriver, queueName: string) {
    this.id = id;
    this.driver = driver;
    this.queueName = queueName;
  }

  public async start(): Promise<void> {
    console.log(
      `[Actor ${this.id}] Starting and subscribing to ${this.queueName}`,
    );
    await this.driver.subscribe(this.queueName, this.processTask.bind(this));
  }

  private async processTask(payload: MessagePayload): Promise<void> {
    console.log(`[Actor ${this.id}] Processing task ${payload.taskId}`);

    // Validate target
    if (payload.agentId !== this.id && payload.agentId !== "*") {
      console.log(
        `[Actor ${this.id}] Ignored task meant for ${payload.agentId}`,
      );
      return;
    }

    try {
      // Simulate KaibanJS task processing delay
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Publish completion event
      await this.driver.publish("kaiban:events:completed", {
        taskId: payload.taskId,
        agentId: this.id,
        timestamp: Date.now(),
        data: {
          status: "success",
          result: `Actor ${this.id} executed successfully`,
        },
      });
      console.log(
        `[Actor ${this.id}] Successfully processed task ${payload.taskId}`,
      );
    } catch (err) {
      console.error(
        `[Actor ${this.id}] Failed processing task ${payload.taskId}:`,
        err,
      );
    }
  }

  public async stop(): Promise<void> {
    console.log(`[Actor ${this.id}] Stopping`);
    // Note: disconnect shuts down the underlying driver for all usage in simple cases.
    // In a production system we'd detach just this actor's subscription.
    await this.driver.disconnect();
  }
}
