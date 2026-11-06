import { describe, it, expect } from "vitest";
import { isMessagePayload } from "../../../src/infrastructure/messaging/payload-guard";

const ok = { taskId: "t", agentId: "a", data: {}, timestamp: 1 };

describe("isMessagePayload", () => {
  it("accepts a well-formed payload", () => {
    expect(isMessagePayload(ok)).toBe(true);
    expect(isMessagePayload({ ...ok, traceHeaders: {} })).toBe(true);
  });

  it.each([
    null,
    42,
    "x",
    [],
    {},
    { ...ok, taskId: 1 },
    { ...ok, agentId: undefined },
    { ...ok, data: null },
    { ...ok, data: [] },
    { ...ok, data: "x" },
    { ...ok, timestamp: undefined },
    { ...ok, timestamp: "1" },
    { ...ok, timestamp: Number.NaN },
    { ...ok, timestamp: Infinity },
  ])("rejects %j", (v) => {
    expect(isMessagePayload(v)).toBe(false);
  });
});
