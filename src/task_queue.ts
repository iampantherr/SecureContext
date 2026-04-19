/**
 * Work-stealing task queue (v0.17.0 §8.2 — Sprint 3 Phase 3)
 * ============================================================
 *
 * Postgres-backed work queue using `FOR UPDATE SKIP LOCKED` semantics so
 * 5+ concurrent workers can claim tasks atomically without blocking each
 * other. Mirrors the reference design in HARNESS_EVOLUTION_PLAN.md §8.2.
 *
 * LIFECYCLE:
 *   enqueue   → state='queued', payload=ASSIGN broadcast body
 *   claim     → state='claimed', claimed_by=worker_id, claimed_at=now,
 *                heartbeat_at=now (atomic via SKIP LOCKED)
 *   heartbeat → heartbeat_at=now (workers must call every 30s)
 *   complete  → state='done',   done_at=now
 *   fail      → state='failed', failure_reason=<msg>, retries++
 *   reclaim   → workers stale > 5min → state back to 'queued' for retry
 *
 * INVARIANTS:
 *   - Each task claimed by exactly one worker
 *   - SKIP LOCKED ensures workers don't block on each other
 *   - Stale claims (heartbeat > 5min ago) become reclaimable
 *
 * RT-S4-* tests:
 *   RT-S4-01: 50 workers race to claim 100 tasks; each task claimed
 *             exactly once; total claimed = 100, no double-claim
 *   RT-S4-02: stale heartbeat reclaim returns task to queue
 *   RT-S4-03: failed task retains retry count for backoff logic
 */

import type { PoolClient } from "pg";
import { withClient, withTransaction } from "./pg_pool.js";
import { logger } from "./logger.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type TaskState = "queued" | "claimed" | "done" | "failed";

export interface TaskRow {
  task_id:        string;
  project_hash:   string;
  role:           string;
  payload:        Record<string, unknown>;
  state:          TaskState;
  claimed_by:     string | null;
  claimed_at:     Date | null;
  heartbeat_at:   Date | null;
  retries:        number;
  ts:             Date;
  done_at:        Date | null;
  failure_reason: string | null;
}

export interface EnqueueInput {
  taskId:       string;
  projectHash:  string;
  role:         string;
  payload:      Record<string, unknown>;
}

