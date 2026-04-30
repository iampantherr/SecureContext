/**
 * v0.18.5 Sprint 2.7 — Shared skill-frontmatter editor.
 *
 * Used by BOTH the MCP tool (zc_skill_edit_frontmatter) and the HTTP route
 * (POST /dashboard/skills/edit). Same code path → identical behavior, single
 * place to audit.
 *
 * Operator-controlled fields (the dashboard form lets you change these):
 *   - description
 *   - intended_roles
 *   - mutation_guidance
 *   - acceptance_criteria.min_outcome_score / min_pass_rate
 *   - tags
 *
 * Mutator-controlled fields (NOT editable via this surface):
 *   - body (use zc_skill_import for body rewrites)
 *
 * Auto-managed fields (NOT editable):
 *   - name, scope (changing these = creating a different skill)
 *   - version (auto-bumped on every save)
 *   - body_hmac, source_path (provenance)
 *
 * Atomic flow:
 *   1. Open project DB (runs migrations to ensure mig 26 columns exist)
 *   2. Look up current skill by skill_id
 *   3. Spread current.frontmatter, apply patches, validate
 *   4. Build new skill at bumped patch version (body preserved verbatim)
 *   5. Archive current
 *   6. Upsert new
 *   7. Write skill_revisions row (action='manual')
 *   8. Broadcast STATUS state='skill-frontmatter-edited'
 *
 * Fields not in `changes` are left unchanged. To CLEAR a field (set empty),
 * pass an explicit empty value (e.g. `mutation_guidance: ""` or
 * `intended_roles: []`).
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import { getSkillById, archiveSkill, upsertSkill } from "../skills/storage_dual.js";
import { buildSkill } from "../skills/loader.js";
import { broadcastFact } from "../memory.js";
import { withClient } from "../pg_pool.js";
import { runMigrations } from "../migrations.js";
import type { SkillFrontmatter, AcceptanceCriteria } from "../skills/types.js";

export interface FrontmatterPatch {
  description?:        string;
  intended_roles?:     string[];
  mutation_guidance?:  string;
  acceptance_criteria?: { min_outcome_score?: number; min_pass_rate?: number };
  tags?:               string[];
}

export interface EditFrontmatterArgs {
  skill_id:    string;
  changes:     FrontmatterPatch;
  rationale:   string;
  decided_by?: string;
}

export interface EditFrontmatterResult {
  prior_skill_id:  string;
  new_skill_id:    string;
  changed_fields:  string[];
  revision_id:     string;
}

function bumpPatch(version: string): string {
  const parts = version.split(".");
  if (parts.length !== 3) return version + ".1";
  const patch = parseInt(parts[2], 10);
  return `${parts[0]}.${parts[1]}.${Number.isFinite(patch) ? patch + 1 : 1}`;
}

/**
 * Validate + sanitize a patch before applying. Throws Error on invalid input.
 */
function validatePatch(patch: FrontmatterPatch): void {
  if (patch.description !== undefined) {
    if (typeof patch.description !== "string") throw new Error("description must be a string");
    if (patch.description.length > 500)        throw new Error("description max 500 chars");
  }
  if (patch.intended_roles !== undefined) {
    if (!Array.isArray(patch.intended_roles)) throw new Error("intended_roles must be an array");
    if (patch.intended_roles.length > 20)     throw new Error("intended_roles max 20 entries");
    for (const r of patch.intended_roles) {
      if (typeof r !== "string" || !/^[a-z0-9_-]{1,64}$/.test(r)) {
        throw new Error(`intended_roles entries must be lowercase alphanumeric / dash / underscore (got '${r}')`);
      }
    }
  }
  if (patch.mutation_guidance !== undefined) {
    if (typeof patch.mutation_guidance !== "string") throw new Error("mutation_guidance must be a string");
    if (patch.mutation_guidance.length > 4000)        throw new Error("mutation_guidance max 4000 chars");
  }
  if (patch.acceptance_criteria !== undefined) {
    const ac = patch.acceptance_criteria;
    if (typeof ac !== "object" || ac === null) throw new Error("acceptance_criteria must be an object");
    for (const k of ["min_outcome_score", "min_pass_rate"] as const) {
      const v = ac[k];
      if (v !== undefined) {
        if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`acceptance_criteria.${k} must be a finite number`);
        if (v < 0 || v > 1) throw new Error(`acceptance_criteria.${k} must be in [0, 1]`);
      }
    }
  }
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags))       throw new Error("tags must be an array");
    if (patch.tags.length > 30)           throw new Error("tags max 30 entries");
    for (const t of patch.tags) {
      if (typeof t !== "string" || t.length > 50) throw new Error("tag must be a string ≤50 chars");
    }
  }
}

