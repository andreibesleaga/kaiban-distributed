/**
 * dispatchToAgent — the actor-model dispatch primitive (ADR-015 replacement for the
 * removed `tasks.create` RPC). Publishes a MessagePayload to `kaiban-agents-{id}`.
 */
import { describe, it, expect, vi, type Mock } from "vitest";
import {
  dispatchToAgent,
  AGENT_CHANNEL_PREFIX,
} from "../../../src/shared/dispatch";
import type { MessagePayload } from "../../../src/infrastructure/messaging/interfaces";

type PublishFn = (channel: string, payload: MessagePayload) => Promise<void>;

function capture(): {
  driver: { publish: Mock<PublishFn> };
  last: () => { channel: string; payload: MessagePayload };
} {
  const publish = vi.fn<PublishFn>(() => Promise.resolve());
  return {
    driver: { publish },
    last: (): { channel: string; payload: MessagePayload } => {
      const call = publish.mock.calls.at(-1)!;
      return { channel: call[0], payload: call[1] };
    },
  };
}

describe("dispatchToAgent", () => {
  it("publishes to the agent mailbox with a generated taskId + minimal data", async () => {
    const { driver, last } = capture();
    const taskId = await dispatchToAgent(driver, "researcher", {
      instruction: "research X",
    });

    expect(typeof taskId).toBe("string");
    expect(taskId.length).toBeGreaterThan(0);
    const { channel, payload } = last();
    expect(channel).toBe(`${AGENT_CHANNEL_PREFIX}researcher`);
    expect(payload.taskId).toBe(taskId);
    expect(payload.agentId).toBe("researcher");
    expect(typeof payload.timestamp).toBe("number");
    expect(payload.data).toEqual({ instruction: "research X" });
  });

  it("forwards expectedOutput, context and inputs when provided", async () => {
    const { driver, last } = capture();
    await dispatchToAgent(driver, "writer", {
      instruction: "write it",
      expectedOutput: "a post",
      context: "prior research",
      inputs: { topic: "AI" },
    });
    expect(last().payload.data).toEqual({
      instruction: "write it",
      expectedOutput: "a post",
      context: "prior research",
      inputs: { topic: "AI" },
    });
  });

  it("omits optional fields that are not provided", async () => {
    const { driver, last } = capture();
    await dispatchToAgent(driver, "editor", {
      instruction: "edit",
      context: "the draft",
    });
    expect(last().payload.data).toEqual({
      instruction: "edit",
      context: "the draft",
    });
  });

  it("returns a unique taskId per dispatch", async () => {
    const { driver } = capture();
    const a = await dispatchToAgent(driver, "x", { instruction: "1" });
    const b = await dispatchToAgent(driver, "x", { instruction: "2" });
    expect(a).not.toBe(b);
  });
});
