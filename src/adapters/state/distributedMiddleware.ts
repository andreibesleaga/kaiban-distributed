import {
  IMessagingDriver,
  MessagePayload,
} from "../../infrastructure/messaging/interfaces";

export class DistributedStateMiddleware {
  private driver: IMessagingDriver;
  private channelName: string;

  constructor(driver: IMessagingDriver, channelName = "kaiban:state:events") {
    this.driver = driver;
    this.channelName = channelName;
  }

  /**
   * Zustand middleware hook that publishes state changes to the MAL.
   * This is intended to tightly wrap the KaibanJS internal store in the future.
   */
  public attach(store: unknown): unknown {
    const originalSet = (store as Record<string, unknown>).setState;

    // Intercept standard Zustand sets
    (store as Record<string, unknown>).setState = async (
      partial: unknown,
      replace?: boolean,
    ): Promise<void> => {
      (
        originalSet as unknown as (
          this: unknown,
          partial: unknown,
          replace?: boolean,
        ) => void
      ).call(store, partial, replace);

      const payload = {
        taskId: "global-state",
        agentId: "system",
        timestamp: Date.now(),
        data: { stateUpdate: partial },
      };

      try {
        await this.driver.publish(this.channelName, payload);
      } catch (err) {
        console.error(
          "[DistributedStateMiddleware] Failed to publish state delta:",
          err,
        );
      }
    };

    return store;
  }

  public async listen(onStateChange: (delta: unknown) => void): Promise<void> {
    await this.driver.subscribe(
      this.channelName,
      async (payload: MessagePayload) => {
        onStateChange(payload.data.stateUpdate);
      },
    );
  }
}
