/**
 * Postgres mirror for the skill subsystem (v0.18.0)
 * ==================================================
 *
 * 1:1 mirror of `src/skills/storage.ts` against the `skills_pg`,
 * `skill_runs_pg`, and `skill_mutations_pg` tables (PG migrations 6-8).
 *
 * WHY: the harness's standard deployment is the Docker stack with Postgres.
 * Skills should live there too so:
 *   - Multi-machine consistency: different operators/Docker hosts can read
 *     the same skill registry
 *   - HA: PG already has WAL + replication; SQLite per-project doesn't
 *   - Cross-project promotion (S2.5-4): aggregate `skill_runs_pg` across
 *     all projects in one query to find global-promotion candidates
 *
 * Backend dispatch (mirror of telemetry.ts pattern):
 *   ZC_TELEMETRY_BACKEND=sqlite   → SQLite only
 *   ZC_TELEMETRY_BACKEND=postgres → PG only
 *   ZC_TELEMETRY_BACKEND=dual     → both (PG primary, SQLite fallback)
 *
 * The dispatch lives in `storage_dual.ts` — this file is just the PG impl.
 */

import type { Skill, SkillRun, SkillMutation, SkillScope, SkillFrontmatter } from "./types.js";
import { verifySkillHmac } from "./loader.js";
import { withClient, withTransaction } from "../pg_pool.js";
import { SkillTamperedError } from "./storage.js";
import type { PoolClient } from "pg";

function rowToSkill(row: Record<string, unknown>): Skill {
  // PG returns frontmatter as a JS object (JSONB); SQLite stores as TEXT.
  // Either way, normalize.
  const fmRaw = row.frontmatter as unknown;
  const frontmatter = (typeof fmRaw === "string" ? JSON.parse(fmRaw) : fmRaw) as SkillFrontmatter;
  return {
    skill_id:       row.skill_id as string,
    frontmatter,
    body:           row.body as string,
    body_hmac:      row.body_hmac as string,
    source_path:    (row.source_path as string) ?? null,
    promoted_from:  (row.promoted_from as string) ?? null,
    created_at:     row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at as string),
    archived_at:    row.archived_at instanceof Date ? row.archived_at.toISOString() : ((row.archived_at as string) ?? null),
    archive_reason: (row.archive_reason as string) ?? null,
  };
}

export async function upsertSkillPg(skill: Skill): Promise<void> {
  const ok = await verifySkillHmac(skill.body, skill.body_hmac);
  if (!ok) throw new SkillTamperedError(skill.skill_id, skill.body_hmac);

  await withClient(async (c: PoolClient) => {
    await c.query(`
      INSERT INTO skills_pg (
        skill_id, name, version, scope, description, frontmatter, body, body_hmac,
        source_path, promoted_from, created_at, archived_at, archive_reason
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, COALESCE($11::timestamptz, NOW()), $12::timestamptz, $13)
      ON CONFLICT (skill_id) DO UPDATE SET
        body          = EXCLUDED.body,
        body_hmac     = EXCLUDED.body_hmac,
        frontmatter   = EXCLUDED.frontmatter,
        description   = EXCLUDED.description,
        source_path   = EXCLUDED.source_path,
        archived_at   = EXCLUDED.archived_at,
        archive_reason= EXCLUDED.archive_reason
    `, [
      skill.skill_id, skill.frontmatter.name, skill.frontmatter.version, skill.frontmatter.scope,
      skill.frontmatter.description, JSON.stringify(skill.frontmatter), skill.body, skill.body_hmac,
      skill.source_path, skill.promoted_from, skill.created_at, skill.archived_at, skill.archive_reason,
    ]);
  });
}

export async function getSkillByIdPg(skill_id: string): Promise<Skill | null> {
  return withClient(async (c) => {
    const r = await c.query<Record<string, unknown>>(`SELECT * FROM skills_pg WHERE skill_id = $1`, [skill_id]);
    if (r.rows.length === 0) return null;
    const skill = rowToSkill(r.rows[0]);
    if (!await verifySkillHmac(skill.body, skill.body_hmac)) {
      throw new SkillTamperedError(skill.skill_id, skill.body_hmac);
    }
    return skill;
  });
}

