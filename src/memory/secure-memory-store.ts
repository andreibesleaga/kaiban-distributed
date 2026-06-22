/**
 * Hardened in-memory store (master plan §B5.1 Phase G — "memory hardening").
 *
 * Defends agent memory against poisoning and unauthorized retrieval by binding
 * every entry to a {@link MemoryProvenance} (source + trust tag) and a data
 * {@link Classification}, then enforcing controls at READ time:
 *  - **Tenant keyspaces** — entries are keyed by `(tenantId, key)`; one tenant
 *    can never observe another tenant's entry, even under an identical `key`.
 *  - **Retrieval-time RBAC** — a caller {@link MemoryRole} may only read up to
 *    its classification ceiling (viewer→public, operator→+internal, admin→all);
 *    a missing role is treated as the least-privileged `viewer`.
 *  - **TTL / eviction** — an entry with `ttlMs` is evicted lazily on a `get`
 *    after expiry, and eagerly via {@link SecureMemoryStore.sweep}.
 *  - **Trust floor** — a `get` may require a minimum provenance trust; entries
 *    below it are withheld (without eviction — they may satisfy a laxer reader).
 *  - **Revocation** — a poisoned entry can be removed outright.
 *
 * Time is an explicit numeric `now` (ms) on every operation — the store never
 * calls `Date.now()`, so behavior is fully deterministic and testable.
 */

/** Provenance trust tag, ordered `untrusted < low < high`. */
export type TrustLevel = "untrusted" | "low" | "high";

/** Data sensitivity classification. */
export type Classification = "public" | "internal" | "confidential";

/** Caller role used for retrieval-time RBAC. */
export type MemoryRole = "viewer" | "operator" | "admin";

/** Where a memory came from and how much it is trusted. */
export interface MemoryProvenance {
  source: string;
  trust: TrustLevel;
}

/** A stored memory with its security metadata. */
export interface MemoryEntry {
  value: unknown;
  provenance: MemoryProvenance;
  classification: Classification;
  storedAt: number;
  ttlMs?: number;
}

/** Options for {@link SecureMemoryStore.put}. `classification` defaults to `"internal"`. */
export interface PutOptions {
  provenance: MemoryProvenance;
  classification?: Classification;
  ttlMs?: number;
  now: number;
}

/** Options for {@link SecureMemoryStore.get}. A missing `role` is treated as `viewer`. */
export interface GetOptions {
  now: number;
  role?: MemoryRole;
  minTrust?: TrustLevel;
}

/** Numeric ranking of trust levels (higher = more trusted). */
const TRUST_RANK: Record<TrustLevel, number> = {
  untrusted: 0,
  low: 1,
  high: 2,
};

/** Numeric ranking of classifications (higher = more sensitive). */
const CLASSIFICATION_RANK: Record<Classification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
};

/** Highest classification each role may read. Missing role ⇒ `viewer`. */
const ROLE_CEILING: Record<MemoryRole, Classification> = {
  viewer: "public",
  operator: "internal",
  admin: "confidential",
};

/** A hardened, tenant-isolated in-memory store with provenance + RBAC + TTL. */
export class SecureMemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();

  /** Store `value` under `(tenantId, key)` with its provenance + classification. */
  public put(
    tenantId: string,
    key: string,
    value: unknown,
    opts: PutOptions,
  ): void {
    const entry: MemoryEntry = {
      value,
      provenance: opts.provenance,
      classification: opts.classification ?? "internal",
      storedAt: opts.now,
      ttlMs: opts.ttlMs,
    };
    this.entries.set(this.compositeKey(tenantId, key), entry);
  }

  /**
   * Retrieve `(tenantId, key)`, applying TTL eviction, RBAC and the trust floor.
   * Returns `undefined` when missing, expired (and evicts), denied by role, or
   * below `minTrust`.
   */
  public get(
    tenantId: string,
    key: string,
    opts: GetOptions,
  ): MemoryEntry | undefined {
    const composite = this.compositeKey(tenantId, key);
    const entry = this.entries.get(composite);
    if (entry === undefined) {
      return undefined;
    }
    if (this.isExpired(entry, opts.now)) {
      this.entries.delete(composite);
      return undefined;
    }
    if (!this.canRead(opts.role, entry.classification)) {
      return undefined;
    }
    if (!this.meetsTrust(entry, opts.minTrust)) {
      return undefined;
    }
    return entry;
  }

  /** Remove a (poisoned) entry; returns whether something was removed. */
  public revoke(tenantId: string, key: string): boolean {
    return this.entries.delete(this.compositeKey(tenantId, key));
  }

  /** Purge every expired entry across all tenants; returns the count purged. */
  public sweep(now: number): number {
    let purged = 0;
    for (const [composite, entry] of this.entries) {
      if (this.isExpired(entry, now)) {
        this.entries.delete(composite);
        purged += 1;
      }
    }
    return purged;
  }

  /** Live entry count (observability / tests). */
  public size(): number {
    return this.entries.size;
  }

  /** Whether a role may read a classification (missing role ⇒ `viewer`). */
  private canRead(
    role: MemoryRole | undefined,
    classification: Classification,
  ): boolean {
    const ceiling = ROLE_CEILING[role ?? "viewer"];
    return CLASSIFICATION_RANK[classification] <= CLASSIFICATION_RANK[ceiling];
  }

  /** Whether an entry has passed its TTL relative to `now`. */
  private isExpired(entry: MemoryEntry, now: number): boolean {
    return entry.ttlMs !== undefined && entry.storedAt + entry.ttlMs <= now;
  }

  /** Whether an entry's trust meets the optional `minTrust` floor. */
  private meetsTrust(
    entry: MemoryEntry,
    minTrust: TrustLevel | undefined,
  ): boolean {
    if (minTrust === undefined) {
      return true;
    }
    return TRUST_RANK[entry.provenance.trust] >= TRUST_RANK[minTrust];
  }

  /** Tenant-scoped composite map key (JSON-encoded pair — collision-free). */
  private compositeKey(tenantId: string, key: string): string {
    return JSON.stringify([tenantId, key]);
  }
}
