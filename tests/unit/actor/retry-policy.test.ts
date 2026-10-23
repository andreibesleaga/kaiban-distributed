import { describe, it, expect } from "vitest";
import {
  RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  TASK_WAIT_MARGIN_MS,
  taskWaitMs,
} from "../../../src/application/actor/retry-policy";

describe("taskWaitMs", () => {
  it("is one attempt when retry-on-timeout is off", () => {
    expect(taskWaitMs(300_000, false)).toBe(300_000);
  });

  it("is every attempt plus the linear back-off between them plus a margin when on", () => {
    expect(RETRY_ATTEMPTS).toBe(3);
    expect(taskWaitMs(1000, true)).toBe(
      3 * 1000 +
        RETRY_BASE_DELAY_MS * 1 +
        RETRY_BASE_DELAY_MS * 2 +
        TASK_WAIT_MARGIN_MS,
    );
  });
});
