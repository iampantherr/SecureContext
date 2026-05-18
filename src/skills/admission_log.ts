/**
 * v0.26.0 Step 6 — Skill admission log: HMAC-chained tamper-evident record of
 * every admission decision (admit, update, quarantine, parse-error).
 *
 * THREE-LINE DEFENSE:
 *
 *   Line 1 — skill_admission_log_pg row, HMAC-keyed with machine_secret.
 *            Attacker with DB write access cannot insert or modify a row
 *            without breaking the row_hash check.
 *
 *   Line 2 — ~/.claude/zc-ctx/logs/audit.log JSONL anchor. Every PG row is
 *            also written as a one-line JSON record to the host audit log,
 *            outside the DB. If an attacker deletes/modifies the PG row
 *            entirely, the audit.log line still attests to its existence.
 *
 *   Line 3 — chain VERIFY endpoint walks both stores and reports any
 *            mismatch between (a) DB chain integrity, (b) audit.log
 *            entries, and (c) the canonical content.
 *
 * USAGE:
 *
 *   import { recordAdmissionEvent, verifyAdmissionChain } from "./admission_log.js";
 *
 *   await recordAdmissionEvent({
 *     event: "admitted",
 *     skill_name: "learn-from-youtube",
 *     skill_version: "1.0.0",
 *     skill_scope: "global",
 *     skill_dir: "/home/.../skills/learn-from-youtube",
 *     body_hmac: "...",
 *     script_count: 1,
 *     quarantined: false,
 *     reason: null,
 *   });
 *
 *   const result = await verifyAdmissionChain();
 *   if (!result.ok) console.error("CHAIN BROKEN at id", result.brokenAt);
 *
 * The canonical row layout is FROZEN. Any change to the canonical fields will
 * invalidate every existing chain — add new fields via a new migration if
 * needed, do NOT mutate the canonical encoding.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { withClient } from "../pg_pool.js";
import { logger } from "../logger.js";
import { getMachineSecret } from "../security/machine_secret.js";
import { hmacRowHash, getLastHashFromRows, verifyHmacChain, canonicalize, type ChainableRow, type VerifyResult } from "../security/hmac_chain.js";

export type AdmissionEvent =
  | "admitted"
  | "updated"
  | "quarantined_scan"
  | "quarantined_frontmatter"
  | "parse_error"
  | "skipped_idempotent";

export interface AdmissionLogEntry {
  event:         AdmissionEvent;
  skill_name:    string;
  skill_version: string | null;
  skill_scope:   string | null;
  skill_dir:     string;
  body_hmac:     string | null;
  script_count:  number;
  quarantined:   boolean;
  reason:        string | null;
}

interface AdmissionLogRow extends ChainableRow {
  ts:            string;
  event:         AdmissionEvent;
  skill_name:    string;
  skill_version: string | null;
  skill_scope:   string | null;
  skill_dir:     string;
  body_hmac:     string | null;
  script_count:  number;
  quarantined:   boolean;
  reason:        string | null;
}

/** Canonical encoding — FROZEN. Field order must never change. */
function canonicalForEntry(row: {
  ts: string; event: string; skill_name: string; skill_version: string | null;
  skill_scope: string | null; skill_dir: string; body_hmac: string | null;
  script_count: number; quarantined: boolean; reason: string | null;
}): string {
  return canonicalize([
    "skill_admission_log",                  // table identity
    row.ts,
    row.event,
    row.skill_name,
    row.skill_version,
    row.skill_scope,
    row.skill_dir,
    row.body_hmac,
    row.script_count,
    row.quarantined,
    row.reason,
  ]);
}

/** External audit-log anchor: append one JSONL line per admission row. */
function writeAuditLogAnchor(row: AdmissionLogRow): void {
  try {
    const logDir = join(homedir(), ".claude", "zc-ctx", "logs");
    mkdirSync(logDir, { recursive: true });
    const line = JSON.stringify({
      anchor:     "skill_admission_log",
      id:         row.id,
      ts:         row.ts,
      event:      row.event,
      skill:      row.skill_name,
      version:    row.skill_version,
      scope:      row.skill_scope,
      skill_dir:  row.skill_dir,
      body_hmac:  row.body_hmac,
      scripts:    row.script_count,
      quarantined: row.quarantined,
      reason:     row.reason,
      prev_hash:  row.prev_hash,
      row_hash:   row.row_hash,
    });
    appendFileSync(join(logDir, "audit.log"), line + "\n");
  } catch (e) {
    logger.warn("skills", "audit_log_anchor_write_failed", { error: (e as Error).message });
  }
}

