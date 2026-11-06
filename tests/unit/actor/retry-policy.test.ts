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

describe("taskWaitMs timer limit", () => {
  it("never exceeds Node's 2 147 483 647 ms timer limit (a larger wait fires after 1 ms)", () => {
    expect(taskWaitMs(1_000_000_000, true)).toBe(2_147_483_647);
    expect(taskWaitMs(2_147_483_647, false)).toBe(2_147_483_647);
  });
});
