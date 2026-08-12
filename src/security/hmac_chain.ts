/**
 * HMAC-Keyed Hash Chain — Sprint 0 foundation
 * ============================================
 *
 * A reusable tamper-evident chain primitive for new security-critical tables
 * introduced in Sprint 1+ (audit_log, tool_calls, outcomes, skills, mutations).
 *
 * RELATIONSHIP TO src/chain.ts:
 *   `chain.ts` is the LEGACY chain on `broadcasts` (raw SHA256, no key).
 *   `hmac_chain.ts` is the v0.10.5+ STANDARD for any new tamper-evident table.
 *   They coexist. Existing `chain.ts` is not modified for backward compat.
 *
 * WHY HMAC INSTEAD OF RAW SHA256:
 *   Raw SHA256 chains: an attacker with DB write access can recompute valid
 *   hashes themselves — no key needed. Tamper evidence relies on the attacker
 *   not realizing the chain exists.
 *
 *   HMAC-keyed chains: even with full DB access, an attacker cannot forge a
 *   valid `row_hash` without the machine secret. Tamper detection is
 *   cryptographically guaranteed (assuming the secret stays uncompromised).
 *
 *   This is a MEANINGFUL security upgrade for tables holding audit-critical
 *   data (audit_log, outcomes, skill mutations).
 *
 * USAGE:
 *   import { hmacRowHash, getLastHashFromRows, verifyHmacChain } from "./hmac_chain.js";
 *   import { getMachineSecret } from "./machine_secret.js";
 *
 *   const secret = getMachineSecret();
 *
 *   // When inserting a new row:
 *   const prev = getLastHashFromRows(existingRows);
 *   const hash = hmacRowHash(secret, prev, canonicalize(newRow));
 *   db.insert({...newRow, prev_hash: prev, row_hash: hash});
 *
 *   // When verifying:
 *   const result = verifyHmacChain(secret, allRows, canonicalize);
 *   if (!result.ok) alert(`Tamper detected at row #${result.brokenAt}`);
 *
 * GENESIS:
 *   The first row's prev_hash is the literal string "genesis" (not a hash).
 *   This matches the existing chain.ts convention.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Sentinel for the first row's prev_hash. */
export const GENESIS = "genesis";

/** Length of HMAC-SHA256 output in hex characters. */
export const HMAC_HEX_LENGTH = 64;  // 256 bits / 4 bits per hex char

// ─── Interface ─────────────────────────────────────────────────────────────

/** Minimal shape required for a row to participate in a chain. */
export interface ChainableRow {
  id:        number;
  prev_hash: string;
  row_hash:  string;
}

/** Result of a chain verification pass. */
export interface VerifyResult {
  /** True iff every row's hash matches the expected HMAC of (prev_hash + canonical). */
  ok:          boolean;
  /** Number of rows examined (only counts rows with non-empty row_hash). */
  totalRows:   number;
  /** If ok=false, the id of the first row whose hash didn't verify. */
  brokenAt?:   number;
  /** If ok=false, the HMAC we expected vs what was stored (for diagnostics). */
  brokenHash?: string;
  /** If ok=false, what kind of break: hash-mismatch | prev-mismatch. */
  brokenKind?: "hash-mismatch" | "prev-mismatch";
  /**
   * v0.53.0 — if ok=false, how many rows fail to recompute under their OWN stored
   * prev_hash. Position-independent, so it survives the cascade that follows the
   * first break — the old result stopped at the first bad row and so could say
   * nothing about whether the rest of the log was fine.
   */
  hashMismatches?: number;
  /**
   * v0.53.0 — how many CONTIGUOUS runs those failures form. This is the field that
   * actually tells the operator what happened, and the count alone does not:
   *
   *   few large blocks  → the key changed at those boundaries (re-key, restored
   *                       volume, a secret mounted from a different path). Every row
   *                       written under the old secret fails together, in order.
   *   many small blocks → individual rows were altered; their neighbours still verify.
   *
   * Measured on the live admission log: 252 of 334 rows failing, but in exactly 2
   * blocks (1–198 and 308–334) with 199–307 verifying, the first boundary landing on
   * the machine-secret unification. Read as a count that is "252 bad rows, alarming";
   * read as a shape it is one key change, and benign. The banner had shown a flat red
   * CHAIN TAMPERED for months because it could not draw that distinction.
   *
   * ponytail: block SHAPE is a triage aid, not an authentication boundary — an
   * attacker editing a long adjacent span looks key-shaped. Ground truth stays the
   * audit.log JSONL anchors; upgrade path is anchoring each key epoch explicitly.
   */
  mismatchBlocks?: number;
}

// ─── Core API ──────────────────────────────────────────────────────────────

