/**
 * Tests for src/security/hmac_chain.ts
 *
 * Covers (per §13 categories):
 *   - Unit: hmacRowHash, getLastHashFromRows, verifyHmacChain, canonicalize, constantTimeStringEq
 *   - Integration: build a small chain end-to-end + verify
 *   - Failure-mode: empty rows, legacy unhashed rows, sorted/unsorted input
 *   - Red-team RT-S0-03: hash mismatch detected
 *   - Red-team RT-S0-04: prev_hash tampering detected
 *   - Red-team RT-S0-05: canonicalization collisions blocked by escaping
 *   - Red-team RT-S0-06: wrong key produces different hash (proves HMAC-keyed nature)
 */

import { describe, it, expect } from "vitest";
import {
  hmacRowHash,
  getLastHashFromRows,
  verifyHmacChain,
  canonicalize,
  constantTimeStringEq,
  GENESIS,
  HMAC_HEX_LENGTH,
  type ChainableRow,
} from "./hmac_chain.js";
import { randomBytes } from "node:crypto";

interface TestRow extends ChainableRow {
  event: string;
  actor: string;
  ts:    string;
}

const SECRET = randomBytes(64);
const SECRET2 = randomBytes(64);

function getCanonicalTest(row: TestRow): string {
  return canonicalize([row.event, row.actor, row.ts]);
}

function buildChain(secret: Buffer, count: number): TestRow[] {
  const rows: TestRow[] = [];
  let prev = GENESIS;
  for (let i = 1; i <= count; i++) {
    const row: TestRow = {
      id:        i,
      prev_hash: prev,
      row_hash:  "",
      event:     `event_${i}`,
      actor:     `actor_${i}`,
      ts:        `2026-04-18T00:0${i}:00Z`,
    };
    row.row_hash = hmacRowHash(secret, prev, getCanonicalTest(row));
    prev = row.row_hash;
    rows.push(row);
  }
  return rows;
}

