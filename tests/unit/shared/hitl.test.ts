import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitForHITLDecision } from "../../../src/shared";
import type { HitlOptions } from "../../../src/shared";

// ── channel-signing mock — default: plain JSON pass-through (no secret) ────────
// Allows per-test override to test throw path in handleBoardMessage.

const {
  state,
  mockUnwrapVerified,
  mockSubscribe,
  mockDisconnect,
  mockBrpop,
  mockSubOn,
  mockPollerOn,
} = vi.hoisted(() => {
  const state = {
    capturedMessageHandler: null as ((ch: string, msg: string) => void) | null,
    capturedPollerErrorHandler: null as ((err: unknown) => void) | null,
    redisCallCount: 0,
  };

  const mockUnwrapVerified = vi
    .fn()
    .mockImplementation((msg: string): Record<string, unknown> | null => {
      try {
        return JSON.parse(msg) as Record<string, unknown>;
      } catch {
        return null;
      }
    });

  const mockSubscribe = vi.fn().mockResolvedValue(1);
  const mockDisconnect = vi.fn();
  const mockBrpop = vi.fn().mockImplementation(() => new Promise(() => {}));

  const mockSubOn = vi
    .fn()
    .mockImplementation(
      (event: string, handler: (ch: string, msg: string) => void) => {
        if (event === "message") state.capturedMessageHandler = handler;
      },
    );

  const mockPollerOn = vi
    .fn()
    .mockImplementation((event: string, handler: (err: unknown) => void) => {
      if (event === "error") state.capturedPollerErrorHandler = handler;
    });

  return {
    state,
    mockUnwrapVerified,
    mockSubscribe,
    mockDisconnect,
    mockBrpop,
    mockSubOn,
    mockPollerOn,
  };
});

vi.mock("../../../src/infrastructure/security/channel-signing", () => ({
  unwrapVerified: mockUnwrapVerified,
  wrapSigned: vi.fn((p: Record<string, unknown>) => JSON.stringify(p)),
}));

// ── ioredis mock — two distinct Redis instances: sub (pub/sub) + poller (BRPOP) ─
//
// waitForHITLDecision creates Redis instances in order:
//   1st new Redis() → sub  (pub/sub subscriber)
//   2nd new Redis() → poller (BRPOP list poller)
//
// redisCallCount tracks which instance is being created.

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    state.redisCallCount++;
    if (state.redisCallCount % 2 === 1) {
      // Odd calls = sub (pub/sub subscriber)
      return {
        on: mockSubOn,
        subscribe: mockSubscribe,
        disconnect: mockDisconnect,
      };
    }
    // Even calls = poller (BRPOP)
    return {
      on: mockPollerOn,
      brpop: mockBrpop,
      disconnect: mockDisconnect,
    };
  }),
}));

// ── Helper: build a valid board message ───────────────────────────────────────

function boardMsg(taskId: string, decision: string): string {
  return JSON.stringify({ taskId, decision });
}

