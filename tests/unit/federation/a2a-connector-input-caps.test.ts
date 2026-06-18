/**
 * A2AConnector — Finding #3 hardening: validate EVERY accepted field for type
 * AND size, cap total params byte size, and forward only a validated, size-capped
 * payload (never raw `params`). Includes a fast-check property suite and an
 * explicit oversized-array/object OOM-guard test.
 *
 * Master plan §B8 Phase 1.3 / ADR-013-adjacent (1.3 has no separate ADR — it is a
 * security hardening of the existing connector that Phase 2 replaces).
 */
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import {
  A2AConnector,
  type AgentCard,
  A2A_INPUT_CAPS,
} from "../../../src/infrastructure/federation/a2a-connector";
import type { IMessagingDriver } from "../../../src/infrastructure/messaging/interfaces";

const testCard: AgentCard = {
  name: "test-worker",
  version: "1.0.0",
  description: "test",
  capabilities: ["tasks.create"],
  endpoints: { rpc: "/a2a/rpc" },
};

function makeMockDriver(): {
  driver: IMessagingDriver;
  publish: ReturnType<typeof vi.fn>;
} {
  const publish = vi.fn().mockResolvedValue(undefined);
  return {
    driver: {
      publish,
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    },
    publish,
  };
}

async function create(
  conn: A2AConnector,
  params: Record<string, unknown>,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const res = await conn.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tasks.create",
    params,
  });
  if (!res.ok) throw new Error("unexpected Result err");
  return res.value;
}

describe("A2AConnector — per-field type validation", () => {
  it("rejects a non-string instruction", async () => {
    const { driver } = makeMockDriver();
    const conn = new A2AConnector(testCard, driver);
    const res = await create(conn, { agentId: "a", instruction: { evil: 1 } });
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toMatch(/instruction/i);
  });

  it("rejects a non-string expectedOutput", async () => {
    const { driver } = makeMockDriver();
    const conn = new A2AConnector(testCard, driver);
    const res = await create(conn, { agentId: "a", expectedOutput: 42 });
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toMatch(/expectedOutput/i);
  });

  it("rejects a non-string context", async () => {
    const { driver } = makeMockDriver();
    const conn = new A2AConnector(testCard, driver);
    const res = await create(conn, { agentId: "a", context: ["x"] });
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toMatch(/context/i);
  });

  it("rejects inputs that is an array (must be a plain object)", async () => {
    const { driver } = makeMockDriver();
    const conn = new A2AConnector(testCard, driver);
    const res = await create(conn, { agentId: "a", inputs: [1, 2, 3] });
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toMatch(/inputs/i);
  });

  it("rejects inputs that is a non-object scalar", async () => {
    const { driver } = makeMockDriver();
    const conn = new A2AConnector(testCard, driver);
    const res = await create(conn, { agentId: "a", inputs: "not-an-object" });
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toMatch(/inputs/i);
  });
});

describe("A2AConnector — per-field size caps", () => {
  it("rejects an oversized instruction", async () => {
    const { driver } = makeMockDriver();
    const conn = new A2AConnector(testCard, driver);
    const res = await create(conn, {
      agentId: "a",
      instruction: "x".repeat(A2A_INPUT_CAPS.maxInstructionLen + 1),
    });
    expect(res.error?.code).toBe(-32602);
  });

  it("rejects an oversized expectedOutput", async () => {
    const { driver } = makeMockDriver();
    const conn = new A2AConnector(testCard, driver);
    const res = await create(conn, {
      agentId: "a",
      expectedOutput: "x".repeat(A2A_INPUT_CAPS.maxExpectedOutputLen + 1),
    });
    expect(res.error?.code).toBe(-32602);
  });

  it("rejects an oversized context", async () => {
    const { driver } = makeMockDriver();
    const conn = new A2AConnector(testCard, driver);
    const res = await create(conn, {
      agentId: "a",
      context: "x".repeat(A2A_INPUT_CAPS.maxContextLen + 1),
    });
    expect(res.error?.code).toBe(-32602);
  });

  it("rejects inputs with too many keys", async () => {
    const { driver } = makeMockDriver();
    const conn = new A2AConnector(testCard, driver);
    const inputs: Record<string, unknown> = {};
    for (let i = 0; i < A2A_INPUT_CAPS.maxInputsKeys + 1; i++) inputs[`k${i}`] = i;
    const res = await create(conn, { agentId: "a", inputs });
    expect(res.error?.code).toBe(-32602);
  });
});

