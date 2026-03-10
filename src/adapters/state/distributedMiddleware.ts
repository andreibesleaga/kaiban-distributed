import {
  IMessagingDriver,
  MessagePayload,
} from "../../infrastructure/messaging/interfaces";

const PII_DENYLIST: ReadonlySet<string> = new Set([
  'email', 'name', 'phone', 'ip', 'password', 'token', 'secret', 'ssn', 'dob',
]);

function sanitizeDelta(partial: unknown): Record<string, unknown> {
  if (partial === null || typeof partial !== 'object') return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(partial as Record<string, unknown>)) {
    if (!PII_DENYLIST.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

interface ZustandStore {
  setState: (partial: Record<string, unknown>, replace?: boolean) => void;
}

export class DistributedStateMiddleware {
  private driver: IMessagingDriver;
  private channelName: string;

  constructor(driver: IMessagingDriver, channelName = 'kaiban-state-events') {
    this.driver = driver;
    this.channelName = channelName;
  }

  public attach(store: ZustandStore): ZustandStore {
    const originalSet = store.setState.bind(store);

    store.setState = async (partial: Record<string, unknown>, replace?: boolean): Promise<void> => {
      originalSet(partial, replace);

      const sanitized = sanitizeDelta(partial);
      const payload: MessagePayload = {
        taskId: "global-state",
        agentId: "system",
        timestamp: Date.now(),
        data: { stateUpdate: sanitized },
      };

      try {
        await this.driver.publish(this.channelName, payload);
      } catch (err) {
        console.error("[DistributedStateMiddleware] Failed to publish state delta:", err);
      }
    };

    return store;
  }

  public async listen(onStateChange: (delta: Record<string, unknown>) => void): Promise<void> {
    await this.driver.subscribe(
      this.channelName,
      async (payload: MessagePayload) => {
        onStateChange(payload.data['stateUpdate'] as Record<string, unknown>);
      },
    );
  }
}
