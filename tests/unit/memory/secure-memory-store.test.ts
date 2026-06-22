import { describe, it, expect, beforeEach } from "vitest";
import {
  SecureMemoryStore,
  type Classification,
  type MemoryEntry,
  type MemoryProvenance,
  type MemoryRole,
  type TrustLevel,
} from "../../../src/memory/secure-memory-store";

const prov = (trust: TrustLevel, source = "agent-a"): MemoryProvenance => ({
  source,
  trust,
});

describe("SecureMemoryStore", () => {
  let store: SecureMemoryStore;

  beforeEach(() => {
    store = new SecureMemoryStore();
  });

  describe("put/get roundtrip", () => {
    it("stores and retrieves a value with the default classification 'internal'", () => {
      store.put("tenant-a", "k1", { hello: "world" }, {
        provenance: prov("high"),
        now: 1_000,
      });

      const entry = store.get("tenant-a", "k1", { now: 2_000, role: "admin" });

      expect(entry).toBeDefined();
      expect(entry?.value).toEqual({ hello: "world" });
      expect(entry?.classification).toBe<Classification>("internal");
      expect(entry?.provenance).toEqual({ source: "agent-a", trust: "high" });
      expect(entry?.storedAt).toBe(1_000);
      expect(entry?.ttlMs).toBeUndefined();
      expect(store.size()).toBe(1);
    });

    it("honors an explicit classification", () => {
      store.put("tenant-a", "k1", "secret", {
        provenance: prov("low"),
        classification: "confidential",
        now: 0,
      });

      const entry = store.get("tenant-a", "k1", { now: 0, role: "admin" });
      expect(entry?.classification).toBe<Classification>("confidential");
    });

    it("returns undefined for a missing key", () => {
      expect(store.get("tenant-a", "nope", { now: 0 })).toBeUndefined();
    });
  });

  describe("tenant isolation", () => {
    it("never lets tenant B read tenant A's entry with the same key", () => {
      store.put("tenant-a", "shared-key", "A-secret", {
        provenance: prov("high"),
        now: 0,
      });

      expect(
        store.get("tenant-b", "shared-key", { now: 0, role: "admin" }),
      ).toBeUndefined();
      expect(
        store.get("tenant-a", "shared-key", { now: 0, role: "admin" })?.value,
      ).toBe("A-secret");
    });

    it("keeps separate values per tenant under the same key", () => {
      store.put("tenant-a", "k", "valueA", { provenance: prov("high"), now: 0 });
      store.put("tenant-b", "k", "valueB", { provenance: prov("high"), now: 0 });

      expect(store.get("tenant-a", "k", { now: 0, role: "admin" })?.value).toBe(
        "valueA",
      );
      expect(store.get("tenant-b", "k", { now: 0, role: "admin" })?.value).toBe(
        "valueB",
      );
      expect(store.size()).toBe(2);
    });
  });

  describe("TTL expiry", () => {
    it("evicts and returns undefined once the entry has expired", () => {
      store.put("tenant-a", "k", "v", {
        provenance: prov("high"),
        ttlMs: 100,
        now: 1_000,
      });
      expect(store.size()).toBe(1);

      // storedAt + ttlMs = 1100; now == 1100 -> expired (<=).
      const entry = store.get("tenant-a", "k", { now: 1_100 });

      expect(entry).toBeUndefined();
      expect(store.size()).toBe(0);
    });

    it("returns the entry before it expires", () => {
      store.put("tenant-a", "k", "v", {
        provenance: prov("high"),
        ttlMs: 100,
        now: 1_000,
      });

      const entry = store.get("tenant-a", "k", { now: 1_099, role: "admin" });
      expect(entry?.value).toBe("v");
      expect(store.size()).toBe(1);
    });

    it("never expires an entry stored without a ttlMs", () => {
      store.put("tenant-a", "k", "v", {
        provenance: prov("high"),
        now: 0,
      });

      const entry = store.get("tenant-a", "k", { now: 9_999_999, role: "admin" });
      expect(entry?.value).toBe("v");
      expect(store.size()).toBe(1);
    });
  });

  describe("RBAC retrieval-time access control", () => {
    const classifications: Classification[] = [
      "public",
      "internal",
      "confidential",
    ];

    const allowed: Record<MemoryRole, Classification[]> = {
      viewer: ["public"],
      operator: ["public", "internal"],
      admin: ["public", "internal", "confidential"],
    };

    const roles: MemoryRole[] = ["viewer", "operator", "admin"];

    for (const role of roles) {
      for (const classification of classifications) {
        const canRead = allowed[role].includes(classification);
        it(`${role} ${canRead ? "can" : "cannot"} read ${classification}`, () => {
          store.put("t", "k", "v", {
            provenance: prov("high"),
            classification,
            now: 0,
          });

          const entry = store.get("t", "k", { now: 0, role });
          if (canRead) {
            expect(entry?.value).toBe("v");
          } else {
            expect(entry).toBeUndefined();
          }
        });
      }
    }

    it("treats a missing role as 'viewer' (allows public)", () => {
      store.put("t", "pub", "v", {
        provenance: prov("high"),
        classification: "public",
        now: 0,
      });
      expect(store.get("t", "pub", { now: 0 })?.value).toBe("v");
    });

    it("treats a missing role as 'viewer' (denies internal)", () => {
      store.put("t", "int", "v", {
        provenance: prov("high"),
        classification: "internal",
        now: 0,
      });
      expect(store.get("t", "int", { now: 0 })).toBeUndefined();
    });
  });

  describe("minTrust filter", () => {
    it("denies an entry whose trust is below minTrust", () => {
      store.put("t", "k", "v", {
        provenance: prov("low"),
        classification: "public",
        now: 0,
      });

      expect(
        store.get("t", "k", { now: 0, role: "admin", minTrust: "high" }),
      ).toBeUndefined();
    });

    it("allows an entry whose trust equals minTrust", () => {
      store.put("t", "k", "v", {
        provenance: prov("low"),
        classification: "public",
        now: 0,
      });

      expect(
        store.get("t", "k", { now: 0, role: "admin", minTrust: "low" })?.value,
      ).toBe("v");
    });

    it("allows an entry whose trust is above minTrust", () => {
      store.put("t", "k", "v", {
        provenance: prov("high"),
        classification: "public",
        now: 0,
      });

      expect(
        store.get("t", "k", { now: 0, role: "admin", minTrust: "untrusted" })
          ?.value,
      ).toBe("v");
    });

    it("does not filter on trust when minTrust is unset", () => {
      store.put("t", "k", "v", {
        provenance: prov("untrusted"),
        classification: "public",
        now: 0,
      });

      expect(store.get("t", "k", { now: 0, role: "admin" })?.value).toBe("v");
    });
  });

  describe("revoke (poisoned entry)", () => {
    it("removes a poisoned entry and returns true, then the entry is gone", () => {
      store.put("t", "k", "poison", { provenance: prov("untrusted"), now: 0 });
      expect(store.size()).toBe(1);

      expect(store.revoke("t", "k")).toBe(true);
      expect(store.get("t", "k", { now: 0, role: "admin" })).toBeUndefined();
      expect(store.size()).toBe(0);
    });

    it("returns false when revoking a key that does not exist", () => {
      expect(store.revoke("t", "missing")).toBe(false);
    });

    it("respects tenant isolation when revoking", () => {
      store.put("tenant-a", "k", "v", { provenance: prov("high"), now: 0 });
      expect(store.revoke("tenant-b", "k")).toBe(false);
      expect(store.get("tenant-a", "k", { now: 0, role: "admin" })?.value).toBe(
        "v",
      );
    });
  });

  describe("sweep", () => {
    it("purges only expired entries across tenants and returns the count", () => {
      store.put("tenant-a", "expired", "x", {
        provenance: prov("high"),
        ttlMs: 10,
        now: 0,
      });
      store.put("tenant-b", "also-expired", "y", {
        provenance: prov("high"),
        ttlMs: 50,
        now: 0,
      });
      store.put("tenant-a", "fresh", "z", {
        provenance: prov("high"),
        ttlMs: 1_000,
        now: 0,
      });
      store.put("tenant-c", "no-ttl", "w", {
        provenance: prov("high"),
        now: 0,
      });
      expect(store.size()).toBe(4);

      const purged = store.sweep(100);

      expect(purged).toBe(2);
      expect(store.size()).toBe(2);
      expect(store.get("tenant-a", "fresh", { now: 100, role: "admin" })?.value).toBe(
        "z",
      );
      expect(store.get("tenant-c", "no-ttl", { now: 100, role: "admin" })?.value).toBe(
        "w",
      );
    });

    it("returns 0 when nothing is expired", () => {
      store.put("t", "k", "v", { provenance: prov("high"), now: 0 });
      expect(store.sweep(9_999)).toBe(0);
      expect(store.size()).toBe(1);
    });
  });

  describe("size", () => {
    it("reflects the live entry count", () => {
      expect(store.size()).toBe(0);
      store.put("t", "a", 1, { provenance: prov("high"), now: 0 });
      store.put("t", "b", 2, { provenance: prov("high"), now: 0 });
      expect(store.size()).toBe(2);
    });
  });

  describe("MemoryEntry shape", () => {
    it("exposes a fully-typed entry", () => {
      store.put("t", "k", 42, {
        provenance: prov("high"),
        classification: "public",
        ttlMs: 5,
        now: 7,
      });
      const entry: MemoryEntry | undefined = store.get("t", "k", {
        now: 8,
        role: "admin",
      });
      expect(entry?.ttlMs).toBe(5);
      expect(entry?.storedAt).toBe(7);
    });
  });
});
