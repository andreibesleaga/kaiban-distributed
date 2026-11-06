import { describe, it, expect } from "vitest";
import {
  assignSearcherId,
  SEARCHER_COUNTER_KEY,
  SEARCHER_HOSTS_KEY,
  type SearcherIdRedis,
} from "../../../examples/global-research/searcher-id";

/** An in-memory stand-in for the three Redis commands the assignment uses. */
function fakeRedis(): SearcherIdRedis & { counter: number; hosts: Map<string, string> } {
  const hosts = new Map<string, string>();
  const r = {
    counter: 0,
    hosts,
    hget: async (_k: string, f: string): Promise<string | null> => hosts.get(f) ?? null,
    incr: async (_k: string): Promise<number> => ++r.counter,
    hsetnx: async (_k: string, f: string, v: string): Promise<number> => {
      if (hosts.has(f)) return 0;
      hosts.set(f, v);
      return 1;
    },
  };
  return r;
}

describe("assignSearcherId (WF-10)", () => {
  it("SEARCHER_ID wins and touches nothing", async () => {
    const r = fakeRedis();
    await expect(assignSearcherId(r, "h", { SEARCHER_ID: "zz" })).resolves.toBe("zz");
    expect(r.counter).toBe(0);
  });

  it("hands out 0..n-1 to distinct hosts", async () => {
    const r = fakeRedis();
    const ids = [];
    for (const h of ["a", "b", "c", "d"]) ids.push(await assignSearcherId(r, h, {}));
    expect(ids).toEqual(["searcher-0", "searcher-1", "searcher-2", "searcher-3"]);
  });

  it("a replica restarted in place (same host) takes its OLD id back, not a live one or a fifth card", async () => {
    const r = fakeRedis();
    for (const h of ["a", "b", "c"]) await assignSearcherId(r, h, {});
    await expect(assignSearcherId(r, "c", {})).resolves.toBe("searcher-2");
    expect(r.counter).toBe(3);
  });

  it("two racing starts of one host settle on the first write", async () => {
    const r = fakeRedis();
    // Another start of the same host wins the HSETNX between our INCR and our read.
    const realIncr = r.incr;
    r.incr = async (k: string): Promise<number> => {
      const n = await realIncr(k);
      r.hosts.set("h", "7");
      return n;
    };
    await expect(assignSearcherId(r, "h", {})).resolves.toBe("searcher-7");
  });

  it("falls back to the claimed index if the read-back returns nothing", async () => {
    const r = fakeRedis();
    let reads = 0;
    r.hget = async (): Promise<string | null> => (reads++ === 0 ? null : null);
    await expect(assignSearcherId(r, "h", {})).resolves.toBe("searcher-0");
  });

  it("uses documented key names", () => {
    expect(SEARCHER_COUNTER_KEY).toBe("kaiban:searcher:reg");
    expect(SEARCHER_HOSTS_KEY).toBe("kaiban:searcher:hosts");
  });
});
