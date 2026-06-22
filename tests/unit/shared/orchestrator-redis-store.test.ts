/**
 * RedisCheckpointStore — Redis-backed checkpoint persistence for the
 * single-active orchestrator (master plan §B5.1 Phase R, ADR-018).
 *
 * Persists per-workflow checkpoint state under a namespaced key so a crashed
 * orchestrator resumes from the last completed step instead of restarting.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGet = vi.fn();
const mockSet = vi.fn().mockResolvedValue("OK");
const mockDel = vi.fn().mockResolvedValue(1);
const mockQuit = vi.fn().mockResolvedValue("OK");

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { get: mockGet, set: mockSet, del: mockDel, quit: mockQuit };
  }),
}));

import { RedisCheckpointStore } from "../../../src/shared/orchestrator";

describe("RedisCheckpointStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(null);
  });

  it("save() writes JSON under the namespaced key with a TTL", async () => {
    const store = new RedisCheckpointStore("redis://localhost:6379");
    await store.save("wf-1", { research: { taskId: "t1", result: "r1" } });

    const [key, value, ...rest] = mockSet.mock.calls[0]!;
    expect(key).toBe("kaiban-orchestrator:checkpoint:wf-1");
    expect(JSON.parse(value as string)).toEqual({
      research: { taskId: "t1", result: "r1" },
    });
    // Has an expiry mode (EX <seconds>) so abandoned checkpoints self-evict.
    expect(rest).toContain("EX");
  });

  it("load() returns null when no checkpoint exists", async () => {
    mockGet.mockResolvedValue(null);
    const store = new RedisCheckpointStore("redis://localhost:6379");
    expect(await store.load("missing")).toBeNull();
    expect(mockGet).toHaveBeenCalledWith(
      "kaiban-orchestrator:checkpoint:missing",
    );
  });

  it("load() parses and returns the stored checkpoint", async () => {
    mockGet.mockResolvedValue(
      JSON.stringify({ write: { taskId: "t2", result: "r2" } }),
    );
    const store = new RedisCheckpointStore("redis://localhost:6379");
    expect(await store.load("wf-2")).toEqual({
      write: { taskId: "t2", result: "r2" },
    });
  });

  it("load() returns null on corrupt JSON instead of throwing", async () => {
    mockGet.mockResolvedValue("{not-json");
    const store = new RedisCheckpointStore("redis://localhost:6379");
    expect(await store.load("wf-3")).toBeNull();
  });

  it("clear() deletes the namespaced key", async () => {
    const store = new RedisCheckpointStore("redis://localhost:6379");
    await store.clear("wf-4");
    expect(mockDel).toHaveBeenCalledWith(
      "kaiban-orchestrator:checkpoint:wf-4",
    );
  });

  it("disconnect() quits the Redis connection", async () => {
    const store = new RedisCheckpointStore("redis://localhost:6379");
    await store.disconnect();
    expect(mockQuit).toHaveBeenCalled();
  });

  it("honours a custom TTL", async () => {
    const store = new RedisCheckpointStore("redis://localhost:6379", {
      ttlSeconds: 99,
    });
    await store.save("wf-5", {});
    const args = mockSet.mock.calls[0]!;
    const exIdx = args.indexOf("EX");
    expect(args[exIdx + 1]).toBe(99);
  });
});
