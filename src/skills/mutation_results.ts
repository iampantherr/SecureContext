/**
 * Mutation results side-channel (v0.18.1 Sprint 2.5 — option-b architecture)
 * ===========================================================================
 *
 * Why this exists
 * ---------------
 * Mutation candidate bodies (5 markdown documents per result, each potentially
 * many KB of carefully-reasoned skill content) are too large to put in
 * `broadcasts.summary` — that column is hard-capped at 1000 chars by the
 * sanitize layer. Storing them inline would also bloat every
 * `zc_recall_context` call (broadcasts are read on every recall) and break
 * SecureContext's "small structured signals; raw content stays out of context"
 * design.
 *
 * Architecture
 * ------------
 * The body of the result lives **here** (`mutation_results` / `_pg`). The
 * broadcast carries only a tiny **pointer**:
 *
 *     {
 *       mutation_id: "mut-<uuid>",
 *       result_id:   "mres-<uuid>",      // PK in this table
 *       bodies_hash: "sha256:<hex>",     // tamper-evidence
 *       headline:    "5 candidates, best=0.91, all fixtures pass"
 *     }
 *
 * The hash is SHA-256 over a canonical JSON serialization of the candidate
 * bodies array. Consumers re-derive the hash on read and compare; mismatch
 * means the side-channel row was tampered with after announcement.
 *
 * Pattern reuse
 * -------------
 * Same pattern as how the PostBash hook archives big tool_outputs to KB and
 * stores only a pointer. Naturally extensible to other large-payload result
 * types (replay outputs, evaluator reports, large diffs).
 *
 * Backends
 * --------
 * Works on **SQLite, local PG, docker PG, RDS, Supabase** — uses standard
 * PG types only (no extensions). Honors ZC_TELEMETRY_BACKEND like the rest
 * of the dual-backend story (sqlite | postgres | dual).
 */

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withClient } from "../pg_pool.js";

export interface MutationCandidate {
  candidate_body:    string;
  rationale:         string;
  self_rated_score:  number;
}

export interface MutationResultRow {
  result_id:        string;
  mutation_id:      string;
  skill_id:         string;
  project_hash:     string;
  proposer_model:   string | null;
  proposer_role:    string | null;
  candidate_count:  number;
  best_score:       number | null;
  bodies:           MutationCandidate[];
  bodies_hash:      string;
  headline:         string | null;
  created_at:       string;
  consumed_at:      string | null;
  consumed_by:      string | null;
  // v0.18.2 Sprint 2.6 — operator review + auto-reassign context
  original_task_id:        string | null;
  original_role:           string | null;
  consumed_decision:       "approved" | "rejected" | null;
  picked_candidate_index:  number | null;
}

export interface RecordMutationResultInput {
  mutation_id:      string;
  skill_id:         string;
  project_hash:     string;
  proposer_model?:  string;
  proposer_role?:   string;
  bodies:           MutationCandidate[];
  headline?:        string;
  // v0.18.2 Sprint 2.6 — captured at L1 trigger time so the approval flow
  // can auto-enqueue a retry task addressed to the same role/task lineage.
  original_task_id?: string;
  original_role?:    string;
}

export interface MutationResultPointer {
  result_id:    string;
  mutation_id:  string;
  bodies_hash:  string;
  headline:     string | null;
}

function getBackend(): "sqlite" | "postgres" | "dual" {
  const raw = (process.env.ZC_TELEMETRY_BACKEND || "sqlite").toLowerCase();
  return (raw === "postgres" || raw === "dual") ? raw : "sqlite";
}

/**
 * Canonical bodies JSON for hashing. Stable key order so the hash is
 * deterministic across re-encodings (different runtime / library versions
 * shouldn't change the hash).
 */
export function canonicalizeBodies(bodies: MutationCandidate[]): string {
  return JSON.stringify(
    bodies.map((c) => ({
      candidate_body:   c.candidate_body,
      rationale:        c.rationale,
      self_rated_score: c.self_rated_score,
    })),
  );
}

export function hashBodies(bodies: MutationCandidate[]): string {
  const json = canonicalizeBodies(bodies);
  return "sha256:" + createHash("sha256").update(json).digest("hex");
}

