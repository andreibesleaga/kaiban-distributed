import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "@a2a-js/sdk";
import { RedisTaskStore } from "../../../src/infrastructure/federation/a2a-task-store";

// In-memory fake of the small ioredis surface the store uses.
const store = new Map<string, string>();
const mockSet = vi.fn(
  async (key: string, value: string, ..._opts: unknown[]) => {
    store.set(key, value);
    return "OK";
  },
);
const mockGet = vi.fn(async (key: string) => store.get(key) ?? null);
const mockQuit = vi.fn().mockResolvedValue(undefined);

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { set: mockSet, get: mockGet, quit: mockQuit };
  }),
}));

function makeTask(id: string): Task {
  return {
    kind: "task",
    id,
    contextId: "ctx-1",
    status: { state: "submitted" },
  };
}

describe("RedisTaskStore", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it("save() then load() round-trips a task", async () => {
    const ts = new RedisTaskStore("redis://localhost:6379");
    const task = makeTask("t-1");
    await ts.save(task);
    const loaded = await ts.load("t-1");
    expect(loaded).toEqual(task);
  });

  it("load() returns undefined for an unknown task", async () => {
    const ts = new RedisTaskStore("redis://localhost:6379");
    expect(await ts.load("missing")).toBeUndefined();
  });

  it("namespaces the Redis key and sets a TTL", async () => {
    const ts = new RedisTaskStore("redis://localhost:6379");
    await ts.save(makeTask("t-2"));
    expect(mockSet).toHaveBeenCalledWith(
      "a2a-task:t-2",
      expect.any(String),
      "EX",
      expect.any(Number),
    );
  });

  it("save() overwrites an existing task (idempotent upsert)", async () => {
    const ts = new RedisTaskStore("redis://localhost:6379");
    await ts.save(makeTask("t-3"));
    const updated: Task = {
      ...makeTask("t-3"),
      status: { state: "completed" },
    };
    await ts.save(updated);
    const loaded = await ts.load("t-3");
    expect(loaded?.status.state).toBe("completed");
  });

  it("load() returns undefined when the stored value is corrupt JSON", async () => {
    const ts = new RedisTaskStore("redis://localhost:6379");
    store.set("a2a-task:bad", "{not-json");
    expect(await ts.load("bad")).toBeUndefined();
  });

  it("accepts a custom TTL", async () => {
    const ts = new RedisTaskStore("redis://localhost:6379", { ttlSeconds: 99 });
    await ts.save(makeTask("t-4"));
    expect(mockSet).toHaveBeenCalledWith(
      "a2a-task:t-4",
      expect.any(String),
      "EX",
      99,
    );
  });

  it("accepts an injected Redis client", async () => {
    const injected = {
      set: mockSet,
      get: mockGet,
      quit: mockQuit,
    };
    const ts = new RedisTaskStore(injected as never);
    await ts.save(makeTask("t-5"));
    expect(await ts.load("t-5")).toBeTruthy();
  });

  it("close() quits the owned Redis client", async () => {
    const ts = new RedisTaskStore("redis://localhost:6379");
    await ts.close();
    expect(mockQuit).toHaveBeenCalledTimes(1);
  });

  it("close() does NOT quit an injected Redis client", async () => {
    const injected = { set: mockSet, get: mockGet, quit: mockQuit };
    const ts = new RedisTaskStore(injected as never);
    await ts.close();
    expect(mockQuit).not.toHaveBeenCalled();
  });
});