describe("hmac_chain", () => {
  // ── Unit ─────────────────────────────────────────────────────────────────

  it("hmacRowHash produces 64-char hex output", () => {
    const h = hmacRowHash(SECRET, GENESIS, "test|content|here");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h.length).toBe(HMAC_HEX_LENGTH);
  });

  it("hmacRowHash is deterministic for same inputs", () => {
    const a = hmacRowHash(SECRET, "prev", "data");
    const b = hmacRowHash(SECRET, "prev", "data");
    expect(a).toBe(b);
  });

  it("hmacRowHash differs when prev changes", () => {
    const a = hmacRowHash(SECRET, "prev1", "data");
    const b = hmacRowHash(SECRET, "prev2", "data");
    expect(a).not.toBe(b);
  });

  it("hmacRowHash differs when canonical changes", () => {
    const a = hmacRowHash(SECRET, "prev", "data1");
    const b = hmacRowHash(SECRET, "prev", "data2");
    expect(a).not.toBe(b);
  });

  it("hmacRowHash differs when secret changes (proves HMAC keying)", () => {
    const a = hmacRowHash(SECRET,  "prev", "data");
    const b = hmacRowHash(SECRET2, "prev", "data");
    expect(a).not.toBe(b);
  });

  it("getLastHashFromRows returns GENESIS for empty list", () => {
    expect(getLastHashFromRows([])).toBe(GENESIS);
  });

  it("getLastHashFromRows ignores rows with empty row_hash (legacy)", () => {
    const rows = [
      { id: 1, row_hash: "" },
      { id: 2, row_hash: "abc" },
      { id: 3, row_hash: "" },
    ];
    expect(getLastHashFromRows(rows)).toBe("abc");
  });

  it("getLastHashFromRows returns hash of highest id (sorted-aware)", () => {
    const rows = [
      { id: 5, row_hash: "fifth" },
      { id: 2, row_hash: "second" },
      { id: 9, row_hash: "ninth" },
    ];
    expect(getLastHashFromRows(rows)).toBe("ninth");
  });

  it("canonicalize escapes pipe and backslash to prevent collisions", () => {
    const a = canonicalize(["a|b", "c"]);
    const b = canonicalize(["a", "b|c"]);
    expect(a).not.toBe(b);
    expect(a).toBe("a\\|b|c");
    expect(b).toBe("a|b\\|c");
  });

  it("canonicalize handles null/undefined as empty", () => {
    const c = canonicalize(["a", null, undefined, "d"]);
    expect(c).toBe("a|||d");
  });

  it("canonicalize handles numbers + booleans", () => {
    const c = canonicalize(["str", 42, true, false]);
    expect(c).toBe("str|42|true|false");
  });

  it("constantTimeStringEq returns true for equal strings", () => {
    expect(constantTimeStringEq("abc", "abc")).toBe(true);
  });

  it("constantTimeStringEq returns false for different lengths", () => {
    expect(constantTimeStringEq("ab", "abc")).toBe(false);
  });

  it("constantTimeStringEq returns false for different content", () => {
    expect(constantTimeStringEq("abc", "abd")).toBe(false);
  });

  // ── Integration ──────────────────────────────────────────────────────────

  it("builds and verifies a 5-row chain end-to-end", () => {
    const rows = buildChain(SECRET, 5);
    const result = verifyHmacChain(SECRET, rows, getCanonicalTest);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(5);
  });

  it("verifies an empty chain as ok", () => {
    const result = verifyHmacChain(SECRET, [], getCanonicalTest);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(0);
  });

  it("ignores legacy rows with empty row_hash during verification", () => {
    const rows = buildChain(SECRET, 3);
    // Insert a legacy row at id=4 with no hash
    rows.push({ id: 4, prev_hash: "", row_hash: "", event: "legacy", actor: "old", ts: "old" });
    const result = verifyHmacChain(SECRET, rows, getCanonicalTest);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(3);  // legacy row not counted
  });

  it("verifies correctly when rows are passed unsorted", () => {
    const rows = buildChain(SECRET, 4);
    // Shuffle them
    const shuffled = [rows[2], rows[0], rows[3], rows[1]];
    const result = verifyHmacChain(SECRET, shuffled, getCanonicalTest);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(4);
  });

  // ── Red-team ──────────────────────────────────────────────────────────────

  it("[RT-S0-03] detects hash-mismatch tampering (row content changed)", () => {
    const rows = buildChain(SECRET, 5);
    rows[2].event = "TAMPERED!";   // attacker modifies row 3
    // (note: didn't recompute row_hash — that's the point; attacker can't without secret)
    const result = verifyHmacChain(SECRET, rows, getCanonicalTest);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(3);
    expect(result.brokenKind).toBe("hash-mismatch");
  });

  it("[RT-S0-04] detects prev-mismatch tampering (row deleted/inserted)", () => {
    const rows = buildChain(SECRET, 5);
    // Attacker deletes row 3 — chain must break at row 4
    rows.splice(2, 1);
    const result = verifyHmacChain(SECRET, rows, getCanonicalTest);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(4);
    expect(result.brokenKind).toBe("prev-mismatch");
  });

  it("[RT-S0-05] canonicalization collision attack blocked by escaping", () => {
    // Without escaping, ["a|b", "c"] and ["a", "b|c"] would canonicalize identically.
    // With escaping (\\|), they produce DIFFERENT canonical strings → different hashes.
    const h1 = hmacRowHash(SECRET, GENESIS, canonicalize(["a|b", "c"]));
    const h2 = hmacRowHash(SECRET, GENESIS, canonicalize(["a", "b|c"]));
    expect(h1).not.toBe(h2);
  });

  it("[RT-S0-06] wrong key produces different verification result", () => {
    const rows = buildChain(SECRET, 3);
    // Try to verify with WRONG key
    const result = verifyHmacChain(SECRET2, rows, getCanonicalTest);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(1);  // first row already fails to verify
    expect(result.brokenKind).toBe("hash-mismatch");
  });

  it("[RT-S0-07] forged row_hash without secret cannot pass verification", () => {
    const rows = buildChain(SECRET, 3);
    // Attacker without the secret tries to insert a forged row
    rows.push({
      id: 4,
      prev_hash: rows[2].row_hash,
      row_hash: "deadbeef".repeat(8),  // attacker's guess at a valid HMAC
      event: "FORGED",
      actor: "attacker",
      ts: "2026-04-18T00:99:99Z",
    });
    const result = verifyHmacChain(SECRET, rows, getCanonicalTest);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(4);
    expect(result.brokenKind).toBe("hash-mismatch");
  });
});
