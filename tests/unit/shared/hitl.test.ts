import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitForHITLDecision } from "../../../src/shared";
import type { HitlOptions } from "../../../src/shared";

// ── ioredis mock ──────────────────────────────────────────────────────────────

let capturedMessageHandler: ((ch: string, msg: string) => void) | null = null;
const mockOn = vi
  .fn()
  .mockImplementation(
    (event: string, handler: (ch: string, msg: string) => void) => {
      if (event === "message") capturedMessageHandler = handler;
    },
  );
const mockSubscribe = vi.fn().mockResolvedValue(1);
const mockDisconnect = vi.fn();

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { on: mockOn, subscribe: mockSubscribe, disconnect: mockDisconnect };
  }),
}));

// ── channel-signing: no CHANNEL_SIGNING_SECRET → plain JSON passthrough ──────

// Helper: build a valid board message
function boardMsg(taskId: string, decision: string): string {
  return JSON.stringify({ taskId, decision });
}

// Helper: build a readline mock whose question() calls the callback after setup
function makeRlMock(): {
  rl: HitlOptions["rl"];
  sendAnswer: (answer: string) => void;
} {
  let questionCallback: ((answer: string) => void) | null = null;
  const question = vi
    .fn()
    .mockImplementation((_prompt: string, cb: (answer: string) => void) => {
      questionCallback = cb;
    });
  const write = vi.fn();

  const rl = { question, write } as unknown as Parameters<
    typeof waitForHITLDecision
  >[0]["rl"];

  return {
    rl,
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    sendAnswer: (answer: string) => {
      if (questionCallback) questionCallback(answer);
    },
  };
}

describe("waitForHITLDecision — terminal path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedMessageHandler = null;
    delete process.env["CHANNEL_SIGNING_SECRET"];
  });

  it("resolves PUBLISH when user inputs '1'", async () => {
    const { rl, sendAnswer } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "task-1",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    sendAnswer("1");
    await expect(promise).resolves.toBe("PUBLISH");
  });

  it("resolves REVISE when user inputs '2'", async () => {
    const { rl, sendAnswer } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "task-1",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    sendAnswer("2");
    await expect(promise).resolves.toBe("REVISE");
  });

  it("resolves REJECT when user inputs '3'", async () => {
    const { rl, sendAnswer } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "task-1",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    sendAnswer("3");
    await expect(promise).resolves.toBe("REJECT");
  });

  it("re-prompts when input is unrecognised, then resolves on valid answer", async () => {
    const questionCallback: Array<(ans: string) => void> = [];
    const question = vi
      .fn()
      .mockImplementation((_prompt: string, cb: (ans: string) => void) => {
        questionCallback.push(cb);
      });
    const rl = { question, write: vi.fn() } as unknown as HitlOptions["rl"];
    const promise = waitForHITLDecision({
      taskId: "task-x",
      rl,
      redisUrl: "redis://localhost:6379",
    });

    // First invalid answer
    questionCallback[0]!("9");
    // Wait for re-prompt
    await Promise.resolve();
    // Second valid answer
    questionCallback[1]!("1");
    await expect(promise).resolves.toBe("PUBLISH");
  });

  it("calls onView when user inputs '4'", async () => {
    let viewCallCount = 0;
    let questionCallback: ((ans: string) => void) | null = null;
    let secondCallback: ((ans: string) => void) | null = null;
    let call = 0;

    const question = vi
      .fn()
      .mockImplementation((_prompt: string, cb: (ans: string) => void) => {
        if (call === 0) {
          questionCallback = cb;
        } else {
          secondCallback = cb;
        }
        call++;
      });
    const rl = { question, write: vi.fn() } as unknown as HitlOptions["rl"];
    const onView = (): void => {
      viewCallCount++;
    };

    const promise = waitForHITLDecision({
      taskId: "task-view",
      rl,
      redisUrl: "redis://localhost:6379",
      onView,
    });

    questionCallback!("4"); // triggers VIEW + re-prompt
    await Promise.resolve();
    secondCallback!("1"); // PUBLISH on second prompt
    await expect(promise).resolves.toBe("PUBLISH");
    expect(viewCallCount).toBe(1);
  });

  it("writes newline to rl to release pending question on resolution", async () => {
    const { rl, sendAnswer } = makeRlMock();
    const writeSpy = vi.spyOn(rl as { write: (s: string) => void }, "write");
    const promise = waitForHITLDecision({
      taskId: "task-nl",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    sendAnswer("1");
    await promise;
    expect(writeSpy).toHaveBeenCalledWith("\n");
  });
});

