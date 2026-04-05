import { describe, it, expect, vi, beforeEach } from "vitest";
import { CompletionRouter } from "../../../src/shared";
import type {
  IMessagingDriver,
  MessagePayload,
} from "../../../src/infrastructure/messaging/interfaces";

type SubscribeHandler = (payload: MessagePayload) => Promise<void>;

function makeCapturingDriver(): {
  driver: IMessagingDriver;
  getHandler: () => SubscribeHandler | undefined;
} {
  let capturedHandler: SubscribeHandler | undefined;
  const driver: IMessagingDriver = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi
      .fn()
      .mockImplementation((_queue: string, handler: SubscribeHandler) => {
        capturedHandler = handler;
        return Promise.resolve();
      }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return { driver, getHandler: () => capturedHandler };
}

function makeCompletedPayload(taskId: string, result: unknown): MessagePayload {
  return { taskId, agentId: "agent", timestamp: Date.now(), data: { result } };
}

function makeFailedPayload(taskId: string, error: string): MessagePayload {
  return { taskId, agentId: "agent", timestamp: Date.now(), data: { error } };
}

describe("CompletionRouter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes completedDriver to kaiban-events-completed on construction", () => {
    const { driver } = makeCapturingDriver();
    new CompletionRouter(driver);
    expect(driver.subscribe).toHaveBeenCalledWith(
      "kaiban-events-completed",
      expect.any(Function),
    );
  });

  it("subscribes failedDriver to kaiban-events-failed (separate DLQ driver)", () => {
    const { driver: completedDriver } = makeCapturingDriver();
    const failedDriver: IMessagingDriver = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    new CompletionRouter(completedDriver, failedDriver);
    expect(failedDriver.subscribe).toHaveBeenCalledWith(
      "kaiban-events-failed",
      expect.any(Function),
    );
  });

  it("uses same driver for both queues when no failedDriver provided", () => {
    const { driver } = makeCapturingDriver();
    new CompletionRouter(driver);
    expect(driver.subscribe).toHaveBeenCalledTimes(2);
    const queues = (
      driver.subscribe as ReturnType<typeof vi.fn>
    ).mock.calls.map((c: unknown[]) => c[0]) as string[];
    expect(queues).toContain("kaiban-events-completed");
    expect(queues).toContain("kaiban-events-failed");
  });

  it("wait() resolves when completedDriver delivers matching taskId", async () => {
    // Use separate drivers so we can control completion vs failed handlers precisely
    const handlersByQueue = new Map<string, SubscribeHandler>();
    const completedDriver: IMessagingDriver = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi
        .fn()
        .mockImplementation((q: string, h: SubscribeHandler) => {
          handlersByQueue.set(q, h);
          return Promise.resolve();
        }),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const router = new CompletionRouter(completedDriver);
    const promise = router.wait("task-1", 5000, "test");

    await handlersByQueue.get("kaiban-events-completed")!(
      makeCompletedPayload("task-1", "result text"),
    );
    await expect(promise).resolves.toBe("result text");
  });

  it("wait() resolves with JSON.stringify when result is an object", async () => {
    const handlersByQueue = new Map<string, SubscribeHandler>();
    const completedDriver: IMessagingDriver = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi
        .fn()
        .mockImplementation((q: string, h: SubscribeHandler) => {
          handlersByQueue.set(q, h);
          return Promise.resolve();
        }),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const router = new CompletionRouter(completedDriver);
    const promise = router.wait("task-2", 5000, "test");

    await handlersByQueue.get("kaiban-events-completed")!(
      makeCompletedPayload("task-2", { key: "val" }),
    );
    await expect(promise).resolves.toBe('{"key":"val"}');
  });

  it("wait() resolves with empty string when result is null", async () => {
    const handlersByQueue = new Map<string, SubscribeHandler>();
    const completedDriver: IMessagingDriver = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi
        .fn()
        .mockImplementation((q: string, h: SubscribeHandler) => {
          handlersByQueue.set(q, h);
          return Promise.resolve();
        }),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const router = new CompletionRouter(completedDriver);
    const promise = router.wait("task-null", 5000, "test");

    await handlersByQueue.get("kaiban-events-completed")!(
      makeCompletedPayload("task-null", null),
    );
    await expect(promise).resolves.toBe('""');
  });

  it("wait() rejects when failedDriver delivers matching taskId", async () => {
    let failedHandler: SubscribeHandler | undefined;
    const completedDriver: IMessagingDriver = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const failedDriverObj: IMessagingDriver = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi
        .fn()
        .mockImplementation((_q: string, h: SubscribeHandler) => {
          failedHandler = h;
          return Promise.resolve();
        }),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const router = new CompletionRouter(completedDriver, failedDriverObj);
    const promise = router.wait("task-fail", 5000, "test");

    await failedHandler!(makeFailedPayload("task-fail", "LLM timeout"));
    await expect(promise).rejects.toThrow("Agent failed: LLM timeout");
  });

  it("wait() rejects with default message when error field is missing", async () => {
    let failedHandler: SubscribeHandler | undefined;
    const completedDriver: IMessagingDriver = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const failedDriverObj: IMessagingDriver = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi
        .fn()
        .mockImplementation((_q: string, h: SubscribeHandler) => {
          failedHandler = h;
          return Promise.resolve();
        }),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const router = new CompletionRouter(completedDriver, failedDriverObj);
    const promise = router.wait("task-no-err", 5000, "test");

    // Payload with no error field
    await failedHandler!({
      taskId: "task-no-err",
      agentId: "agent",
      timestamp: Date.now(),
      data: {},
    });
    await expect(promise).rejects.toThrow(
      "Agent failed: Task failed after max retries",
    );
  });

  it("wait() rejects with timeout error when timer fires before message", async () => {
    const { driver } = makeCapturingDriver();
    const router = new CompletionRouter(driver);
    const promise = router.wait("task-timeout", 3000, "research");

    // Advance time past timeout
    vi.advanceTimersByTime(3001);
    await expect(promise).rejects.toThrow("Timeout waiting for research (3s)");
  });

  it("wait() does not double-reject if timer fires after already resolved", async () => {
    const handlersByQueue = new Map<string, SubscribeHandler>();
    const completedDriver: IMessagingDriver = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi
        .fn()
        .mockImplementation((q: string, h: SubscribeHandler) => {
          handlersByQueue.set(q, h);
          return Promise.resolve();
        }),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const router = new CompletionRouter(completedDriver);
    const promise = router.wait("task-dbl", 5000, "test");

    // Resolve first
    await handlersByQueue.get("kaiban-events-completed")!(
      makeCompletedPayload("task-dbl", "result"),
    );
    // Then advance timer — should not throw
    vi.advanceTimersByTime(6000);
    await expect(promise).resolves.toBe("result");
  });

  it("ignores messages for unknown taskIds", async () => {
    const handlersByQueue = new Map<string, SubscribeHandler>();
    const completedDriver: IMessagingDriver = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi
        .fn()
        .mockImplementation((q: string, h: SubscribeHandler) => {
          handlersByQueue.set(q, h);
          return Promise.resolve();
        }),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const router = new CompletionRouter(completedDriver);
    const promise = router.wait("task-known", 5000, "test");

    // Deliver message for unknown task — should not affect known task
    await handlersByQueue.get("kaiban-events-completed")!(
      makeCompletedPayload("unknown-task", "irrelevant"),
    );

    // Still pending — advance to timeout
    vi.advanceTimersByTime(5001);
    await expect(promise).rejects.toThrow("Timeout");
  });

  it("waitAll() aggregates results from multiple tasks", async () => {
    const handlersByQueue = new Map<string, SubscribeHandler>();
    const completedDriver: IMessagingDriver = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi
        .fn()
        .mockImplementation((q: string, h: SubscribeHandler) => {
          handlersByQueue.set(q, h);
          return Promise.resolve();
        }),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const router = new CompletionRouter(completedDriver);
    const taskIds = ["t1", "t2", "t3"];
    const allPromise = router.waitAll(taskIds, 5000, "search");

    // Deliver results for all 3
    await handlersByQueue.get("kaiban-events-completed")!(
      makeCompletedPayload("t1", "result-1"),
    );
    await handlersByQueue.get("kaiban-events-completed")!(
      makeCompletedPayload("t2", "result-2"),
    );
    await handlersByQueue.get("kaiban-events-completed")!(
      makeCompletedPayload("t3", "result-3"),
    );

    const results = await allPromise;
    expect(results).toHaveLength(3);
    expect(results.find((r) => r.taskId === "t1")?.result).toBe("result-1");
    expect(results.find((r) => r.taskId === "t2")?.result).toBe("result-2");
    expect(results.find((r) => r.taskId === "t3")?.result).toBe("result-3");
  });

  it("silently ignores failed message for unknown taskId (no pending reject)", async () => {
    let failedHandler: SubscribeHandler | undefined;
    const completedDriver: IMessagingDriver = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const failedDriverObj: IMessagingDriver = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi
        .fn()
        .mockImplementation((_q: string, h: SubscribeHandler) => {
          failedHandler = h;
          return Promise.resolve();
        }),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const router = new CompletionRouter(completedDriver, failedDriverObj);
    const promise = router.wait("task-real", 5000, "test");

    // Deliver failed message for a taskId nobody is waiting for
    await failedHandler!(makeFailedPayload("completely-unknown-task", "oops"));

    // The real task should remain pending and resolve normally via timeout
    vi.advanceTimersByTime(5001);
    await expect(promise).rejects.toThrow("Timeout");
  });

  it("waitAll() includes error entry for timed-out tasks without rejecting", async () => {
    const { driver } = makeCapturingDriver();
    const router = new CompletionRouter(driver);
    const allPromise = router.waitAll(["slow-task"], 2000, "search");

    vi.advanceTimersByTime(2001);
    const results = await allPromise;
    expect(results).toHaveLength(1);
    expect(results[0]?.error).toContain("Timeout");
    expect(results[0]?.result).toBeUndefined();
  });
});