/**
 * Compute the HMAC-SHA256 of (prev_hash + "|" + canonical) keyed with `secret`.
 * Returns a 64-char hex string.
 *
 * IMPORTANT: callers MUST canonicalize their row data into a deterministic
 * string. Suggested format: pipe-separated `field1|field2|field3` with a
 * stable field order. Do NOT use JSON.stringify (key ordering not guaranteed
 * across platforms).
 */
export function hmacRowHash(
  secret:    Buffer,
  prevHash:  string,
  canonical: string
): string {
  return createHmac("sha256", secret)
    .update(prevHash)
    .update("|")
    .update(canonical)
    .digest("hex");
}

/**
 * Get the row_hash of the last row in the chain (highest id), or GENESIS if
 * the chain is empty / has no hashed rows.
 *
 * Rows are filtered to only those with a non-empty row_hash (so we don't
 * crash on tables that have legacy rows pre-dating the chain).
 */
export function getLastHashFromRows<T extends Pick<ChainableRow, "id" | "row_hash">>(
  rows: readonly T[]
): string {
  if (rows.length === 0) return GENESIS;

  // Filter to chained rows only
  let lastHash = GENESIS;
  let lastId = -1;
  for (const r of rows) {
    if (r.row_hash && r.row_hash.length > 0 && r.id > lastId) {
      lastId = r.id;
      lastHash = r.row_hash;
    }
  }
  return lastHash;
}

/**
 * Verify an entire chain. Walks rows in ascending id order, recomputes each
 * row's HMAC, and compares to what's stored. Detects:
 *   - Hash mismatch (row_hash doesn't equal HMAC of canonical content)
 *   - Prev mismatch (row's prev_hash doesn't equal previous row's row_hash)
 *   - Insertions / deletions / modifications (any of the above)
 *
 * Rows with empty row_hash are SKIPPED (treated as legacy, not chain members).
 *
 * Uses timing-safe comparison to prevent timing-attack inference of the chain
 * state during verification.
 */
export function verifyHmacChain<T extends ChainableRow>(
  secret:       Buffer,
  rows:         readonly T[],
  getCanonical: (row: T) => string
): VerifyResult {
  // Sort by id ascending (callers should already provide sorted, but defensive)
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const chained = sorted.filter((r) => r.row_hash && r.row_hash.length > 0);

  if (chained.length === 0) {
    return { ok: true, totalRows: 0 };
  }

  let expectedPrev = GENESIS;

  // Count every row that fails under its OWN stored prev_hash, so the verdict below
  // can distinguish a wrong key (all fail) from edited rows (some fail). Done in the
  // same walk; on an intact chain it stays 0 and costs nothing extra.
  let hashMismatches = 0;
  let mismatchBlocks = 0;
  let prevFailed = false;
  let first: VerifyResult | null = null;

  for (const row of chained) {
    const expected = hmacRowHash(secret, row.prev_hash, getCanonical(row));
    const hashOk   = constantTimeStringEq(expected, row.row_hash);
    if (!hashOk) {
      hashMismatches++;
      if (!prevFailed) mismatchBlocks++;
    }
    prevFailed = !hashOk;

    if (!first && row.prev_hash !== expectedPrev) {
      first = { ok: false, totalRows: chained.length, brokenAt: row.id, brokenHash: expectedPrev, brokenKind: "prev-mismatch" };
    } else if (!first && !hashOk) {
      first = { ok: false, totalRows: chained.length, brokenAt: row.id, brokenHash: expected, brokenKind: "hash-mismatch" };
    }

    expectedPrev = row.row_hash;
  }

  return first ? { ...first, hashMismatches, mismatchBlocks } : { ok: true, totalRows: chained.length };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Constant-time comparison of two equal-length hex strings. Returns true iff
 * they match. Uses Node's `timingSafeEqual` to prevent timing-attack
 * inference of which characters differ.
 *
 * If the strings differ in length, returns false immediately (this leaks
 * length but not content — and our hashes are always 64 hex chars).
 */
export function constantTimeStringEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // Compare as UTF-8 byte buffers. timingSafeEqual works on any equal-length
  // buffer regardless of content. Hex parsing was a premature optimization
  // that corrupted comparisons of non-hex strings (odd-length hex drops chars).
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Build a canonical pipe-separated string from a list of fields. Use this in
 * `getCanonical` callbacks for consistent serialization.
 *
 * Example:
 *   canonicalize(["audit_event", row.event, row.actor, row.action, row.ts])
 *   → "audit_event|token_issued|orchestrator|create|2026-04-18T..."
 *
 * Important: callers must use a STABLE field order (don't iterate over object
 * keys; explicitly list fields in array form).
 */
export function canonicalize(fields: readonly (string | number | boolean | null | undefined)[]): string {
  return fields
    .map((f) => {
      if (f === null || f === undefined) return "";
      // Escape pipe and backslash to avoid canonicalization collisions
      return String(f).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
    })
    .join("|");
}