describe("waitForHITLDecision — board path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedMessageHandler = null;
    delete process.env["CHANNEL_SIGNING_SECRET"];
  });

  it("resolves PUBLISH when board sends PUBLISH for matching taskId", async () => {
    const { rl } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "board-task",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    // Simulate board message arriving after subscribe
    await Promise.resolve(); // allow subscribe to be called
    capturedMessageHandler!(
      "kaiban-hitl-decisions",
      boardMsg("board-task", "PUBLISH"),
    );
    await expect(promise).resolves.toBe("PUBLISH");
  });

  it("resolves REVISE when board sends REVISE", async () => {
    const { rl } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "board-task-2",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    await Promise.resolve();
    capturedMessageHandler!(
      "kaiban-hitl-decisions",
      boardMsg("board-task-2", "REVISE"),
    );
    await expect(promise).resolves.toBe("REVISE");
  });

  it("resolves REJECT when board sends REJECT", async () => {
    const { rl } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "board-task-3",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    await Promise.resolve();
    capturedMessageHandler!(
      "kaiban-hitl-decisions",
      boardMsg("board-task-3", "REJECT"),
    );
    await expect(promise).resolves.toBe("REJECT");
  });

  it("ignores board messages for non-matching taskId", async () => {
    const { rl, sendAnswer } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "my-task",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    await Promise.resolve();
    // Wrong taskId — should be ignored
    capturedMessageHandler!(
      "kaiban-hitl-decisions",
      boardMsg("other-task", "PUBLISH"),
    );
    // Resolve via terminal instead
    sendAnswer("3");
    await expect(promise).resolves.toBe("REJECT");
  });

  it("ignores malformed (non-JSON) board messages", async () => {
    const { rl, sendAnswer } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "task-json",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    await Promise.resolve();
    // Bad JSON
    capturedMessageHandler!("kaiban-hitl-decisions", "not valid json {{");
    // Still pending — resolve via terminal
    sendAnswer("1");
    await expect(promise).resolves.toBe("PUBLISH");
  });

  it("ignores board messages with missing taskId or decision fields", async () => {
    const { rl, sendAnswer } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "task-fields",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    await Promise.resolve();
    // Message with no taskId
    capturedMessageHandler!(
      "kaiban-hitl-decisions",
      JSON.stringify({ decision: "PUBLISH" }),
    );
    // Message with no decision
    capturedMessageHandler!(
      "kaiban-hitl-decisions",
      JSON.stringify({ taskId: "task-fields" }),
    );
    // Still pending — resolve via terminal
    sendAnswer("2");
    await expect(promise).resolves.toBe("REVISE");
  });

  it("ignores board messages with unknown decision values", async () => {
    const { rl, sendAnswer } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "task-unknown",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    await Promise.resolve();
    // Unknown decision value
    capturedMessageHandler!(
      "kaiban-hitl-decisions",
      JSON.stringify({ taskId: "task-unknown", decision: "MAYBE" }),
    );
    // Still pending
    sendAnswer("1");
    await expect(promise).resolves.toBe("PUBLISH");
  });

  it("ignores duplicate board messages after first resolution", async () => {
    const { rl } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "task-dup",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    await Promise.resolve();
    capturedMessageHandler!(
      "kaiban-hitl-decisions",
      boardMsg("task-dup", "PUBLISH"),
    );
    // Second message after resolution — should be silently ignored
    capturedMessageHandler!(
      "kaiban-hitl-decisions",
      boardMsg("task-dup", "REJECT"),
    );
    await expect(promise).resolves.toBe("PUBLISH");
  });

  it("resolves with rl=null (board-only mode)", async () => {
    const promise = waitForHITLDecision({
      taskId: "auto-task",
      rl: null,
      redisUrl: "redis://localhost:6379",
    });
    await Promise.resolve();
    capturedMessageHandler!(
      "kaiban-hitl-decisions",
      boardMsg("auto-task", "PUBLISH"),
    );
    await expect(promise).resolves.toBe("PUBLISH");
  });

  it("subscribes to kaiban-hitl-decisions channel", async () => {
    const { rl, sendAnswer } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "sub-task",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    sendAnswer("1");
    await promise;
    expect(mockSubscribe).toHaveBeenCalledWith("kaiban-hitl-decisions");
  });

  it("disconnects the Redis subscriber after resolution", async () => {
    const { rl, sendAnswer } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "disc-task",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    sendAnswer("1");
    await promise;
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("warns when board message has unrecognised decision value", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { rl, sendAnswer } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "warn-task",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    await Promise.resolve();
    // Unrecognised decision (e.g. VIEW sent from board, now rejected)
    capturedMessageHandler!(
      "kaiban-hitl-decisions",
      JSON.stringify({ taskId: "warn-task", decision: "VIEW" }),
    );
    // Promise stays pending — resolve via terminal
    sendAnswer("1");
    await expect(promise).resolves.toBe("PUBLISH");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unrecognised board decision"),
    );
    warnSpy.mockRestore();
  });

  it("warns when board message taskId does not match", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { rl, sendAnswer } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "expected-task",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    await Promise.resolve();
    capturedMessageHandler!(
      "kaiban-hitl-decisions",
      JSON.stringify({ taskId: "other-task", decision: "PUBLISH" }),
    );
    sendAnswer("2");
    await expect(promise).resolves.toBe("REVISE");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("taskId mismatch"),
    );
    warnSpy.mockRestore();
  });

  it("warns when Redis subscribe fails and continues in terminal-only mode", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSubscribe.mockRejectedValueOnce(new Error("Redis connection refused"));
    const { rl, sendAnswer } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "redis-fail-task",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    sendAnswer("3");
    await expect(promise).resolves.toBe("REJECT");
    await Promise.resolve(); // allow the subscribe rejection to propagate
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Redis subscribe failed"),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it("terminal wins race when board is slow (board sends after terminal)", async () => {
    const { rl, sendAnswer } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "race-task",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    // Terminal resolves first
    sendAnswer("1");
    // Board sends after — should be ignored
    await Promise.resolve();
    capturedMessageHandler?.(
      "kaiban-hitl-decisions",
      boardMsg("race-task", "REJECT"),
    );
    await expect(promise).resolves.toBe("PUBLISH");
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it("board wins race when terminal is slow (board sends before terminal)", async () => {
    const { rl } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "race-board-task",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    await Promise.resolve();
    // Board resolves first
    capturedMessageHandler!(
      "kaiban-hitl-decisions",
      boardMsg("race-board-task", "REVISE"),
    );
    // Terminal never answers — promise should already be resolved
    await expect(promise).resolves.toBe("REVISE");
  });

  it("ignores malformed (invalid JSON) board messages — unwrapVerified returns null, no throw", async () => {
    // unwrapVerified catches JSON.parse errors internally and returns null.
    // The try/catch in handleBoardMessage is only hit when unwrapVerified itself throws
    // (e.g. HMAC buffer size mismatch). For plain bad JSON, the message is silently ignored.
    const { rl, sendAnswer } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "malformed-task",
      rl,
      redisUrl: "redis://localhost:6379",
    });
    await Promise.resolve();
    // unwrapVerified returns null for bad JSON → parsed is null → early return, no warn
    capturedMessageHandler!("kaiban-hitl-decisions", "{{not json}}");
    // Promise remains pending — resolve via terminal
    sendAnswer("1");
    await expect(promise).resolves.toBe("PUBLISH");
  });
});
