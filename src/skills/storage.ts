/**
 * Skill storage layer (SQLite — Sprint 2 baseline)
 * =================================================
 *
 * CRUD + active-version management for the `skills`, `skill_runs`, and
 * `skill_mutations` tables (migrations 20-22).
 *
 * SECURITY:
 *   - On every read from `skills` we re-verify body_hmac. If it doesn't
 *     match (DB tamper or machine-secret rotation), the read returns a
 *     `SkillTamperedError` rather than the row. RT-S2-08 path.
 *   - Skills are written via `INSERT OR REPLACE` so promoted versions
 *     atomically supersede the prior active row + the soft-delete pattern
 *     keeps the audit trail.
 *
 * SQLite-only for v0.18.0. Postgres mirror is a follow-up (the skill data
 * volume is small enough that local SQLite is fine for the initial loop).
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  Skill, SkillRun, SkillMutation, SkillScope, SkillFrontmatter,
} from "./types.js";
import { verifySkillHmac } from "./loader.js";

export class SkillTamperedError extends Error {
  constructor(public skill_id: string, public stored_hmac: string) {
    super(`Skill ${skill_id} body HMAC mismatch — refusing to load (possible tampering or machine-secret rotation)`);
    this.name = "SkillTamperedError";
  }
}

function rowToSkill(row: Record<string, unknown>): Skill {
  return {
    skill_id:       row.skill_id as string,
    frontmatter:    JSON.parse(row.frontmatter as string) as SkillFrontmatter,
    body:           row.body as string,
    body_hmac:      row.body_hmac as string,
    source_path:    (row.source_path as string) ?? null,
    promoted_from:  (row.promoted_from as string) ?? null,
    created_at:     row.created_at as string,
    archived_at:    (row.archived_at as string) ?? null,
    archive_reason: (row.archive_reason as string) ?? null,
  };
}

/**
 * Insert or replace a skill row. The primary key is skill_id (which encodes
 * name@version@scope), so a re-insert at the same triple overwrites — that's
 * intentional for the seed-from-disk path. For mutation-engine version bumps
 * the new skill has a different version, so this is INSERT, not REPLACE.
 *
 * Verifies HMAC matches the body BEFORE writing.
 */
export async function upsertSkill(db: DatabaseSync, skill: Skill): Promise<void> {
  const ok = await verifySkillHmac(skill.body, skill.body_hmac);
  if (!ok) throw new SkillTamperedError(skill.skill_id, skill.body_hmac);

  db.prepare(`
    INSERT INTO skills (
      skill_id, name, version, scope, description, frontmatter, body, body_hmac,
      source_path, promoted_from, created_at, archived_at, archive_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (skill_id) DO UPDATE SET
      body          = excluded.body,
      body_hmac     = excluded.body_hmac,
      frontmatter   = excluded.frontmatter,
      description   = excluded.description,
      source_path   = excluded.source_path,
      archived_at   = excluded.archived_at,
      archive_reason= excluded.archive_reason
  `).run(
    skill.skill_id, skill.frontmatter.name, skill.frontmatter.version, skill.frontmatter.scope,
    skill.frontmatter.description, JSON.stringify(skill.frontmatter), skill.body, skill.body_hmac,
    skill.source_path, skill.promoted_from, skill.created_at, skill.archived_at, skill.archive_reason,
  );
}

/**
 * Fetch a single skill by id. Returns null if not found.
 * Throws SkillTamperedError if body_hmac doesn't verify.
 */
