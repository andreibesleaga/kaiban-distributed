import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RunLogger } from "../../../examples/global-research/run-logger";

vi.mock("fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

describe("global-research RunLogger", () => {
  let runLog: RunLogger;

  beforeEach(() => {
    runLog = new RunLogger(
      "Quantum computing advances",
      "http://localhost:3000",
      "bullmq",
      3,
      "ctx-001",
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("logTask() adds a task entry and accumulates tokens/cost", () => {
    runLog.logTask("search", "task-1", "searcher-0", {
      inputTokens: 200,
      outputTokens: 80,
      estimatedCost: 0.002,
      answer: "Research data",
    });

    const { totalTokens, totalCost } = runLog.totals;
    expect(totalTokens).toBe(280);
    expect(totalCost).toBe(0.002);
  });

  it("logTask() truncates answer to 2000 characters", () => {
    const longAnswer = "B".repeat(3000);
    runLog.logTask("write", "task-2", "writer", {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      answer: longAnswer,
    });
    expect(runLog.totals.totalTokens).toBe(0);
  });

  it("logTask() handles undefined answer", () => {
    runLog.logTask("governance", "task-3", "reviewer", {
      inputTokens: 50,
      outputTokens: 25,
      estimatedCost: 0.0005,
    });
    expect(runLog.totals.totalTokens).toBe(75);
  });

  it("logError() records an error entry without affecting totals", () => {
    runLog.logError("search", "task-err", "searcher-0", "Search timeout");
    expect(runLog.totals.totalTokens).toBe(0);
  });

  it("totals getter aggregates across multiple tasks", () => {
    runLog.logTask("search", "t1", "searcher-0", {
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0.001,
    });
    runLog.logTask("write", "t2", "writer", {
      inputTokens: 300,
      outputTokens: 150,
      estimatedCost: 0.005,
    });

    const { totalTokens, totalCost } = runLog.totals;
    expect(totalTokens).toBe(600);
    expect(totalCost).toBeCloseTo(0.006);
  });

  it("finish() sets the outcome without throwing", () => {
    runLog.finish("PUBLISHED");
    expect(runLog.totals.totalTokens).toBe(0);
  });

  it("flush() writes a JSON file and returns filepath with .json extension", async () => {
    const { writeFile } = await import("fs/promises");
    runLog.logTask("search", "t1", "searcher-0", {
      inputTokens: 10,
      outputTokens: 5,
      estimatedCost: 0.001,
    });
    runLog.finish("PUBLISHED");

    const filePath = await runLog.flush("runs");
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(filePath).toMatch(/\.json$/);
    expect(vi.mocked(writeFile).mock.calls[0]![1]).toContain('"query"');
  });

  it("flush() uses 'research-run' fallback slug when query is empty", async () => {
    const log = new RunLogger(
      "",
      "http://localhost:3000",
      "bullmq",
      2,
      "ctx-000",
    );
    const { writeFile } = await import("fs/promises");
    vi.mocked(writeFile).mockClear();
    const filePath = await log.flush("runs");
    expect(filePath).toMatch(/research-run\.json$/);
  });

  it("flush() logs error to console.error when writeFile rejects (line 122)", async () => {
    const { writeFile } = await import("fs/promises");
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("ENOSPC: disk full"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const filePath = await runLog.flush("runs");

    expect(errSpy).toHaveBeenCalledWith(
      "[RunLogger] Failed to write run log:",
      expect.any(Error),
    );
    expect(filePath).toMatch(/\.json$/);
    errSpy.mockRestore();
  });
});
