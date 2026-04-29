/**
 * Skill promotion queue (v0.18.1 Sprint 2.5)
 * ==========================================
 *
 * Backend-aware CRUD for `skill_promotion_queue` (SQLite) +
 * `skill_promotion_queue_pg` (PG mirror). The L2 of the two-tier
 * improvement loop:
 *
 *   - Nightly cron (or manual operator action) inserts candidates with
 *     status='pending' via `enqueuePromotion`
 *   - Operator lists via `listPending` and decides via `approve` /
 *     `reject` — both are auditable + persisted with rationale
 *   - Approval atomically performs the export+import to global scope
 *     (caller's responsibility — this module just records the decision)
 */

import type { DatabaseSync } from "node:sqlite";
import { withClient } from "../pg_pool.js";

export type PromotionStatus = "pending" | "approved" | "rejected" | "superseded";

export interface PromotionEntry {
  candidate_skill_id:  string;
  proposed_target:     string;          // 'global' | 'project:<hash>'
  surfaced_at:         string;
  surfaced_by:         "cron" | "manual";
  best_avg:            number | null;
  global_avg:          number | null;
  project_count:       number | null;
  status:              PromotionStatus;
  decided_at:          string | null;
  decided_by:          string | null;
  decision_rationale:  string | null;
}

function getBackend(): "sqlite" | "postgres" | "dual" {
  const raw = (process.env.ZC_TELEMETRY_BACKEND || "sqlite").toLowerCase();
  return (raw === "postgres" || raw === "dual") ? raw : "sqlite";
}

// ─── SQLite ──────────────────────────────────────────────────────────────────

function rowToEntry(row: Record<string, unknown>): PromotionEntry {
  return {
    candidate_skill_id:  row.candidate_skill_id as string,
    proposed_target:     row.proposed_target    as string,
    surfaced_at:         (row.surfaced_at instanceof Date ? row.surfaced_at.toISOString() : row.surfaced_at as string),
    surfaced_by:         row.surfaced_by as "cron" | "manual",
    best_avg:            row.best_avg      === null ? null : Number(row.best_avg),
    global_avg:          row.global_avg    === null ? null : Number(row.global_avg),
    project_count:       row.project_count === null ? null : Number(row.project_count),
    status:              row.status as PromotionStatus,
    decided_at:          row.decided_at instanceof Date ? row.decided_at.toISOString() : ((row.decided_at as string) ?? null),
    decided_by:          (row.decided_by as string) ?? null,
    decision_rationale:  (row.decision_rationale as string) ?? null,
  };
}

// ─── enqueuePromotion ────────────────────────────────────────────────────────

export async function enqueuePromotion(
  db: DatabaseSync,
  entry: Omit<PromotionEntry, "status" | "decided_at" | "decided_by" | "decision_rationale" | "surfaced_at"> & { surfaced_at?: string },
): Promise<{ inserted: boolean }> {
  const backend = getBackend();
  const surfaced_at = entry.surfaced_at ?? new Date().toISOString();
  let inserted_pg = false;
  let inserted_sqlite = false;

  if (backend === "postgres" || backend === "dual") {
    try {
      const r = await withClient(async (c) => {
        const res = await c.query<{ inserted: boolean }>(
          `INSERT INTO skill_promotion_queue_pg
            (candidate_skill_id, proposed_target, surfaced_at, surfaced_by, best_avg, global_avg, project_count, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
           ON CONFLICT (candidate_skill_id, proposed_target) DO NOTHING
           RETURNING true AS inserted`,
          [entry.candidate_skill_id, entry.proposed_target, surfaced_at, entry.surfaced_by,
           entry.best_avg, entry.global_avg, entry.project_count],
        );
        return res.rows.length > 0;
      });
      inserted_pg = r;
      if (backend === "postgres") return { inserted: inserted_pg };
    } catch {
      if (backend === "postgres") return { inserted: false };
      // dual: fall through to SQLite
    }
  }

  // SQLite path (sqlite OR dual)
  const r = db.prepare(`
    INSERT OR IGNORE INTO skill_promotion_queue
      (candidate_skill_id, proposed_target, surfaced_at, surfaced_by, best_avg, global_avg, project_count, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    entry.candidate_skill_id, entry.proposed_target, surfaced_at, entry.surfaced_by,
    entry.best_avg, entry.global_avg, entry.project_count,
  );
  inserted_sqlite = (r.changes ?? 0) > 0;

  return { inserted: inserted_pg || inserted_sqlite };
}

// ─── listPending ─────────────────────────────────────────────────────────────

export async function listPending(db: DatabaseSync): Promise<PromotionEntry[]> {
  const backend = getBackend();
  if (backend === "postgres" || backend === "dual") {
    try {
      const rows = await withClient(async (c) => {
        const res = await c.query<Record<string, unknown>>(
          `SELECT * FROM skill_promotion_queue_pg WHERE status = 'pending' ORDER BY surfaced_at DESC`,
        );
        return res.rows;
      });
      return rows.map(rowToEntry);
    } catch {
      if (backend === "postgres") return [];
    }
  }
  const rows = db.prepare(
    `SELECT * FROM skill_promotion_queue WHERE status = 'pending' ORDER BY surfaced_at DESC`
  ).all() as Array<Record<string, unknown>>;
  return rows.map(rowToEntry);
}

// ─── approve / reject ────────────────────────────────────────────────────────

export async function decide(
  db: DatabaseSync,
  candidate_skill_id: string,
  decision: "approved" | "rejected",
  decided_by: string,
  rationale: string,
  proposed_target: string = "global",
): Promise<boolean> {
  const backend = getBackend();
  const decided_at = new Date().toISOString();

  let any_changed = false;

  if (backend === "postgres" || backend === "dual") {
    try {
      const r = await withClient(async (c) => {
        const res = await c.query(
          `UPDATE skill_promotion_queue_pg
             SET status = $1, decided_at = $2, decided_by = $3, decision_rationale = $4
           WHERE candidate_skill_id = $5 AND proposed_target = $6 AND status = 'pending'`,
          [decision, decided_at, decided_by, rationale, candidate_skill_id, proposed_target],
        );
        return (res.rowCount ?? 0) > 0;
      });
      any_changed = any_changed || r;
      if (backend === "postgres") return r;
    } catch {
      if (backend === "postgres") return false;
    }
  }
  const r = db.prepare(`
    UPDATE skill_promotion_queue
       SET status = ?, decided_at = ?, decided_by = ?, decision_rationale = ?
     WHERE candidate_skill_id = ? AND proposed_target = ? AND status = 'pending'
  `).run(decision, decided_at, decided_by, rationale, candidate_skill_id, proposed_target);
  return any_changed || ((r.changes ?? 0) > 0);
}

/** Convenience aliases for the operator-facing tool dispatch. */
export const approvePromotion = (db: DatabaseSync, id: string, by: string, rationale: string, target: string = "global") =>
  decide(db, id, "approved", by, rationale, target);
export const rejectPromotion  = (db: DatabaseSync, id: string, by: string, rationale: string, target: string = "global") =>
  decide(db, id, "rejected", by, rationale, target);

// ─── Test helper ─────────────────────────────────────────────────────────────

export async function _dropPromotionQueueForTesting(): Promise<void> {
  await withClient(async (c) => {
    await c.query(`DROP TABLE IF EXISTS skill_promotion_queue_pg CASCADE`);
    await c.query(`DELETE FROM schema_migrations_pg WHERE id = 9`);
  });
}