export interface ClaimResult {
  taskId:  string;
  payload: Record<string, unknown>;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Add a task to the queue. Idempotent: if `taskId` already exists, no-op.
 * Returns true if newly inserted, false if already present.
 */
export async function enqueueTask(input: EnqueueInput): Promise<boolean> {
  return withClient(async (c: PoolClient) => {
    const r = await c.query<{ inserted: boolean }>(`
      INSERT INTO task_queue_pg (task_id, project_hash, role, payload, state)
      VALUES ($1, $2, $3, $4::jsonb, 'queued')
      ON CONFLICT (task_id) DO NOTHING
      RETURNING true AS inserted
    `, [input.taskId, input.projectHash, input.role, JSON.stringify(input.payload)]);
    return r.rows.length > 0;
  });
}

/**
 * Atomically claim the oldest queued task matching `(projectHash, role)`.
 * Returns null if no claimable tasks. Multiple workers can call concurrently
 * — Postgres `SKIP LOCKED` ensures each worker gets a distinct task.
 *
 * The claimed task's heartbeat is set to NOW(); the worker MUST call
 * `heartbeat()` every 30s or the task becomes reclaimable after 5min.
 */
export async function claimTask(
  projectHash: string,
  role:        string,
  workerId:    string,
): Promise<ClaimResult | null> {
  return withTransaction(async (c: PoolClient) => {
    // The atomic claim: find oldest queued task in scope, lock it, update
    // to claimed. SKIP LOCKED makes concurrent claimers see different rows.
    const r = await c.query<{ task_id: string; payload: Record<string, unknown> }>(`
      UPDATE task_queue_pg SET
        state         = 'claimed',
        claimed_by    = $3,
        claimed_at    = NOW(),
        heartbeat_at  = NOW()
      WHERE task_id = (
        SELECT task_id FROM task_queue_pg
        WHERE project_hash = $1 AND role = $2 AND state = 'queued'
        ORDER BY ts ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING task_id, payload
    `, [projectHash, role, workerId]);
    if (r.rows.length === 0) return null;
    return { taskId: r.rows[0].task_id, payload: r.rows[0].payload };
  });
}

/**
 * Refresh the heartbeat on a claimed task. Workers MUST call this every
 * 30 seconds while processing — otherwise the reclaim sweep will move
 * the task back to 'queued' after 5 minutes of silence.
 *
 * Returns true if the heartbeat was accepted (worker still owns the task);
 * false if the task is no longer claimed by this worker (stolen by reclaim).
 */
export async function heartbeatTask(taskId: string, workerId: string): Promise<boolean> {
  return withClient(async (c: PoolClient) => {
    const r = await c.query(`
      UPDATE task_queue_pg
      SET heartbeat_at = NOW()
      WHERE task_id = $1 AND state = 'claimed' AND claimed_by = $2
    `, [taskId, workerId]);
    return (r.rowCount ?? 0) > 0;
  });
}

/** Mark a claimed task as done. Idempotent. */
export async function completeTask(taskId: string, workerId: string): Promise<boolean> {
  return withClient(async (c: PoolClient) => {
    const r = await c.query(`
      UPDATE task_queue_pg
      SET state = 'done', done_at = NOW()
      WHERE task_id = $1 AND claimed_by = $2 AND state = 'claimed'
    `, [taskId, workerId]);
    return (r.rowCount ?? 0) > 0;
  });
}

/**
 * Mark a claimed task as failed. Bumps retry counter so a backoff layer
 * can decide whether to re-enqueue.
 */
export async function failTask(
  taskId:   string,
  workerId: string,
  reason:   string,
): Promise<boolean> {
  return withClient(async (c: PoolClient) => {
    const r = await c.query(`
      UPDATE task_queue_pg
      SET state           = 'failed',
          failure_reason  = $3,
          retries         = retries + 1
      WHERE task_id = $1 AND claimed_by = $2 AND state = 'claimed'
    `, [taskId, workerId, reason.slice(0, 1000)]);
    return (r.rowCount ?? 0) > 0;
  });
}

/**
 * Sweep stale claims back to 'queued'. Tasks whose `heartbeat_at` is older
 * than `staleAfterSeconds` (default 300 = 5min) are reclaimed.
 *
 * Returns the count of tasks reclaimed. Call from a periodic cron / loop.
 */
export async function reclaimStaleTasks(
  staleAfterSeconds: number = 300,
): Promise<number> {
  return withClient(async (c: PoolClient) => {
    const r = await c.query(`
      UPDATE task_queue_pg
      SET state         = 'queued',
          claimed_by    = NULL,
          claimed_at    = NULL,
          heartbeat_at  = NULL,
          retries       = retries + 1
      WHERE state = 'claimed'
        AND heartbeat_at < NOW() - ($1 || ' seconds')::interval
    `, [String(staleAfterSeconds)]);
    const n = r.rowCount ?? 0;
    if (n > 0) logger.info("tasks", "reclaimed_stale", { count: n, threshold_seconds: staleAfterSeconds });
    return n;
  });
}

/** Inspect the queue (for the dashboard / debugging). */
export async function getQueueStats(projectHash?: string): Promise<{
  queued: number; claimed: number; done: number; failed: number;
}> {
  return withClient(async (c: PoolClient) => {
    const where = projectHash ? `WHERE project_hash = $1` : ``;
    const params = projectHash ? [projectHash] : [];
    const r = await c.query<{ state: string; n: string }>(
      `SELECT state, COUNT(*) AS n FROM task_queue_pg ${where} GROUP BY state`,
      params,
    );
    const out = { queued: 0, claimed: 0, done: 0, failed: 0 };
    for (const row of r.rows) {
      const k = row.state as keyof typeof out;
      if (k in out) out[k] = Number(row.n);
    }
    return out;
  });
}

/** Lookup a single task by id (for diagnostics). */
export async function getTask(taskId: string): Promise<TaskRow | null> {
  return withClient(async (c: PoolClient) => {
    const r = await c.query<TaskRow>(`SELECT * FROM task_queue_pg WHERE task_id = $1`, [taskId]);
    return r.rows[0] ?? null;
  });
}

/** Test helper: drop the queue table AND its migration marker so it re-applies. */
export async function _dropTaskQueueForTesting(): Promise<void> {
  await withClient(async (c) => {
    await c.query(`DROP TABLE IF EXISTS task_queue_pg CASCADE`);
    // Remove migration marker so runPgMigrations re-applies migration id=5.
    // Without this, a prior run's migration record would cause re-migration
    // to no-op and the table would stay dropped.
    await c.query(`DELETE FROM schema_migrations_pg WHERE id = 5`).catch(() => { /* table may not exist yet */ });
  });
}
