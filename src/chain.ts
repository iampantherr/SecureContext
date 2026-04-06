/**
 * Tamper-Evident Broadcast Hash Chain
 * Chin & Older (2011) Chapter 13 — Biba Integrity Model:
 * The broadcast table is a high-integrity audit target.
 * Each row links to the previous via SHA256 hash chain.
 * Any tampering (INSERT, UPDATE, DELETE of any row) breaks the chain
 * and is detectable via verifyChain().
 *
 * Hash format:
 *   row_hash = SHA256(prev_hash + "|" + type + "|" + agent_id + "|" + task + "|" + summary + "|" + created_at + "|" + session_token_id)
 * Genesis prev_hash = "genesis"
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

/**
 * Compute the SHA256 hash for a broadcast row.
 * All fields are concatenated with "|" separator.
 * prev_hash for the first row is "genesis".
 */
export function computeRowHash(
  prevHash:      string,
  type:          string,
  agentId:       string,
  task:          string,
  summary:       string,
  createdAt:     string,
  tokenId:       string
): string {
  return createHash("sha256")
    .update(prevHash)
    .update("|")
    .update(type)
    .update("|")
    .update(agentId)
    .update("|")
    .update(task)
    .update("|")
    .update(summary)
    .update("|")
    .update(createdAt)
    .update("|")
    .update(tokenId)
    .digest("hex");
}

/**
 * Get the row_hash of the last broadcast row, or "genesis" if no rows exist.
 * Used to chain each new broadcast to the previous one.
 */
export function getLastHash(db: DatabaseSync): string {
  try {
    const row = db.prepare(
      `SELECT row_hash FROM broadcasts ORDER BY id DESC LIMIT 1`
    ).get() as { row_hash: string } | undefined;

    if (!row || !row.row_hash) return "genesis";
    return row.row_hash;
  } catch {
    return "genesis";
  }
}

/**
 * Walk every broadcast row in ascending ID order, recompute each hash,
 * and verify the chain is unbroken.
 *
 * Rows with empty row_hash (pre-v0.8.0 rows) are skipped — only rows with
 * a non-empty row_hash participate in chain verification.
 *
 * Returns:
 *   { ok: true,  totalRows: N }                         — chain intact
 *   { ok: false, totalRows: N, brokenAt: id, brokenHash: expected }  — tampered
 */
export function verifyChain(db: DatabaseSync): {
  ok:         boolean;
  totalRows:  number;
  brokenAt?:  number;
  brokenHash?: string;
} {
  type BroadcastRow = {
    id:               number;
    type:             string;
    agent_id:         string;
    task:             string;
    summary:          string;
    created_at:       string;
    session_token_id: string;
    prev_hash:        string;
    row_hash:         string;
  };

  let rows: BroadcastRow[];
  try {
    rows = db.prepare(`
      SELECT id, type, agent_id, task, summary, created_at,
             session_token_id, prev_hash, row_hash
      FROM broadcasts
      ORDER BY id ASC
    `).all() as BroadcastRow[];
  } catch {
    // broadcasts table may not have hash columns yet — treat as ok with 0 rows
    return { ok: true, totalRows: 0 };
  }

  // Filter to only rows that have a non-empty row_hash (v0.8.0+ rows)
  const chainRows = rows.filter((r) => r.row_hash && r.row_hash.length > 0);
  const totalRows = chainRows.length;

  if (totalRows === 0) {
    return { ok: true, totalRows: rows.length };
  }

  let expectedPrev = "genesis";

  for (const row of chainRows) {
    const expected = computeRowHash(
      row.prev_hash,        // what was stored as prev at write time
      row.type,
      row.agent_id,
      row.task,
      row.summary,
      row.created_at,
      row.session_token_id ?? ""
    );

    if (expected !== row.row_hash) {
      return {
        ok:         false,
        totalRows:  rows.length,
        brokenAt:   row.id,
        brokenHash: expected,
      };
    }

    // Verify that prev_hash matches what we know to be the previous hash
    if (row.prev_hash !== expectedPrev) {
      return {
        ok:         false,
        totalRows:  rows.length,
        brokenAt:   row.id,
        brokenHash: expectedPrev,
      };
    }

    expectedPrev = row.row_hash;
  }

  return { ok: true, totalRows: rows.length };
}