function applyPatch(
  base: SkillFrontmatter,
  patch: FrontmatterPatch,
): { merged: SkillFrontmatter; changed: string[] } {
  const merged: SkillFrontmatter = { ...base };
  const changed: string[] = [];

  if (patch.description !== undefined && patch.description !== base.description) {
    merged.description = patch.description;
    changed.push("description");
  }
  if (patch.intended_roles !== undefined) {
    const before = JSON.stringify(base.intended_roles ?? []);
    const after  = JSON.stringify(patch.intended_roles);
    if (before !== after) {
      merged.intended_roles = patch.intended_roles;
      changed.push("intended_roles");
    }
  }
  if (patch.mutation_guidance !== undefined && patch.mutation_guidance !== (base.mutation_guidance ?? "")) {
    merged.mutation_guidance = patch.mutation_guidance.length > 0 ? patch.mutation_guidance : undefined;
    changed.push("mutation_guidance");
  }
  if (patch.acceptance_criteria !== undefined) {
    const baseAc: AcceptanceCriteria | undefined = base.acceptance_criteria;
    const newAc: AcceptanceCriteria = { ...baseAc };
    if (patch.acceptance_criteria.min_outcome_score !== undefined) {
      newAc.min_outcome_score = patch.acceptance_criteria.min_outcome_score;
    }
    if (patch.acceptance_criteria.min_pass_rate !== undefined) {
      newAc.min_pass_rate = patch.acceptance_criteria.min_pass_rate;
    }
    if (JSON.stringify(baseAc ?? {}) !== JSON.stringify(newAc)) {
      merged.acceptance_criteria = newAc;
      changed.push("acceptance_criteria");
    }
  }
  if (patch.tags !== undefined) {
    const before = JSON.stringify(base.tags ?? []);
    const after  = JSON.stringify(patch.tags);
    if (before !== after) {
      merged.tags = patch.tags;
      changed.push("tags");
    }
  }
  return { merged, changed };
}

async function openProjectDb(projectHash: string): Promise<DatabaseSync> {
  const dbDir = join(homedir(), ".claude", "zc-ctx", "sessions");
  mkdirSync(dbDir, { recursive: true });
  const dbFile = join(dbDir, `${projectHash}.db`);
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode = WAL");
  // Ensure mig 26 (skill_revisions table + columns) is applied
  try { runMigrations(db); } catch { /* tolerate */ }
  return db;
}

/**
 * Look up project_hash from skill_id (PG primary). Falls back to the project_hash
 * embedded in the skill_id's scope when scope='project:<hash>'.
 */
async function resolveProjectHashForSkill(skillId: string): Promise<string | null> {
  // Skill IDs follow `name@version@scope` where scope = 'global' | 'project:<hash>'.
  // For global scope, return synthetic '_global' so editSkillFrontmatter can still
  // open SOME SQLite DB for the dual-backend write — the PG write is what matters
  // for global skills; the local SQLite is a best-effort cache.
  const parts = skillId.split("@");
  if (parts.length >= 3) {
    const scope = parts.slice(2).join("@");
    if (scope === "global")           return "_global";
    if (scope.startsWith("project:")) return scope.slice("project:".length);
  }
  // Fallback: PG lookup
  try {
    return await withClient(async (c) => {
      const res = await c.query<{ scope: string }>(
        `SELECT scope FROM skills_pg WHERE skill_id = $1 LIMIT 1`,
        [skillId],
      );
      const sc = res.rows[0]?.scope ?? "";
      if (sc === "global")           return "_global";
      if (sc.startsWith("project:")) return sc.slice("project:".length);
      return null;
    });
  } catch { return null; }
}