export async function getSkillById(db: DatabaseSync, skill_id: string): Promise<Skill | null> {
  const row = db.prepare(`SELECT * FROM skills WHERE skill_id = ?`).get(skill_id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const skill = rowToSkill(row);
  const ok = await verifySkillHmac(skill.body, skill.body_hmac);
  if (!ok) throw new SkillTamperedError(skill.skill_id, skill.body_hmac);
  return skill;
}

/**
 * Fetch the active (un-archived) skill for a (name, scope). Returns null if
 * none active. Useful for the resolve-at-load-time pattern: per-project
 * overrides global.
 */
export async function getActiveSkill(
  db: DatabaseSync,
  name: string,
  scope: SkillScope,
): Promise<Skill | null> {
  const row = db.prepare(
    `SELECT * FROM skills WHERE name = ? AND scope = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`
  ).get(name, scope) as Record<string, unknown> | undefined;
  if (!row) return null;
  const skill = rowToSkill(row);
  const ok = await verifySkillHmac(skill.body, skill.body_hmac);
  if (!ok) throw new SkillTamperedError(skill.skill_id, skill.body_hmac);
  return skill;
}

/**
 * Resolve a skill by name with scope priority — per-project overrides global.
 * Returns the active project-scoped version if it exists, else the global
 * active version, else null.
 */
export async function resolveSkill(
  db: DatabaseSync,
  name: string,
  projectScope: SkillScope,
): Promise<Skill | null> {
  if (projectScope.startsWith("project:")) {
    const local = await getActiveSkill(db, name, projectScope);
    if (local) return local;
  }
  return getActiveSkill(db, name, "global");
}

/** List all active skills. */
export async function listActiveSkills(db: DatabaseSync): Promise<Skill[]> {
  const rows = db.prepare(
    `SELECT * FROM skills WHERE archived_at IS NULL ORDER BY scope, name`
  ).all() as Array<Record<string, unknown>>;
  const out: Skill[] = [];
  for (const row of rows) {
    const skill = rowToSkill(row);
    const ok = await verifySkillHmac(skill.body, skill.body_hmac);
    if (!ok) {
      // Don't throw mid-list; surface tampering by skipping the row +
      // letting the caller see the count mismatch. A separate
      // verifyAllSkillHmacs() walk reports the tampered ids.
      continue;
    }
    out.push(skill);
  }
  return out;
}

/** Walk all rows and return the ids of any with mismatched HMAC. RT-S2-08 audit. */
export async function verifyAllSkillHmacs(db: DatabaseSync): Promise<{ ok: boolean; tampered: string[] }> {
  const rows = db.prepare(`SELECT skill_id, body, body_hmac FROM skills WHERE archived_at IS NULL`).all() as Array<{ skill_id: string; body: string; body_hmac: string }>;
  const tampered: string[] = [];
  for (const r of rows) {
    if (!await verifySkillHmac(r.body, r.body_hmac)) tampered.push(r.skill_id);
  }
  return { ok: tampered.length === 0, tampered };
}

/** Mark a skill as archived (soft delete). */
export function archiveSkill(db: DatabaseSync, skill_id: string, reason: string): boolean {
  const r = db.prepare(
    `UPDATE skills SET archived_at = ?, archive_reason = ? WHERE skill_id = ? AND archived_at IS NULL`
  ).run(new Date().toISOString(), reason, skill_id);
  return (r.changes ?? 0) > 0;
}

// ─── skill_runs ──────────────────────────────────────────────────────────────

export function recordSkillRun(db: DatabaseSync, run: SkillRun): void {
  db.prepare(`
    INSERT INTO skill_runs (
      run_id, skill_id, session_id, task_id, inputs, outcome_score,
      total_cost, total_tokens, duration_ms, status, failure_trace, ts
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.run_id, run.skill_id, run.session_id, run.task_id ?? null,
    JSON.stringify(run.inputs), run.outcome_score ?? null,
    run.total_cost ?? null, run.total_tokens ?? null, run.duration_ms ?? null,
    run.status, run.failure_trace ?? null, run.ts,
  );
}

export function getRecentSkillRuns(db: DatabaseSync, skill_id: string, limit = 20): SkillRun[] {
  const rows = db.prepare(
    `SELECT * FROM skill_runs WHERE skill_id = ? ORDER BY ts DESC LIMIT ?`
  ).all(skill_id, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    run_id:        r.run_id as string,
    skill_id:      r.skill_id as string,
    session_id:    r.session_id as string,
    task_id:       (r.task_id as string) ?? null,
    inputs:        JSON.parse(r.inputs as string) as Record<string, unknown>,
    outcome_score: r.outcome_score === null ? null : Number(r.outcome_score),
    total_cost:    r.total_cost === null    ? null : Number(r.total_cost),
    total_tokens:  r.total_tokens === null  ? null : Number(r.total_tokens),
    duration_ms:   r.duration_ms === null   ? null : Number(r.duration_ms),
    status:        r.status as SkillRun["status"],
    failure_trace: (r.failure_trace as string) ?? null,
    ts:            r.ts as string,
  }));
}

// ─── skill_mutations ─────────────────────────────────────────────────────────

export function recordMutation(db: DatabaseSync, m: SkillMutation): void {
  db.prepare(`
    INSERT INTO skill_mutations (
      mutation_id, parent_skill_id, candidate_body, candidate_hmac,
      proposed_by, judged_by, judge_score, judge_rationale, replay_score,
      promoted, promoted_to_skill_id, created_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.mutation_id, m.parent_skill_id, m.candidate_body, m.candidate_hmac,
    m.proposed_by, m.judged_by ?? null, m.judge_score ?? null, m.judge_rationale ?? null,
    m.replay_score ?? null, m.promoted ? 1 : 0, m.promoted_to_skill_id ?? null,
    m.created_at, m.resolved_at ?? null,
  );
}

export function getRecentMutations(db: DatabaseSync, parent_skill_id: string, limit = 10): SkillMutation[] {
  const rows = db.prepare(
    `SELECT * FROM skill_mutations WHERE parent_skill_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(parent_skill_id, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    mutation_id:          r.mutation_id as string,
    parent_skill_id:      r.parent_skill_id as string,
    candidate_body:       r.candidate_body as string,
    candidate_hmac:       r.candidate_hmac as string,
    proposed_by:          r.proposed_by as string,
    judged_by:            (r.judged_by as string) ?? null,
    judge_score:          r.judge_score === null ? null : Number(r.judge_score),
    judge_rationale:      (r.judge_rationale as string) ?? null,
    replay_score:         r.replay_score === null ? null : Number(r.replay_score),
    promoted:             Number(r.promoted) === 1,
    promoted_to_skill_id: (r.promoted_to_skill_id as string) ?? null,
    created_at:           r.created_at as string,
    resolved_at:          (r.resolved_at as string) ?? null,
  }));
}

/** Update mutation row with replay results + promotion outcome. */
export function resolveMutation(
  db: DatabaseSync,
  mutation_id: string,
  patch: { replay_score?: number; promoted?: boolean; promoted_to_skill_id?: string; judged_by?: string; judge_score?: number; judge_rationale?: string },
): boolean {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.replay_score          !== undefined) { sets.push("replay_score = ?");          vals.push(patch.replay_score); }
  if (patch.promoted              !== undefined) { sets.push("promoted = ?");              vals.push(patch.promoted ? 1 : 0); }
  if (patch.promoted_to_skill_id  !== undefined) { sets.push("promoted_to_skill_id = ?");  vals.push(patch.promoted_to_skill_id); }
  if (patch.judged_by             !== undefined) { sets.push("judged_by = ?");             vals.push(patch.judged_by); }
  if (patch.judge_score           !== undefined) { sets.push("judge_score = ?");           vals.push(patch.judge_score); }
  if (patch.judge_rationale       !== undefined) { sets.push("judge_rationale = ?");       vals.push(patch.judge_rationale); }
  sets.push("resolved_at = ?"); vals.push(new Date().toISOString());
  vals.push(mutation_id);
  const r = db.prepare(`UPDATE skill_mutations SET ${sets.join(", ")} WHERE mutation_id = ?`).run(...(vals as never[]));
  return (r.changes ?? 0) > 0;
}