describe("A2AConnector — OOM guard (total params byte cap)", () => {
  it("rejects a giant oversized inputs object before queueing it (OOM guard)", async () => {
    const { driver, publish } = makeMockDriver();
    const conn = new A2AConnector(testCard, driver);
    // A single huge string value blows past the total-params byte cap.
    const huge = "A".repeat(A2A_INPUT_CAPS.maxTotalParamsBytes + 1024);
    const res = await create(conn, { agentId: "a", inputs: { blob: huge } });
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toMatch(/too large|size/i);
    // The unvalidated payload must NEVER reach the queue.
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects an oversized array smuggled inside inputs (OOM guard)", async () => {
    const { driver, publish } = makeMockDriver();
    const conn = new A2AConnector(testCard, driver);
    const bigArray = new Array(2_000_000).fill("x");
    const res = await create(conn, { agentId: "a", inputs: { arr: bigArray } });
    expect(res.error?.code).toBe(-32602);
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not crash on a circular params structure (size pre-check is safe)", async () => {
    const { driver, publish } = makeMockDriver();
    const conn = new A2AConnector(testCard, driver);
    const circular: Record<string, unknown> = { agentId: "a", inputs: {} };
    circular["self"] = circular; // unserializable → safeStringify catch path
    const res = await create(conn, circular);
    // A circular `self` is an unexpected, non-string field → dropped, not raw;
    // the request still resolves without throwing.
    expect(res.error).toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
    const [, msg] = publish.mock.calls[0] as [
      string,
      { data: Record<string, unknown> },
    ];
    expect(msg.data).not.toHaveProperty("self");
  });
});

describe("A2AConnector — only validated, capped payload is forwarded", () => {
  it("forwards exactly the validated fields, NOT raw params", async () => {
    const { driver, publish } = makeMockDriver();
    const conn = new A2AConnector(testCard, driver);
    const res = await create(conn, {
      agentId: "worker-1",
      instruction: "do the thing",
      expectedOutput: "a result",
      context: "some ctx",
      inputs: { topic: "AI" },
      // An extra, unexpected field must be dropped — never forwarded raw.
      __proto_pollution: "evil",
      hugeIgnored: "y".repeat(10),
    });
    expect(res.error).toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, msg] = publish.mock.calls[0] as [
      string,
      { data: Record<string, unknown> },
    ];
    expect(channel).toBe("kaiban-agents-worker-1");
    // `agentId` is a top-level message field, not inside `data`.
    expect(Object.keys(msg.data).sort()).toEqual(
      ["context", "expectedOutput", "inputs", "instruction"].sort(),
    );
    expect(msg.data).not.toHaveProperty("agentId");
    expect(msg.data).not.toHaveProperty("__proto_pollution");
    expect(msg.data).not.toHaveProperty("hugeIgnored");
  });

  it("omits optional fields that were not supplied", async () => {
    const { driver, publish } = makeMockDriver();
    const conn = new A2AConnector(testCard, driver);
    await create(conn, { agentId: "w2", instruction: "hi" });
    const [, msg] = publish.mock.calls[0] as [
      string,
      { data: Record<string, unknown> },
    ];
    expect(msg.data["instruction"]).toBe("hi");
    expect(msg.data).not.toHaveProperty("context");
    expect(msg.data).not.toHaveProperty("expectedOutput");
  });
});

describe("A2AConnector — property: valid inputs accepted, oversized rejected", () => {
  it("accepts any in-range string fields and forwards them", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[\w-]{1,64}$/),
        fc.string({ maxLength: 200 }),
        async (agentId, instruction) => {
          const { driver, publish } = makeMockDriver();
          const conn = new A2AConnector(testCard, driver);
          const res = await create(conn, { agentId, instruction });
          expect(res.error).toBeUndefined();
          expect(publish).toHaveBeenCalledTimes(1);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("always rejects an instruction longer than the cap (never queues it)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5000 }),
        async (extra) => {
          const { driver, publish } = makeMockDriver();
          const conn = new A2AConnector(testCard, driver);
          const res = await create(conn, {
            agentId: "a",
            instruction: "x".repeat(A2A_INPUT_CAPS.maxInstructionLen + extra),
          });
          expect(res.error?.code).toBe(-32602);
          expect(publish).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 30 },
    );
  });
});
