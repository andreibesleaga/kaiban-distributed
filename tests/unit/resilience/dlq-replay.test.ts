/**
 * DLQ replay (master plan §B3 / Phase R, ADR-018).
 *
 * Replays retries-exhausted DLQ records back onto their agent mailbox, but
 * MUST SKIP non-retryable poison (firewall-block / breaker-open / policy-block):
 * re-dispatching a firewall-blocked or breaker-rejected task would just bounce
 * it straight back to the DLQ (or punch through a tripped breaker).
 */
import { describe, it, expect, vi } from "vitest";
import {
  replayDlq,
  DLQ_POISON_REASONS,
  type DlqRecord,
} from "../../../src/resilience/dlq-replay";
import type {
  IMessagingDriver,
  MessagePayload,
} from "../../../src/infrastructure/messaging/interfaces";

function makeDriver(): IMessagingDriver & { published: Array<[string, MessagePayload]> } {
  const published: Array<[string, MessagePayload]> = [];
  return {
    published,
    publish: vi.fn((queue: string, payload: MessagePayload) => {
      published.push([queue, payload]);
      return Promise.resolve();
    }),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

function dlqRecord(
  taskId: string,
  agentId: string,
  data: Record<string, unknown>,
): DlqRecord {
  return {
    payload: { taskId, agentId, timestamp: Date.now(), data },
  };
}

describe("replayDlq", () => {
  it("replays a retries-exhausted record onto kaiban-agents-<agentId>", async () => {
    const driver = makeDriver();
    const records = [
      dlqRecord("t1", "writer", {
        status: "failed",
        error: "LLM 503 Service Unavailable",
        instruction: "write",
      }),
    ];

    const result = await replayDlq({ driver, records });

    expect(result.replayed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(driver.published).toHaveLength(1);
    const [queue, payload] = driver.published[0]!;
    expect(queue).toBe("kaiban-agents-writer");
    expect(payload.taskId).toBe("t1");
    expect(payload.agentId).toBe("writer");
    // The original task data is restored (sans the failure envelope fields).
    expect(payload.data).toMatchObject({ instruction: "write" });
    expect(payload.data["status"]).toBeUndefined();
    expect(payload.data["error"]).toBeUndefined();
  });

  it("SKIPS firewall-blocked poison (does not republish)", async () => {
    const driver = makeDriver();
    const records = [
      dlqRecord("t2", "writer", {
        status: "failed",
        error: "blocked_by_semantic_firewall",
        reason: "prompt injection detected",
      }),
    ];

    const result = await replayDlq({ driver, records });

    expect(result.replayed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.skippedReasons).toEqual([
      { taskId: "t2", reason: "blocked_by_semantic_firewall" },
    ]);
    expect(driver.published).toHaveLength(0);
  });

  it("SKIPS breaker-open poison", async () => {
    const driver = makeDriver();
    const records = [
      dlqRecord("t3", "editor", {
        status: "failed",
        error: "circuit_breaker_open",
      }),
    ];
    const result = await replayDlq({ driver, records });
    expect(result.replayed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(driver.published).toHaveLength(0);
  });

  it("replays a mixed batch: retryable through, poison skipped", async () => {
    const driver = makeDriver();
    const records = [
      dlqRecord("ok1", "writer", { status: "failed", error: "timeout", prompt: "a" }),
      dlqRecord("poison", "writer", { status: "failed", error: "circuit_breaker_open" }),
      dlqRecord("ok2", "editor", { status: "failed", error: "rate limited", prompt: "b" }),
    ];

    const result = await replayDlq({ driver, records });

    expect(result.replayed).toBe(2);
    expect(result.skipped).toBe(1);
    expect(driver.published.map(([q]) => q)).toEqual([
      "kaiban-agents-writer",
      "kaiban-agents-editor",
    ]);
  });

  it("respects an explicit poison-reason allow/deny override", async () => {
    const driver = makeDriver();
    const records = [
      dlqRecord("t4", "writer", { status: "failed", error: "policy_blocked", prompt: "x" }),
    ];
    // Treat 'policy_blocked' as poison via the override set.
    const result = await replayDlq({
      driver,
      records,
      poisonReasons: new Set(["policy_blocked"]),
    });
    expect(result.skipped).toBe(1);
    expect(driver.published).toHaveLength(0);
  });

  it("honours a custom queue-name resolver", async () => {
    const driver = makeDriver();
    const records = [dlqRecord("t5", "writer", { status: "failed", error: "boom", p: 1 })];
    await replayDlq({
      driver,
      records,
      queueFor: (agentId) => `custom-${agentId}`,
    });
    expect(driver.published[0]![0]).toBe("custom-writer");
  });

  it("exposes the default poison-reason set", () => {
    expect(DLQ_POISON_REASONS.has("blocked_by_semantic_firewall")).toBe(true);
    expect(DLQ_POISON_REASONS.has("circuit_breaker_open")).toBe(true);
    expect(DLQ_POISON_REASONS.has("retries_exhausted")).toBe(false);
  });

  it("returns a zero result for an empty batch", async () => {
    const driver = makeDriver();
    const result = await replayDlq({ driver, records: [] });
    expect(result).toEqual({ replayed: 0, skipped: 0, skippedReasons: [] });
    expect(driver.published).toHaveLength(0);
  });

  it("replays a record with no `error` field (treated as non-poison)", async () => {
    const driver = makeDriver();
    // No `error` key → `payload.data['error'] ?? ''` falls back to '' (not poison).
    const records = [dlqRecord("t6", "writer", { status: "failed", prompt: "z" })];

    const result = await replayDlq({ driver, records });

    expect(result.replayed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(driver.published[0]![1].data).toMatchObject({ prompt: "z" });
  });

  it("preserves traceHeaders when present on the DLQ record", async () => {
    const driver = makeDriver();
    const records: DlqRecord[] = [
      {
        payload: {
          taskId: "t7",
          agentId: "writer",
          timestamp: Date.now(),
          data: { status: "failed", error: "timeout", prompt: "p" },
          traceHeaders: { traceparent: "00-abc-def-01" },
        },
      },
    ];

    await replayDlq({ driver, records });

    expect(driver.published[0]![1].traceHeaders).toEqual({
      traceparent: "00-abc-def-01",
    });
  });
});