/**
 * Record one admission event. Performs the INSERT inside a transaction so
 * prev_hash + row_hash are computed atomically against the latest chain tail.
 *
 * After commit, writes the audit.log anchor (best-effort — failure is logged
 * but not fatal because the DB is the canonical truth).
 */
export async function recordAdmissionEvent(entry: AdmissionLogEntry): Promise<void> {
  try {
    const secret = getMachineSecret();
    const ts = new Date().toISOString();
    const writtenRow = await withClient(async (c) => {
      // Acquire latest chain tail under an advisory lock so two concurrent
      // admission events don't both grab the same prev_hash.
      // Use a fixed lock id (arbitrary 64-bit int) for this chain.
      await c.query(`SELECT pg_advisory_xact_lock(0x736B696C61646D69 :: bigint)`);
      const tailRes = await c.query<{ id: number; row_hash: string }>(
        `SELECT id, row_hash FROM skill_admission_log_pg ORDER BY id DESC LIMIT 1`,
      );
      const prevHash = tailRes.rows.length > 0
        ? getLastHashFromRows(tailRes.rows.map((r) => ({ id: r.id, row_hash: r.row_hash })))
        : "genesis";
      const canonical = canonicalForEntry({
        ts,
        event:         entry.event,
        skill_name:    entry.skill_name,
        skill_version: entry.skill_version,
        skill_scope:   entry.skill_scope,
        skill_dir:     entry.skill_dir,
        body_hmac:     entry.body_hmac,
        script_count:  entry.script_count,
        quarantined:   entry.quarantined,
        reason:        entry.reason,
      });
      const rowHash = hmacRowHash(secret, prevHash, canonical);
      const ins = await c.query<{ id: number }>(
        `INSERT INTO skill_admission_log_pg
            (ts, event, skill_name, skill_version, skill_scope, skill_dir,
             body_hmac, script_count, quarantined, reason, prev_hash, row_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          ts, entry.event, entry.skill_name, entry.skill_version, entry.skill_scope,
          entry.skill_dir, entry.body_hmac, entry.script_count, entry.quarantined,
          entry.reason, prevHash, rowHash,
        ],
      );
      const inserted: AdmissionLogRow = {
        id:            ins.rows[0].id,
        ts,
        event:         entry.event,
        skill_name:    entry.skill_name,
        skill_version: entry.skill_version,
        skill_scope:   entry.skill_scope,
        skill_dir:     entry.skill_dir,
        body_hmac:     entry.body_hmac,
        script_count:  entry.script_count,
        quarantined:   entry.quarantined,
        reason:        entry.reason,
        prev_hash:     prevHash,
        row_hash:      rowHash,
      };
      return inserted;
    });
    writeAuditLogAnchor(writtenRow);
  } catch (e) {
    // Don't break the import flow over an audit-log failure, but DO log it loud.
    logger.error("skills", "admission_log_write_failed", {
      event: entry.event, skill: entry.skill_name, error: (e as Error).message,
    });
  }
}

/**
 * Verify the entire admission chain. Walks every row in order, recomputes the
 * HMAC, and ensures prev_hash linkage is intact. Returns VerifyResult from the
 * shared hmac_chain primitive.
 */
export async function verifyAdmissionChain(): Promise<VerifyResult> {
  const secret = getMachineSecret();
  const rows = await withClient(async (c) => {
    const r = await c.query<AdmissionLogRow>(
      `SELECT id, ts, event, skill_name, skill_version, skill_scope, skill_dir,
              body_hmac, script_count, quarantined, reason, prev_hash, row_hash
         FROM skill_admission_log_pg
         ORDER BY id ASC`,
    );
    return r.rows;
  });
  return verifyHmacChain(secret, rows, (row) => canonicalForEntry({
    ts:            typeof row.ts === "string" ? row.ts : new Date(row.ts).toISOString(),
    event:         row.event,
    skill_name:    row.skill_name,
    skill_version: row.skill_version,
    skill_scope:   row.skill_scope,
    skill_dir:     row.skill_dir,
    body_hmac:     row.body_hmac,
    script_count:  row.script_count,
    quarantined:   row.quarantined,
    reason:        row.reason,
  }));
}