function newResultId(): string {
  return "mres-" + randomUUID().slice(0, 12);
}

function computeBestScore(bodies: MutationCandidate[]): number | null {
  if (!bodies.length) return null;
  let best = -Infinity;
  for (const c of bodies) {
    const s = Number(c.self_rated_score);
    if (Number.isFinite(s) && s > best) best = s;
  }
  return Number.isFinite(best) ? best : null;
}

function rowToResult(row: Record<string, unknown>): MutationResultRow {
  const bodiesRaw = row.bodies as string;
  let bodies: MutationCandidate[] = [];
  try { bodies = JSON.parse(bodiesRaw) as MutationCandidate[]; } catch { bodies = []; }
  return {
    result_id:       row.result_id       as string,
    mutation_id:     row.mutation_id     as string,
    skill_id:        row.skill_id        as string,
    project_hash:    row.project_hash    as string,
    proposer_model:  (row.proposer_model as string) ?? null,
    proposer_role:   (row.proposer_role  as string) ?? null,
    candidate_count: Number(row.candidate_count),
    best_score:      row.best_score === null || row.best_score === undefined ? null : Number(row.best_score),
    bodies,
    bodies_hash:     row.bodies_hash as string,
    headline:        (row.headline as string) ?? null,
    created_at:      row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at as string,
    consumed_at:     row.consumed_at instanceof Date ? row.consumed_at.toISOString() : ((row.consumed_at as string) ?? null),
    consumed_by:     (row.consumed_by as string) ?? null,
    original_task_id:        (row.original_task_id  as string) ?? null,
    original_role:           (row.original_role     as string) ?? null,
    consumed_decision:       (row.consumed_decision as "approved" | "rejected" | null) ?? null,
    picked_candidate_index:  row.picked_candidate_index === null || row.picked_candidate_index === undefined
      ? null : Number(row.picked_candidate_index),
  };
}

// ─── recordMutationResult ────────────────────────────────────────────────────

/**
 * Persist a mutation result and return a tamper-evident pointer.
 *
 * Side effects:
 *   - INSERTs a row into `mutation_results` (and `_pg` in dual mode)
 *   - bodies_hash is computed deterministically from canonical JSON
 *
 * The returned pointer is what the caller should put in the broadcast
 * `summary` field.
 */