export async function editSkillFrontmatter(args: EditFrontmatterArgs): Promise<EditFrontmatterResult> {
  validatePatch(args.changes);
  if (!args.rationale || args.rationale.trim().length === 0) {
    throw new Error("rationale is required (audit trail)");
  }
  const projectHash = await resolveProjectHashForSkill(args.skill_id);
  if (!projectHash) throw new Error(`Cannot resolve project_hash for ${args.skill_id} — is the skill in PG?`);

  const db = await openProjectDb(projectHash);
  try {
    const current = await getSkillById(db, args.skill_id);
    if (!current) throw new Error(`Skill not found: ${args.skill_id}`);

    const { merged, changed } = applyPatch(current.frontmatter, args.changes);
    if (changed.length === 0) {
      throw new Error("No changes to apply (all patch fields match the current frontmatter)");
    }

    const newVersion = bumpPatch(current.frontmatter.version);
    const newSkill = await buildSkill(
      { ...merged, version: newVersion },
      current.body,                              // ← body preserved verbatim
      { promoted_from: current.skill_id },        // ← provenance
    );

    await archiveSkill(db, current.skill_id, `frontmatter-edited:${changed.join(",")}`);
    await upsertSkill(db, newSkill);

    // skill_revisions audit row (mig 26)
    const revisionId = `rev-${randomUUID().slice(0, 12)}`;
    const decidedBy  = args.decided_by ?? "operator-dashboard";
    const createdAt  = new Date().toISOString();
    db.prepare(`
      INSERT INTO skill_revisions
        (revision_id, skill_name, scope, from_version, to_version, action,
         source_result_id, reverted_to_body_of, decided_by, rationale, created_at)
      VALUES (?, ?, ?, ?, ?, 'manual', NULL, NULL, ?, ?, ?)
    `).run(revisionId, current.frontmatter.name, current.frontmatter.scope,
           current.frontmatter.version, newVersion, decidedBy, args.rationale, createdAt);
    try {
      await withClient(async (c) => {
        await c.query(
          `INSERT INTO skill_revisions_pg
            (revision_id, skill_name, scope, from_version, to_version, action,
             source_result_id, reverted_to_body_of, decided_by, rationale, created_at)
           VALUES ($1, $2, $3, $4, $5, 'manual', NULL, NULL, $6, $7, $8)
           ON CONFLICT (revision_id) DO NOTHING`,
          [revisionId, current.frontmatter.name, current.frontmatter.scope,
           current.frontmatter.version, newVersion, decidedBy, args.rationale, createdAt],
        );
      });
    } catch { /* tolerate */ }

    // Broadcast for visibility
    try {
      const projectPath = projectHash;  // best-effort; broadcast routing tolerant
      broadcastFact(projectPath, "STATUS", decidedBy, {
        task: `skill-frontmatter-edited:${newSkill.skill_id}`,
        state: "skill-frontmatter-edited",
        summary: JSON.stringify({
          prior_skill_id: current.skill_id,
          new_skill_id:   newSkill.skill_id,
          changed_fields: changed,
          revision_id:    revisionId,
          rationale:      args.rationale.slice(0, 200),
        }).slice(0, 1000),
        importance: 3,
      });
    } catch { /* best-effort */ }

    return {
      prior_skill_id: current.skill_id,
      new_skill_id:   newSkill.skill_id,
      changed_fields: changed,
      revision_id:    revisionId,
    };
  } finally {
    try { db.close(); } catch { /* noop */ }
  }
}
