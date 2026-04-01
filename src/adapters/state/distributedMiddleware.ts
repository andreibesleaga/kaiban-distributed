import { Redis } from "ioredis";
import type { MessagePayload } from "../../infrastructure/messaging/interfaces";
import { STATE_CHANNEL } from "../../infrastructure/messaging/channels";

const PII_DENYLIST: ReadonlySet<string> = new Set([
  "email",
  "name",
  "phone",
  "ip",
  "password",
  "token",
  "secret",
  "ssn",
  "dob",
]);

function sanitizeDelta(partial: unknown): Record<string, unknown> {
  if (partial === null || typeof partial !== "object") return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    partial as Record<string, unknown>,
  )) {
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
  private redis: Redis;
  private channelName: string;

  constructor(redisUrl: string, channelName = STATE_CHANNEL) {
    this.redis = new Redis(redisUrl, { lazyConnect: false });
    this.channelName = channelName;
  }

  public attach(store: ZustandStore): ZustandStore {
    const originalSet = store.setState.bind(store);

    store.setState = async (
      partial: Record<string, unknown>,
      replace?: boolean,
    ): Promise<void> => {
      originalSet(partial, replace);

      const sanitized = sanitizeDelta(partial);
      const payload: MessagePayload = {
        taskId: "global-state",
        agentId: "system",
        timestamp: Date.now(),
        data: { stateUpdate: sanitized },
      };

      try {
        await this.redis.publish(this.channelName, JSON.stringify(payload));
      } catch (err) {
        console.error(
          "[DistributedStateMiddleware] Failed to publish state delta:",
          err,
        );
      }
    };

    return store;
  }

  public async listen(
    onStateChange: (delta: Record<string, unknown>) => void,
  ): Promise<void> {
    const sub = new Redis(this.redis.options);
    await sub.subscribe(this.channelName);
    sub.on("message", (channel, message) => {
      if (channel === this.channelName) {
        try {
          const payload = JSON.parse(message) as MessagePayload;
          onStateChange(payload.data["stateUpdate"] as Record<string, unknown>);
        } catch (e) {
          console.error(
            "[DistributedStateMiddleware] Failed to parse message:",
            e,
          );
        }
      }
    });
  }

  public async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}