export async function recordMutationResult(
  db: DatabaseSync,
  input: RecordMutationResultInput,
): Promise<MutationResultPointer> {
  const backend         = getBackend();
  const result_id       = newResultId();
  const created_at      = new Date().toISOString();
  const candidate_count = input.bodies.length;
  const best_score      = computeBestScore(input.bodies);
  const bodies_json     = canonicalizeBodies(input.bodies);
  const bodies_hash     = hashBodies(input.bodies);
  const headline        = input.headline ?? defaultHeadline(input.bodies, best_score);

  if (backend === "postgres" || backend === "dual") {
    try {
      await withClient(async (c) => {
        await c.query(
          `INSERT INTO mutation_results_pg
            (result_id, mutation_id, skill_id, project_hash, proposer_model,
             proposer_role, candidate_count, best_score, bodies, bodies_hash,
             headline, created_at, original_task_id, original_role)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (result_id) DO NOTHING`,
          [
            result_id, input.mutation_id, input.skill_id, input.project_hash,
            input.proposer_model ?? null, input.proposer_role ?? null,
            candidate_count, best_score, bodies_json, bodies_hash,
            headline, created_at,
            input.original_task_id ?? null, input.original_role ?? null,
          ],
        );
      });
      if (backend === "postgres") {
        return { result_id, mutation_id: input.mutation_id, bodies_hash, headline };
      }
    } catch {
      // dual: fall through to SQLite so we still persist locally
    }
  }

  // SQLite path (sqlite OR dual fallback after PG)
  db.prepare(`
    INSERT OR IGNORE INTO mutation_results
      (result_id, mutation_id, skill_id, project_hash, proposer_model,
       proposer_role, candidate_count, best_score, bodies, bodies_hash,
       headline, created_at, original_task_id, original_role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    result_id, input.mutation_id, input.skill_id, input.project_hash,
    input.proposer_model ?? null, input.proposer_role ?? null,
    candidate_count, best_score, bodies_json, bodies_hash,
    headline, created_at,
    input.original_task_id ?? null, input.original_role ?? null,
  );

  return { result_id, mutation_id: input.mutation_id, bodies_hash, headline };
}

// ─── listPending / approveMutation / rejectMutation (Sprint 2.6) ──────────────

/**
 * List mutation_results awaiting operator review (consumed_at IS NULL) for
 * a specific project. Used by the operator dashboard + zc_mutation_pending.
 */
export async function listPendingForProject(
  db: DatabaseSync,
  project_hash: string,
  limit = 20,
): Promise<MutationResultRow[]> {
  const backend = getBackend();
  let rows: Array<Record<string, unknown>> = [];
  if (backend === "postgres" || backend === "dual") {
    try {
      rows = await withClient(async (c) => {
        const res = await c.query<Record<string, unknown>>(
          `SELECT * FROM mutation_results_pg
            WHERE project_hash = $1 AND consumed_at IS NULL
            ORDER BY created_at DESC LIMIT $2`,
          [project_hash, limit],
        );
        return res.rows;
      });
      if (backend === "postgres") return rows.filter((r) => verifyHash(r)).map(rowToResult);
    } catch {
      if (backend === "postgres") return [];
    }
  }
  if (rows.length === 0) {
    rows = db.prepare(
      `SELECT * FROM mutation_results
        WHERE project_hash = ? AND consumed_at IS NULL
        ORDER BY created_at DESC LIMIT ?`,
    ).all(project_hash, limit) as Array<Record<string, unknown>>;
  }
  return rows.filter((r) => verifyHash(r)).map(rowToResult);
}

function verifyHash(row: Record<string, unknown>): boolean {
  try {
    const bodies = JSON.parse(row.bodies as string) as MutationCandidate[];
    return hashBodies(bodies) === (row.bodies_hash as string);
  } catch { return false; }
}

/**
 * Atomically mark a mutation_result approved with the picked candidate index +
 * rationale. Caller is responsible for actually upserting the new skill version
 * (this just records the operator decision).
 *
 * Returns false if the row doesn't exist or was already consumed.
 */
export async function approveMutation(
  db: DatabaseSync,
  result_id: string,
  picked_candidate_index: number,
  rationale: string,
  decided_by: string,
): Promise<boolean> {
  return _decideMutation(db, result_id, "approved", decided_by, rationale, picked_candidate_index);
}

export async function rejectMutation(
  db: DatabaseSync,
  result_id: string,
  rationale: string,
  decided_by: string,
): Promise<boolean> {
  return _decideMutation(db, result_id, "rejected", decided_by, rationale, null);
}

async function _decideMutation(
  db: DatabaseSync,
  result_id: string,
  decision: "approved" | "rejected",
  decided_by: string,
  rationale: string,
  picked_candidate_index: number | null,
): Promise<boolean> {
  const backend = getBackend();
  const decided_at = new Date().toISOString();
  // Stash rationale in consumed_by since we don't have a separate column; use
  // a pipe separator so callers can split if needed. Format: "<by>|<rationale>"
  const consumed_by_field = `${decided_by}|${rationale.slice(0, 400).replace(/\|/g, "/")}`;

  let any_changed = false;
  if (backend === "postgres" || backend === "dual") {
    try {
      const changed = await withClient(async (c) => {
        const res = await c.query(
          `UPDATE mutation_results_pg
              SET consumed_at = $1, consumed_by = $2,
                  consumed_decision = $3, picked_candidate_index = $4
            WHERE result_id = $5 AND consumed_at IS NULL`,
          [decided_at, consumed_by_field, decision, picked_candidate_index, result_id],
        );
        return (res.rowCount ?? 0) > 0;
      });
      any_changed = any_changed || changed;
      if (backend === "postgres") return changed;
    } catch {
      if (backend === "postgres") return false;
    }
  }
  const r = db.prepare(`
    UPDATE mutation_results
       SET consumed_at = ?, consumed_by = ?, consumed_decision = ?, picked_candidate_index = ?
     WHERE result_id = ? AND consumed_at IS NULL
  `).run(decided_at, consumed_by_field, decision, picked_candidate_index, result_id);
  return any_changed || ((r.changes ?? 0) > 0);
}

function defaultHeadline(bodies: MutationCandidate[], best_score: number | null): string {
  const parts: string[] = [];
  parts.push(`${bodies.length} candidate${bodies.length === 1 ? "" : "s"}`);
  if (best_score !== null) parts.push(`best=${best_score.toFixed(2)}`);
  return parts.join(", ");
}

// ─── fetchMutationResult / fetchByResultId ───────────────────────────────────

/**
 * Fetch the most recent result for a mutation_id. Verifies the bodies_hash
 * matches the canonicalized bodies — returns null on hash mismatch (tampered
 * row). Caller can pass `expectedHash` from the broadcast pointer for
 * additional verification.
 */
export async function fetchMutationResult(
  db: DatabaseSync,
  mutation_id: string,
  opts: { expectedHash?: string } = {},
): Promise<MutationResultRow | null> {
  const backend = getBackend();
  let row: Record<string, unknown> | null = null;

  if (backend === "postgres" || backend === "dual") {
    try {
      row = await withClient(async (c) => {
        const res = await c.query<Record<string, unknown>>(
          `SELECT * FROM mutation_results_pg
            WHERE mutation_id = $1
            ORDER BY created_at DESC LIMIT 1`,
          [mutation_id],
        );
        return res.rows[0] ?? null;
      });
      if (backend === "postgres" && !row) return null;
    } catch {
      if (backend === "postgres") return null;
    }
  }

  if (!row) {
    row = (db.prepare(
      `SELECT * FROM mutation_results
        WHERE mutation_id = ?
        ORDER BY created_at DESC LIMIT 1`,
    ).get(mutation_id) as Record<string, unknown> | undefined) ?? null;
  }

  if (!row) return null;
  const result = rowToResult(row);

  // Verify hash integrity. Storage-side recompute (canonical JSON of decoded
  // bodies) should match the stored hash. Mismatch ⇒ row tampered.
  const recomputed = hashBodies(result.bodies);
  if (recomputed !== result.bodies_hash) return null;
  if (opts.expectedHash && opts.expectedHash !== result.bodies_hash) return null;

  return result;
}

export async function fetchByResultId(
  db: DatabaseSync,
  result_id: string,
): Promise<MutationResultRow | null> {
  const backend = getBackend();
  let row: Record<string, unknown> | null = null;

  if (backend === "postgres" || backend === "dual") {
    try {
      row = await withClient(async (c) => {
        const res = await c.query<Record<string, unknown>>(
          `SELECT * FROM mutation_results_pg WHERE result_id = $1`,
          [result_id],
        );
        return res.rows[0] ?? null;
      });
      if (backend === "postgres" && !row) return null;
    } catch {
      if (backend === "postgres") return null;
    }
  }

  if (!row) {
    row = (db.prepare(
      `SELECT * FROM mutation_results WHERE result_id = ?`,
    ).get(result_id) as Record<string, unknown> | undefined) ?? null;
  }

  if (!row) return null;
  const result = rowToResult(row);
  if (hashBodies(result.bodies) !== result.bodies_hash) return null;
  return result;
}

// ─── markConsumed ────────────────────────────────────────────────────────────

/**
 * Mark a result as consumed (e.g. orchestrator picked a candidate to promote).
 * Idempotent: returns false if already consumed or row not found.
 */
export async function markConsumed(
  db: DatabaseSync,
  result_id: string,
  consumed_by: string,
): Promise<boolean> {
  const backend = getBackend();
  const consumed_at = new Date().toISOString();
  let any_changed = false;

  if (backend === "postgres" || backend === "dual") {
    try {
      const ok = await withClient(async (c) => {
        const res = await c.query(
          `UPDATE mutation_results_pg
              SET consumed_at = $1, consumed_by = $2
            WHERE result_id = $3 AND consumed_at IS NULL`,
          [consumed_at, consumed_by, result_id],
        );
        return (res.rowCount ?? 0) > 0;
      });
      any_changed = any_changed || ok;
      if (backend === "postgres") return ok;
    } catch {
      if (backend === "postgres") return false;
    }
  }

  const r = db.prepare(`
    UPDATE mutation_results
       SET consumed_at = ?, consumed_by = ?
     WHERE result_id = ? AND consumed_at IS NULL
  `).run(consumed_at, consumed_by, result_id);
  return any_changed || ((r.changes ?? 0) > 0);
}

// ─── v0.18.4 Sprint 2.7 — decision-feedback loop ─────────────────────────────

export interface PriorDecision {
  result_id:               string;
  picked_candidate_index:  number | null;
  decision:                "approved" | "rejected";
  rationale:               string;
  picked_candidate_summary: string | null;  // rationale of the picked body, if approved
  retry_passed:            boolean | null;  // true if v1.0.X+1 ran fixtures successfully
  decided_at:              string;
  mutator_pool:            string | null;
  skill_id:                string;
}

/**
 * Fetch recent operator decisions to inject into a future mutator's payload as
 * `prior_decisions`. Used by the L1 trigger so the mutator can learn operator
 * preferences without ML/training — just prompt-engineering against past data.
 *
 * Filters by skill_id (most relevant for repeat-mutations of the same skill)
 * and falls back to mutator_pool (similar-domain mutations) when not enough
 * skill-specific history exists. Always returns the most recent decisions
 * first so the prompt's last-seen items are most weighted.
 *
 * The `retry_passed` field is best-effort — we look for skill_runs against
 * the new version with was_retry_after_promotion=true; if we find a recent
 * succeeded run, retry_passed=true. If there are recent failed runs,
 * retry_passed=false. If neither, retry_passed=null (haven't retried yet).
 */
export async function fetchRecentDecisions(
  db: DatabaseSync,
  args: { skill_id?: string; mutator_pool?: string; limit?: number },
): Promise<PriorDecision[]> {
  const limit = Math.max(1, Math.min(20, args.limit ?? 5));
  const backend = getBackend();

  if (backend === "postgres" || backend === "dual") {
    try {
      const decisions = await withClient(async (c) => {
        // Step 1: pull consumed mutation_results for the skill or pool, newest first.
        // Try skill-specific first; fall back to pool-wide if skill returns < limit.
        const wheres: string[] = ["consumed_decision IS NOT NULL"];
        const params: unknown[] = [];
        if (args.skill_id) {
          params.push(args.skill_id);
          wheres.push(`skill_id = $${params.length}`);
        }
        params.push(limit);
        const sql = `
          SELECT result_id, mutation_id, skill_id, mutator_pool,
                 consumed_decision, consumed_by, picked_candidate_index, consumed_at,
                 bodies
            FROM mutation_results_pg
           WHERE ${wheres.join(" AND ")}
           ORDER BY consumed_at DESC
           LIMIT $${params.length}
        `;
        const res = await c.query<Record<string, unknown>>(sql, params);
        let rows = res.rows;

        // Fallback: if skill-specific returned < limit, supplement with pool-wide
        if (rows.length < limit && args.mutator_pool) {
          const remain = limit - rows.length;
          const seen = new Set(rows.map((r) => r.result_id as string));
          const r2 = await c.query<Record<string, unknown>>(
            `SELECT result_id, mutation_id, skill_id, mutator_pool,
                    consumed_decision, consumed_by, picked_candidate_index, consumed_at,
                    bodies
               FROM mutation_results_pg
              WHERE consumed_decision IS NOT NULL
                AND mutator_pool = $1
                AND ($2::text IS NULL OR skill_id != $2)
              ORDER BY consumed_at DESC
              LIMIT $3`,
            [args.mutator_pool, args.skill_id ?? null, remain],
          );
          for (const row of r2.rows) {
            if (!seen.has(row.result_id as string)) rows.push(row);
          }
        }

        // Best-effort retry_passed lookup for each result
        const decisions: PriorDecision[] = [];
        for (const row of rows) {
          // consumed_by has the format "<by>|<rationale>"; split
          const cb = String(row.consumed_by ?? "");
          const sepIdx = cb.indexOf("|");
          const decided_by = sepIdx > 0 ? cb.slice(0, sepIdx) : cb;
          const rationale  = sepIdx > 0 ? cb.slice(sepIdx + 1) : "";

          let pickedSummary: string | null = null;
          const pickedIdx = row.picked_candidate_index === null || row.picked_candidate_index === undefined
            ? null : Number(row.picked_candidate_index);
          if (pickedIdx !== null && row.bodies) {
            try {
              const bodies = typeof row.bodies === "string" ? JSON.parse(row.bodies as string) : row.bodies;
              if (Array.isArray(bodies) && bodies[pickedIdx]) {
                pickedSummary = String(bodies[pickedIdx].rationale ?? "").slice(0, 200);
              }
            } catch { /* ignore corrupt bodies */ }
          }

          // retry_passed: was there a was_retry_after_promotion run for this skill_id post-decision?
          let retry_passed: boolean | null = null;
          if (row.consumed_decision === "approved") {
            try {
              const rr = await c.query<{ status: string }>(
                `SELECT status FROM skill_runs_pg
                  WHERE was_retry_after_promotion = TRUE
                    AND ts > $1::timestamptz
                  ORDER BY ts ASC LIMIT 1`,
                [row.consumed_at],
              );
              if (rr.rows.length > 0) {
                retry_passed = rr.rows[0].status === "succeeded";
              }
            } catch { /* tolerate */ }
          }
          // (Note: decided_by is captured but not used directly in PriorDecision;
          // it's encoded in `rationale` since the field carries who+why audit trail.
          // Future cleanup: split into separate columns.)
          void decided_by;

          decisions.push({
            result_id:                String(row.result_id),
            picked_candidate_index:   pickedIdx,
            decision:                 row.consumed_decision as "approved" | "rejected",
            rationale,
            picked_candidate_summary: pickedSummary,
            retry_passed,
            decided_at:               row.consumed_at instanceof Date ? row.consumed_at.toISOString() : String(row.consumed_at),
            mutator_pool:             (row.mutator_pool as string) ?? null,
            skill_id:                 String(row.skill_id),
          });
        }
        return decisions;
      });
      if (decisions.length > 0 || backend === "postgres") return decisions;
    } catch {
      if (backend === "postgres") return [];
    }
  }

  // SQLite fallback (no retry_passed lookup — only PG has skill_runs_pg)
  let sql = `SELECT result_id, mutation_id, skill_id, mutator_pool,
                    consumed_decision, consumed_by, picked_candidate_index, consumed_at, bodies
               FROM mutation_results
              WHERE consumed_decision IS NOT NULL`;
  const sqliteParams: Array<string | number | null> = [];
  if (args.skill_id) {
    sql += ` AND skill_id = ?`;
    sqliteParams.push(args.skill_id);
  }
  sql += ` ORDER BY consumed_at DESC LIMIT ?`;
  sqliteParams.push(limit);
  const rows = db.prepare(sql).all(...sqliteParams) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const cb = String(row.consumed_by ?? "");
    const sepIdx = cb.indexOf("|");
    const rationale = sepIdx > 0 ? cb.slice(sepIdx + 1) : "";
    let pickedSummary: string | null = null;
    const pickedIdx = row.picked_candidate_index === null || row.picked_candidate_index === undefined
      ? null : Number(row.picked_candidate_index);
    if (pickedIdx !== null && row.bodies) {
      try {
        const bodies = JSON.parse(row.bodies as string);
        if (Array.isArray(bodies) && bodies[pickedIdx]) {
          pickedSummary = String(bodies[pickedIdx].rationale ?? "").slice(0, 200);
        }
      } catch { /* ignore */ }
    }
    return {
      result_id:                String(row.result_id),
      picked_candidate_index:   pickedIdx,
      decision:                 row.consumed_decision as "approved" | "rejected",
      rationale,
      picked_candidate_summary: pickedSummary,
      retry_passed:             null,  // SQLite-only: can't determine
      decided_at:               String(row.consumed_at ?? ""),
      mutator_pool:             (row.mutator_pool as string) ?? null,
      skill_id:                 String(row.skill_id),
    };
  });
}

// ─── Test helpers ────────────────────────────────────────────────────────────

export async function _dropMutationResultsForTesting(): Promise<void> {
  await withClient(async (c) => {
    await c.query(`DROP TABLE IF EXISTS mutation_results_pg CASCADE`);
    await c.query(`DELETE FROM schema_migrations_pg WHERE id = 10`);
  });
}
