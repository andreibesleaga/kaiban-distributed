import { describe, it, expect, vi } from "vitest";
import { DistributedStateMiddleware } from "../../../src/adapters/state/distributedMiddleware";
import { IMessagingDriver } from "../../../src/infrastructure/messaging/interfaces";

describe("DistributedStateMiddleware", () => {
  it("intercepts setState and publishes to the underlying driver", async () => {
    const mockDriver: IMessagingDriver = {
      publish: vi.fn(),
      subscribe: vi.fn(),
      disconnect: vi.fn(),
    };

    const middleware = new DistributedStateMiddleware(mockDriver);

    const mockStore = {
      state: { count: 0 },
      setState: function (
        this: { state: { count: number } },
        partial: { count: number },
      ): void {
        this.state = { ...this.state, ...partial };
      },
    };

    middleware.attach(mockStore);

    // Trigger state change
    await mockStore.setState({ count: 1 });

    expect(mockStore.state.count).toBe(1);
    expect(mockDriver.publish).toHaveBeenCalledWith(
      "kaiban:state:events",
      expect.objectContaining({
        data: { stateUpdate: { count: 1 } },
      }),
    );
  });
});
