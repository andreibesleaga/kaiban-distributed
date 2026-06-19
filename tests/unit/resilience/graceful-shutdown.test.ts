/**
 * Graceful shutdown (master plan §B5.1 Phase R, ADR-018).
 *
 * On SIGTERM the process must stop accepting new work, drain in-flight work,
 * finish acks, flush, and close drivers — IN ORDER — within a bounded deadline.
 * `gracefulShutdown` runs an ordered list of named steps best-effort: a failing
 * step is recorded but does not abort the remaining cleanup, and the whole
 * sequence is capped by `deadlineMs` so a hung dependency cannot wedge shutdown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { gracefulShutdown } from "../../../src/resilience/graceful-shutdown";

describe("gracefulShutdown", () => {
  it("runs every step in order and reports completion", async () => {
    const order: string[] = [];
    const result = await gracefulShutdown({
      deadlineMs: 1000,
      steps: [
        { name: "stop-intake", run: (): void => void order.push("stop-intake") },
        {
          name: "drain",
          run: (): Promise<void> => Promise.resolve(void order.push("drain")),
        },
        { name: "close", run: (): void => void order.push("close") },
      ],
    });

    expect(order).toEqual(["stop-intake", "drain", "close"]);
    expect(result.completed).toEqual(["stop-intake", "drain", "close"]);
    expect(result.timedOut).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it("records a failing step but continues the remaining cleanup", async () => {
    const order: string[] = [];
    const result = await gracefulShutdown({
      deadlineMs: 1000,
      steps: [
        { name: "drain", run: (): void => void order.push("drain") },
        {
          name: "flush",
          run: (): Promise<void> => Promise.reject(new Error("flush boom")),
        },
        { name: "close", run: (): void => void order.push("close") },
      ],
    });

    // close still ran despite flush throwing — best-effort drain.
    expect(order).toEqual(["drain", "close"]);
    expect(result.completed).toEqual(["drain", "close"]);
    expect(result.errors).toEqual([{ step: "flush", error: "flush boom" }]);
    expect(result.timedOut).toBe(false);
  });

  it("stringifies a non-Error step rejection", async () => {
    const result = await gracefulShutdown({
      deadlineMs: 1000,
      steps: [{ name: "close", run: (): Promise<void> => Promise.reject("nope") }],
    });
    expect(result.errors).toEqual([{ step: "close", error: "nope" }]);
  });

  describe("with fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("aborts the sequence when the deadline is exceeded", async () => {
      const closed = vi.fn();
      const promise = gracefulShutdown({
        deadlineMs: 50,
        steps: [
          {
            name: "drain",
            // Never resolves within the deadline.
            run: (): Promise<void> => new Promise<void>(() => undefined),
          },
          { name: "close", run: closed },
        ],
      });

      await vi.advanceTimersByTimeAsync(60);
      const result = await promise;

      expect(result.timedOut).toBe(true);
      expect(result.completed).not.toContain("drain");
      // close never reached — the hung drain step exhausted the deadline.
      expect(closed).not.toHaveBeenCalled();
    });

    it("does not flag a timeout when steps finish in time", async () => {
      const promise = gracefulShutdown({
        deadlineMs: 1000,
        steps: [
          {
            name: "drain",
            run: (): Promise<void> =>
              new Promise<void>((resolve) => setTimeout(resolve, 10)),
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(20);
      const result = await promise;
      expect(result.timedOut).toBe(false);
      expect(result.completed).toEqual(["drain"]);
    });
  });
});
