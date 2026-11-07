/**
 * AgentActor — the 64 KB outbound cap is measured on the serialized JSON
 * (ACT-V-01): escaped characters and the failure fields cannot slip past it,
 * and a long error does not throw away small task inputs.
 */
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../../src/shared/structured-logger", () => ({
  createStructuredLogger: (): typeof mockLog => mockLog,
  logger: mockLog,
  resolveLogLevel: (): string => "silent",
}));

import { AgentActor } from "../../../src/application/actor/AgentActor";
import type {
  IMessagingDriver,
  MessagePayload,
} from "../../../src/infrastructure/messaging/interfaces";

const CAP = 65_536;

function setup(handler: (p: MessagePayload) => Promise<unknown>): {
  run: () => Promise<void>;
  published: () => { channel: string; data: Record<string, unknown> }[];
} {
  let h!: (p: MessagePayload) => Promise<void>;
  const driver: IMessagingDriver = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((_q, fn) => {
      h = fn;
      return Promise.resolve();
    }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const actor = new AgentActor("a", driver, "q", handler);
  return {
    run: async (): Promise<void> => {
      await actor.start();
      await h({
        taskId: "t",
        agentId: "a",
        data: { instruction: "do" },
        timestamp: Date.now(),
      });
    },
    published: () =>
      (driver.publish as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => ({
          channel: c[0] as string,
          data: (c[1] as MessagePayload).data,
        }),
      ),
  };
}

const bytes = (v: unknown): number =>
  Buffer.byteLength(JSON.stringify(v), "utf8");

describe("completed results are capped by their serialized size", () => {
  it("200 000 newlines fit within 64 KB once escaped", async () => {
    const t = setup(async () => "\n".repeat(200_000));
    await t.run();
    const done = t
      .published()
      .find((p) => p.channel === "kaiban-events-completed")!;
    expect(bytes(done.data)).toBeLessThanOrEqual(CAP);
    expect(done.data["_truncated"]).toBe(true);
  });

  it("property: any string result keeps the published data within 64 KB", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string({ maxLength: 40_000, unit: "binary" }),
          fc
            .constantFrom("\n", '"', "\u0001", "é", "😀")
            .map((c) => c.repeat(70_000)),
        ),
        async (result) => {
          const t = setup(async () => result);
          await t.run();
          const done = t
            .published()
            .find((p) => p.channel === "kaiban-events-completed")!;
          expect(bytes(done.data)).toBeLessThanOrEqual(CAP);
        },
      ),
      // Fixed seed: the same 25 inputs every run. Strings up to 70 000 characters are
      // serialized many times, so allow more than the 5 s default under a loaded coverage run.
      { numRuns: 25, seed: 20261106 },
    );
  }, 30_000);

  it("a result that fits is published untouched", async () => {
    const t = setup(async () => "small");
    await t.run();
    const done = t
      .published()
      .find((p) => p.channel === "kaiban-events-completed")!;
    expect(done.data).toEqual({ status: "success", result: "small" });
  });
});

describe("dead-letter records keep small inputs next to a long error", () => {
  it("a 70 000-character error still carries the task inputs and stays within 64 KB", async () => {
    const t = setup(async () => {
      throw new Error("x".repeat(70_000));
    });
    await t.run();
    const dlq = t
      .published()
      .find((p) => p.channel === "kaiban-events-failed")!;
    expect(bytes(dlq.data)).toBeLessThanOrEqual(CAP);
    expect(dlq.data["instruction"]).toBe("do");
    expect(dlq.data).not.toHaveProperty("_inputs_omitted");
    expect(dlq.data).not.toHaveProperty("result");
  });
});