function resetHoistedMocks(): void {
  vi.clearAllMocks();
  state.capturedMessageHandler = null;
  state.capturedPollerErrorHandler = null;
  state.redisCallCount = 0;
  mockUnwrapVerified.mockImplementation(
    (msg: string): Record<string, unknown> | null => {
      try {
        return JSON.parse(msg) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
  );
  delete process.env["CHANNEL_SIGNING_SECRET"];
}

// ── Helper: build a readline mock whose question() calls the callback ─────────

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

// ── Terminal path ─────────────────────────────────────────────────────────────

describe("waitForHITLDecision — terminal path", () => {
  beforeEach(() => {
    resetHoistedMocks();
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

// ── Board path (pub/sub) ──────────────────────────────────────────────────────

describe("waitForHITLDecision — board path", () => {
  beforeEach(() => {
    resetHoistedMocks();
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
    state.capturedMessageHandler!(
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
    state.capturedMessageHandler!(
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
    state.capturedMessageHandler!(
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
    state.capturedMessageHandler!(
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
    state.capturedMessageHandler!("kaiban-hitl-decisions", "not valid json {{");
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
    state.capturedMessageHandler!(
      "kaiban-hitl-decisions",
      JSON.stringify({ decision: "PUBLISH" }),
    );
    // Message with no decision
    state.capturedMessageHandler!(
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
    state.capturedMessageHandler!(
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
    state.capturedMessageHandler!(
      "kaiban-hitl-decisions",
      boardMsg("task-dup", "PUBLISH"),
    );
    // Second message after resolution — should be silently ignored
    state.capturedMessageHandler!(
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
    state.capturedMessageHandler!(
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
    state.capturedMessageHandler!(
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
    state.capturedMessageHandler!(
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
    state.capturedMessageHandler?.(
      "kaiban-hitl-decisions",
      boardMsg("race-task", "REJECT"),
    );
    await expect(promise).resolves.toBe("PUBLISH");
    // sub.disconnect() + poller.disconnect() — both are called on resolution
    expect(mockDisconnect).toHaveBeenCalledTimes(2);
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
    state.capturedMessageHandler!(
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
    state.capturedMessageHandler!("kaiban-hitl-decisions", "{{not json}}");
    // Promise remains pending — resolve via terminal
    sendAnswer("1");
    await expect(promise).resolves.toBe("PUBLISH");
  });
});

// ── BRPOP path ────────────────────────────────────────────────────────────────

describe("waitForHITLDecision — BRPOP path", () => {
  beforeEach(() => {
    resetHoistedMocks();
  });

  it("resolves via BRPOP when poller receives a matching message", async () => {
    const taskId = "brpop-task-1";
    const listKey = `kaiban-hitl-decisions:${taskId}`;
    mockBrpop.mockResolvedValueOnce([listKey, boardMsg(taskId, "PUBLISH")]);

    const promise = waitForHITLDecision({
      taskId,
      rl: null,
      redisUrl: "redis://localhost:6379",
    });

    await expect(promise).resolves.toBe("PUBLISH");
  });

  it("skips null BRPOP result (timeout) and resolves on next successful poll", async () => {
    const taskId = "brpop-null-task";
    const listKey = `kaiban-hitl-decisions:${taskId}`;
    // First poll: timeout (null), second poll: message
    mockBrpop
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([listKey, boardMsg(taskId, "REVISE")]);

    const promise = waitForHITLDecision({
      taskId,
      rl: null,
      redisUrl: "redis://localhost:6379",
    });

    await expect(promise).resolves.toBe("REVISE");
  });

  it("logs warning and retries when BRPOP throws, then resolves", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const taskId = "brpop-error-task";
    const listKey = `kaiban-hitl-decisions:${taskId}`;

    // First poll throws, second poll succeeds
    mockBrpop
      .mockRejectedValueOnce(new Error("BRPOP connection lost"))
      .mockResolvedValueOnce([listKey, boardMsg(taskId, "REJECT")]);

    const promise = waitForHITLDecision({
      taskId,
      rl: null,
      redisUrl: "redis://localhost:6379",
    });

    // Let the first brpop rejection propagate through microtasks
    await Promise.resolve();
    await Promise.resolve();
    // Warning should have fired before the 500ms retry delay
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("BRPOP error (retrying)"),
      expect.any(Error),
    );

    // Advance past the 500ms retry delay → second brpop fires
    vi.advanceTimersByTime(500);
    await expect(promise).resolves.toBe("REJECT");

    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("logs warning when poller emits an error event", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    waitForHITLDecision({
      taskId: "poller-error-task",
      rl: null,
      redisUrl: "redis://localhost:6379",
    });

    // capturedPollerErrorHandler is set synchronously during construction
    expect(state.capturedPollerErrorHandler).not.toBeNull();
    state.capturedPollerErrorHandler!(new Error("Redis disconnected"));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Redis poller error"),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("does not log poller error after resolution", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { rl, sendAnswer } = makeRlMock();
    const taskId = "poller-error-resolved-task";
    const promise = waitForHITLDecision({
      taskId,
      rl,
      redisUrl: "redis://localhost:6379",
    });

    // Resolve via terminal first
    sendAnswer("1");

    // Then fire poller error — should be silently ignored (resolved=true)
    state.capturedPollerErrorHandler?.(new Error("too late"));

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Redis poller error"),
      expect.any(Error),
    );
    warnSpy.mockRestore();
    return promise;
  });
});

// ── handleBoardMessage error path ─────────────────────────────────────────────

describe("waitForHITLDecision — handleBoardMessage error path", () => {
  beforeEach(() => {
    resetHoistedMocks();
  });

  it("logs warning when unwrapVerified throws (e.g. HMAC buffer mismatch)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockUnwrapVerified.mockImplementationOnce(() => {
      throw new Error("HMAC buffer size mismatch");
    });

    const { rl, sendAnswer } = makeRlMock();
    const promise = waitForHITLDecision({
      taskId: "throw-task",
      rl,
      redisUrl: "redis://localhost:6379",
    });

    await Promise.resolve(); // allow subscribe to register
    // Trigger the pub/sub message handler — unwrapVerified will throw
    state.capturedMessageHandler!("kaiban-hitl-decisions", "some-raw-message");

    // Catch block fires: warning logged, promise stays pending
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse/verify board message"),
      expect.any(Error),
    );

    // Resolve via terminal to clean up
    sendAnswer("2");
    await expect(promise).resolves.toBe("REVISE");

    warnSpy.mockRestore();
  });
});
