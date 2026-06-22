/**
 * Hash-chained, tamper-evident audit log (master plan §B5.1 Phase G, ADR-020).
 *
 * Each appended {@link GateDecision} becomes an {@link AuditRecord} whose `hash`
 * is `sha256(prevHash + canonical({ index, timestamp, decision }))`, and whose
 * `prevHash` is the previous record's `hash` ("" for genesis). Any mutation of a
 * record's content, or of the `prevHash` linkage, breaks the chain — detected by
 * {@link AuditLog.verify} which recomputes every hash and re-checks every link.
 */

import { createHash } from "crypto";
import type {
  AuditRecord,
  AuditSink,
  AuditVerification,
  GateDecision,
} from "./types";

/** Deterministic serialization of the hashed content. */
const canonical = (o: unknown): string => JSON.stringify(o);

/** Append-only, tamper-evident chain of gate decisions. */
export class AuditLog implements AuditSink {
  private readonly chain: AuditRecord[] = [];

  /** Append a decision; returns the newly chained record. */
  public append(decision: GateDecision, timestamp: string): AuditRecord {
    const index = this.chain.length;
    const prevHash = index === 0 ? "" : this.chain[index - 1].hash;
    const hash = this.computeHash(prevHash, index, timestamp, decision);
    const record: AuditRecord = { index, timestamp, decision, prevHash, hash };
    this.chain.push(record);
    return record;
  }

  /** The chain, in append order. */
  public records(): readonly AuditRecord[] {
    return this.chain;
  }

  /** Recompute every hash + re-check every link; report the first break. */
  public verify(): AuditVerification {
    for (let i = 0; i < this.chain.length; i += 1) {
      const record = this.chain[i];
      const expectedPrev = i === 0 ? "" : this.chain[i - 1].hash;
      const expectedHash = this.computeHash(
        record.prevHash,
        record.index,
        record.timestamp,
        record.decision,
      );
      if (record.prevHash !== expectedPrev || record.hash !== expectedHash) {
        return { valid: false, brokenAt: i };
      }
    }
    return { valid: true };
  }

  /** Single source of truth for a record's hash (shared by append + verify). */
  private computeHash(
    prevHash: string,
    index: number,
    timestamp: string,
    decision: GateDecision,
  ): string {
    const content = canonical({ index, timestamp, decision });
    return createHash("sha256").update(prevHash + content).digest("hex");
  }
}
