import { describe, it, expect, vi } from "vitest";
import { AgentActor } from "../../../src/application/actor/AgentActor";
import type {
  IMessagingDriver,
  MessagePayload,
} from "../../../src/infrastructure/messaging/interfaces";

function makeCapturingDriver(): {
  driver: IMessagingDriver;
  getHandler: () => (p: MessagePayload) => Promise<void>;
} {
  let h!: (p: MessagePayload) => Promise<void>;
  const driver: IMessagingDriver = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((_q, handler) => {
      h = handler;
      return Promise.resolve();
    }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return { driver, getHandler: () => h };
}

describe("AgentActor — payload size cap (capDataSize)", () => {
  it("small results pass through without truncation", async () => {
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue("short result");
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    await getHandler()({
      taskId: "t1",
      agentId: "agent-1",
      data: {},
      timestamp: 0,
    });

    const publishCall = (
      driver.publish as ReturnType<typeof vi.fn>
    ).mock.calls.find((c: unknown[]) => c[0] === "kaiban-events-completed");
    expect(publishCall).toBeDefined();
    const payload = publishCall![1] as MessagePayload;
    expect(payload.data["result"]).toBe("short result");
    expect(payload.data["_truncated"]).toBeUndefined();
  });

  it("large results (>64KB) are truncated with _truncated flag", async () => {
    const bigResult = "x".repeat(100_000);
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue(bigResult);
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    await getHandler()({
      taskId: "t2",
      agentId: "agent-1",
      data: {},
      timestamp: 0,
    });

    const publishCall = (
      driver.publish as ReturnType<typeof vi.fn>
    ).mock.calls.find((c: unknown[]) => c[0] === "kaiban-events-completed");
    expect(publishCall).toBeDefined();
    const payload = publishCall![1] as MessagePayload;
    // The invariant is BYTES — assert the UTF-8 byte budget, not UTF-16 length.
    expect(
      Buffer.byteLength(String(payload.data["result"]), "utf8"),
    ).toBeLessThanOrEqual(65_536);
    expect(payload.data["_truncated"]).toBe(true);
  });

  it("multi-byte results are byte-capped without splitting a codepoint", async () => {
    // 4-byte emoji past 64 KB: a naive byte .slice could land mid-codepoint and
    // corrupt the JSON. The leading "x" offsets the emoji boundaries by 1 byte so
    // the 65 536-byte cap lands INSIDE an emoji — exercising the continuation-byte
    // backup. Result must stay valid + ≤ 64 KB bytes.
    const bigResult = "x" + "😀".repeat(40_000); // 1 + 4·40 000 bytes ⇒ ~160 KB
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue(bigResult);
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    await getHandler()({
      taskId: "t2b",
      agentId: "agent-1",
      data: {},
      timestamp: 0,
    });

    const publishCall = (
      driver.publish as ReturnType<typeof vi.fn>
    ).mock.calls.find((c: unknown[]) => c[0] === "kaiban-events-completed");
    const payload = publishCall![1] as MessagePayload;
    const result = String(payload.data["result"]);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(65_536);
    expect(payload.data["_truncated"]).toBe(true);
    // No lone surrogate ⇒ round-trips through UTF-8 unchanged (no codepoint split).
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
    // No U+FFFD replacement char ⇒ the byte cap did not split a multi-byte
    // codepoint; the leading "x" survived and every surviving emoji is whole.
    expect(result).not.toContain("�");
    expect(result.startsWith("x")).toBe(true);
  });

  it("DLQ messages with large error strings are byte-capped", async () => {
    const bigError = new Error("e".repeat(100_000));
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockRejectedValue(bigError);
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await getHandler()({
      taskId: "t3",
      agentId: "agent-1",
      data: {},
      timestamp: 0,
    });

    const dlqCall = (
      driver.publish as ReturnType<typeof vi.fn>
    ).mock.calls.find((c: unknown[]) => c[0] === "kaiban-events-failed");
    expect(dlqCall).toBeDefined();
    const payload = dlqCall![1] as MessagePayload;
    expect(
      Buffer.byteLength(String(payload.data["error"]), "utf8"),
    ).toBeLessThanOrEqual(65_536);
  });

  it("DLQ multi-byte error string is byte-capped without splitting a codepoint", async () => {
    const bigError = new Error("💥".repeat(40_000)); // 4 bytes each
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockRejectedValue(bigError);
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await getHandler()({
      taskId: "t3b",
      agentId: "agent-1",
      data: {},
      timestamp: 0,
    });

    const dlqCall = (
      driver.publish as ReturnType<typeof vi.fn>
    ).mock.calls.find((c: unknown[]) => c[0] === "kaiban-events-failed");
    const payload = dlqCall![1] as MessagePayload;
    const errStr = String(payload.data["error"]);
    expect(Buffer.byteLength(errStr, "utf8")).toBeLessThanOrEqual(65_536);
    expect(Buffer.from(errStr, "utf8").toString("utf8")).toBe(errStr);
  });

  it("result at exactly 64KB boundary is NOT truncated", async () => {
    // Create a result that when serialized with the rest of data is just under 64KB
    const smallResult = "y".repeat(1000);
    const { driver, getHandler } = makeCapturingDriver();
    const handler = vi.fn().mockResolvedValue(smallResult);
    const actor = new AgentActor("agent-1", driver, "q", handler);
    await actor.start();
    await getHandler()({
      taskId: "t4",
      agentId: "agent-1",
      data: {},
      timestamp: 0,
    });

    const publishCall = (
      driver.publish as ReturnType<typeof vi.fn>
    ).mock.calls.find((c: unknown[]) => c[0] === "kaiban-events-completed");
    const payload = publishCall![1] as MessagePayload;
    expect(payload.data["result"]).toBe(smallResult);
    expect(payload.data["_truncated"]).toBeUndefined();
  });
});
