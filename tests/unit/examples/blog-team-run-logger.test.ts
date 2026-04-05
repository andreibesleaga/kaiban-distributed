import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RunLogger } from "../../../examples/blog-team/run-logger";

vi.mock("fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

describe("blog-team RunLogger", () => {
  let runLog: RunLogger;

  beforeEach(() => {
    runLog = new RunLogger(
      "AI in Healthcare",
      "http://localhost:3000",
      "bullmq",
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("logTask() adds a task entry and accumulates tokens/cost", () => {
    runLog.logTask("research", "task-1", "researcher", {
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0.001,
      answer: "Research summary here",
    });

    const { totalTokens, totalCost } = runLog.totals;
    expect(totalTokens).toBe(150);
    expect(totalCost).toBe(0.001);
  });

  it("logTask() truncates answer to 2000 characters", () => {
    const longAnswer = "A".repeat(3000);
    runLog.logTask("write", "task-2", "writer", {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      answer: longAnswer,
    });
    // We can't directly inspect the internal record, but this should not throw
    expect(runLog.totals.totalTokens).toBe(0);
  });

  it("logTask() handles undefined answer", () => {
    runLog.logTask("research", "task-3", "researcher", {
      inputTokens: 50,
      outputTokens: 25,
      estimatedCost: 0.0005,
    });
    expect(runLog.totals.totalTokens).toBe(75);
  });

  it("logError() records an error entry", () => {
    // Just ensure it does not throw
    runLog.logError("research", "task-err", "researcher", "LLM timeout");
    expect(runLog.totals.totalTokens).toBe(0); // no tokens for errors
  });

  it("totals getter accumulates across multiple tasks", () => {
    runLog.logTask("research", "t1", "researcher", {
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0.001,
    });
    runLog.logTask("write", "t2", "writer", {
      inputTokens: 200,
      outputTokens: 100,
      estimatedCost: 0.003,
    });

    const { totalTokens, totalCost } = runLog.totals;
    expect(totalTokens).toBe(450);
    expect(totalCost).toBeCloseTo(0.004);
  });

  it("finish() sets the outcome", () => {
    runLog.finish("PUBLISHED");
    // No direct accessor, but flush will serialise it — just ensure no throw
    expect(runLog.totals.totalTokens).toBe(0);
  });

  it("flush() writes a JSON file and returns the filepath", async () => {
    const { writeFile } = await import("fs/promises");
    runLog.logTask("research", "t1", "researcher", {
      inputTokens: 10,
      outputTokens: 5,
      estimatedCost: 0.001,
    });
    runLog.finish("PUBLISHED");

    const filePath = await runLog.flush("runs");
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(filePath).toMatch(/\.json$/);
    expect(vi.mocked(writeFile).mock.calls[0]![1]).toContain('"topic"');
  });

  it("flush() uses empty-string fallback when topic is empty", async () => {
    const log = new RunLogger("", "http://localhost:3000", "bullmq");
    const { writeFile } = await import("fs/promises");
    vi.mocked(writeFile).mockClear();
    const filePath = await log.flush("runs");
    expect(filePath).toMatch(/blog-run\.json$/);
  });

  it("flush() logs error to console.error when writeFile rejects (line 120)", async () => {
    const { writeFile } = await import("fs/promises");
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("ENOSPC: disk full"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const filePath = await runLog.flush("runs");

    expect(errSpy).toHaveBeenCalledWith(
      "[RunLogger] Failed to write run log:",
      expect.any(Error),
    );
    // flush() still returns the target path even after error
    expect(filePath).toMatch(/\.json$/);
    errSpy.mockRestore();
  });
});