export async function getActiveSkillPg(name: string, scope: SkillScope): Promise<Skill | null> {
  return withClient(async (c) => {
    const r = await c.query<Record<string, unknown>>(
      `SELECT * FROM skills_pg WHERE name = $1 AND scope = $2 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [name, scope],
    );
    if (r.rows.length === 0) return null;
    const skill = rowToSkill(r.rows[0]);
    if (!await verifySkillHmac(skill.body, skill.body_hmac)) {
      throw new SkillTamperedError(skill.skill_id, skill.body_hmac);
    }
    return skill;
  });
}

export async function resolveSkillPg(name: string, projectScope: SkillScope): Promise<Skill | null> {
  if (projectScope.startsWith("project:")) {
    const local = await getActiveSkillPg(name, projectScope);
    if (local) return local;
  }
  return getActiveSkillPg(name, "global");
}

export async function listActiveSkillsPg(): Promise<Skill[]> {
  return withClient(async (c) => {
    const r = await c.query<Record<string, unknown>>(`SELECT * FROM skills_pg WHERE archived_at IS NULL ORDER BY scope, name`);
    const out: Skill[] = [];
    for (const row of r.rows) {
      const skill = rowToSkill(row);
      if (!await verifySkillHmac(skill.body, skill.body_hmac)) continue;  // skip tampered, surface via verifyAllPg
      out.push(skill);
    }
    return out;
  });
}

export async function archiveSkillPg(skill_id: string, reason: string): Promise<boolean> {
  return withClient(async (c) => {
    const r = await c.query(
      `UPDATE skills_pg SET archived_at = NOW(), archive_reason = $1 WHERE skill_id = $2 AND archived_at IS NULL`,
      [reason, skill_id],
    );
    return (r.rowCount ?? 0) > 0;
  });
}

export async function recordSkillRunPg(run: SkillRun, projectHash: string): Promise<void> {
  await withClient(async (c) => {
    await c.query(`
      INSERT INTO skill_runs_pg (
        run_id, skill_id, project_hash, session_id, task_id, inputs, outcome_score,
        total_cost, total_tokens, duration_ms, status, failure_trace, ts
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, COALESCE($13::timestamptz, NOW()))
      ON CONFLICT (run_id) DO NOTHING
    `, [
      run.run_id, run.skill_id, projectHash, run.session_id, run.task_id,
      JSON.stringify(run.inputs), run.outcome_score, run.total_cost, run.total_tokens,
      run.duration_ms, run.status, run.failure_trace, run.ts,
    ]);
  });
}

export async function getRecentSkillRunsPg(skill_id: string, limit = 20): Promise<SkillRun[]> {
  return withClient(async (c) => {
    const r = await c.query<{
      run_id: string; skill_id: string; session_id: string; task_id: string | null;
      inputs: unknown; outcome_score: string | null; total_cost: string | null;
      total_tokens: number | null; duration_ms: number | null;
      status: SkillRun["status"]; failure_trace: string | null; ts: Date;
    }>(`SELECT * FROM skill_runs_pg WHERE skill_id = $1 ORDER BY ts DESC LIMIT $2`, [skill_id, limit]);
    return r.rows.map((row) => ({
      run_id:        row.run_id,
      skill_id:      row.skill_id,
      session_id:    row.session_id,
      task_id:       row.task_id,
      inputs:        typeof row.inputs === "string" ? JSON.parse(row.inputs) : row.inputs as Record<string, unknown>,
      outcome_score: row.outcome_score === null ? null : Number(row.outcome_score),
      total_cost:    row.total_cost    === null ? null : Number(row.total_cost),
      total_tokens:  row.total_tokens,
      duration_ms:   row.duration_ms,
      status:        row.status,
      failure_trace: row.failure_trace,
      ts:            row.ts.toISOString(),
    }));
  });
}

export async function recordMutationPg(m: SkillMutation, projectHash: string): Promise<void> {
  await withClient(async (c) => {
    await c.query(`
      INSERT INTO skill_mutations_pg (
        mutation_id, parent_skill_id, project_hash, candidate_body, candidate_hmac,
        proposed_by, judged_by, judge_score, judge_rationale, replay_score,
        promoted, promoted_to_skill_id, created_at, resolved_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13::timestamptz, NOW()), $14::timestamptz)
      ON CONFLICT (mutation_id) DO NOTHING
    `, [
      m.mutation_id, m.parent_skill_id, projectHash, m.candidate_body, m.candidate_hmac,
      m.proposed_by, m.judged_by, m.judge_score, m.judge_rationale, m.replay_score,
      m.promoted, m.promoted_to_skill_id, m.created_at, m.resolved_at,
    ]);
  });
}

export async function resolveMutationPg(
  mutation_id: string,
  patch: { replay_score?: number; promoted?: boolean; promoted_to_skill_id?: string; judged_by?: string; judge_score?: number; judge_rationale?: string },
): Promise<boolean> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.replay_score          !== undefined) { sets.push(`replay_score = $${i++}`);          vals.push(patch.replay_score); }
  if (patch.promoted              !== undefined) { sets.push(`promoted = $${i++}`);              vals.push(patch.promoted); }
  if (patch.promoted_to_skill_id  !== undefined) { sets.push(`promoted_to_skill_id = $${i++}`);  vals.push(patch.promoted_to_skill_id); }
  if (patch.judged_by             !== undefined) { sets.push(`judged_by = $${i++}`);             vals.push(patch.judged_by); }
  if (patch.judge_score           !== undefined) { sets.push(`judge_score = $${i++}`);           vals.push(patch.judge_score); }
  if (patch.judge_rationale       !== undefined) { sets.push(`judge_rationale = $${i++}`);       vals.push(patch.judge_rationale); }
  sets.push(`resolved_at = NOW()`);
  vals.push(mutation_id);
  return withClient(async (c) => {
    const r = await c.query(`UPDATE skill_mutations_pg SET ${sets.join(", ")} WHERE mutation_id = $${i}`, vals);
    return (r.rowCount ?? 0) > 0;
  });
}

/**
 * Cross-project query for S2.5-4 promotion candidates: find skill names where
 * one or more per-project versions are outperforming global by ≥ threshold
 * across ≥ minProjects projects.
 *
 * Returns the candidate version-strings (best per project) so the operator
 * can review + approve global promotion.
 */
export async function findGlobalPromotionCandidates(
  threshold: number,
  minProjects: number,
  recencyWindow = 20,
): Promise<Array<{ name: string; project_count: number; best_skill_id: string; best_avg: number; global_avg: number }>> {
  return withClient(async (c) => {
    // For each (skill_id, project_hash), aggregate avg outcome_score over recent runs.
    // Then for each name, find: count of distinct projects where avg > global_avg + threshold,
    // and the best project's skill_id.
    //
    // This is a single window-function query; SQLite parity is harder so we
    // expose this only on PG.
    const r = await c.query<{
      name: string; project_count: number; best_skill_id: string; best_avg: number; global_avg: number;
    }>(`
      WITH per_proj AS (
        SELECT s.name AS name, s.skill_id, sr.project_hash, AVG(sr.outcome_score) AS proj_avg
        FROM skills_pg s
        JOIN skill_runs_pg sr ON sr.skill_id = s.skill_id
        WHERE s.archived_at IS NULL AND s.scope LIKE 'project:%'
        GROUP BY s.name, s.skill_id, sr.project_hash
      ),
      global_avg AS (
        SELECT s.name AS name, AVG(sr.outcome_score) AS gavg
        FROM skills_pg s
        JOIN skill_runs_pg sr ON sr.skill_id = s.skill_id
        WHERE s.archived_at IS NULL AND s.scope = 'global'
        GROUP BY s.name
      ),
      ranked AS (
        SELECT
          per_proj.name,
          per_proj.skill_id,
          per_proj.project_hash,
          per_proj.proj_avg,
          COALESCE(global_avg.gavg, 0) AS gavg,
          ROW_NUMBER() OVER (PARTITION BY per_proj.name ORDER BY per_proj.proj_avg DESC) AS rk
        FROM per_proj
        LEFT JOIN global_avg ON global_avg.name = per_proj.name
        WHERE per_proj.proj_avg > COALESCE(global_avg.gavg, 0) + $1
      )
      SELECT
        r.name AS name,
        COUNT(DISTINCT r.project_hash)::int AS project_count,
        (SELECT skill_id FROM ranked rr WHERE rr.name = r.name AND rr.rk = 1) AS best_skill_id,
        (SELECT proj_avg FROM ranked rr WHERE rr.name = r.name AND rr.rk = 1) AS best_avg,
        (SELECT gavg FROM ranked rr WHERE rr.name = r.name LIMIT 1) AS global_avg
      FROM ranked r
      GROUP BY r.name
      HAVING COUNT(DISTINCT r.project_hash) >= $2
    `, [threshold, minProjects]);
    void recencyWindow;  // reserved for future scoping
    return r.rows.map((row) => ({
      name:          row.name,
      project_count: row.project_count,
      best_skill_id: row.best_skill_id,
      best_avg:      Number(row.best_avg),
      global_avg:    Number(row.global_avg),
    }));
  });
}

/** Test helper — drop tables. NEVER call against shared / production DBs. */
export async function _dropSkillTablesForTesting(): Promise<void> {
  await withTransaction(async (c) => {
    await c.query(`DROP TABLE IF EXISTS skill_mutations_pg CASCADE`);
    await c.query(`DROP TABLE IF EXISTS skill_runs_pg CASCADE`);
    await c.query(`DROP TABLE IF EXISTS skills_pg CASCADE`);
    await c.query(`DELETE FROM schema_migrations_pg WHERE id IN (6, 7, 8)`);
  });
}
