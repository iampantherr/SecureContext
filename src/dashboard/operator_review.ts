/**
 * v0.18.2 Sprint 2.6 — shared operator-review flow.
 *
 * Same logic the MCP tool zc_mutation_approve uses — extracted here so the
 * HTTP dashboard route can call it without going through MCP. Both surfaces
 * (CLI/MCP and browser/HTMX) end up at this implementation.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

import { fetchByResultId, approveMutation, rejectMutation } from "../skills/mutation_results.js";
import { getSkillById, archiveSkill, upsertSkill } from "../skills/storage_dual.js";
import { buildSkill } from "../skills/loader.js";
import { enqueueTask } from "../task_queue.js";
import { broadcastFact } from "../memory.js";
import { withClient } from "../pg_pool.js";

export interface ApproveArgs {
  result_id:               string;
  picked_candidate_index:  number;
  rationale:               string;
  auto_reassign:           boolean;
  decided_by?:             string;
}

export interface ApproveResult {
  prior_skill_id:  string;
  new_skill_id:    string;
  picked_score:    number;
  retry_task_id:   string | null;
  original_role:   string | null;
}

export interface RejectArgs {
  result_id:  string;
  rationale:  string;
  decided_by?: string;
}

function bumpPatch(version: string): string {
  const parts = version.split(".");
  if (parts.length !== 3) return version + ".1";
  const patch = parseInt(parts[2], 10);
  return `${parts[0]}.${parts[1]}.${Number.isFinite(patch) ? patch + 1 : 1}`;
}

/**
 * Resolve the project SQLite DB for a given project_hash. The dashboard
 * doesn't have direct knowledge of which project owns a result; we look it
 * up from the mutation_results_pg row's project_hash column.
 */
async function openProjectDb(projectHash: string): Promise<DatabaseSync> {
  const dbDir = join(homedir(), ".claude", "zc-ctx", "sessions");
  mkdirSync(dbDir, { recursive: true });
  const dbFile = join(dbDir, `${projectHash}.db`);
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode = WAL");
  // v0.18.2 Sprint 2.6 — ensure project DB has all migrations applied.
  // Otherwise approve/reject UPDATEs into mutation_results fail with "no
  // such column: consumed_decision" because mig 25 wasn't applied to a DB
  // created before this sprint.
  try {
    const { runMigrations } = await import("../migrations.js");
    runMigrations(db);
  } catch { /* tolerate; columns may already exist */ }
  return db;
}

/**
 * Best-effort projectPath reverse-lookup. We need it for broadcastFact +
 * archiveSkill (which use projectPath, not projectHash). Try the registry
 * first; fall back to scanning agents.json. If unresolvable, fall through
 * with the project_hash as a stand-in (broadcasts will land in a different
 * SQLite file but the PG-side mirror is still correct).
 */
async function resolveProjectPath(projectHash: string): Promise<string> {
  try {
    const r = await withClient(async (c) => {
      const res = await c.query<{ project_path: string }>(
        // task_queue_pg payload often carries project_path; if not, fall through
        `SELECT (payload->>'project_path') AS project_path
           FROM task_queue_pg
          WHERE project_hash = $1
          ORDER BY ts DESC LIMIT 1`,
        [projectHash],
      );
      return res.rows[0]?.project_path ?? null;
    });
    if (r) return r;
  } catch { /* fall through */ }
  // Fallback: synthesize a hash-based virtual path. broadcastFact will use
  // its OWN hash to derive the project DB, which will round-trip correctly
  // ONLY if the input string hashes to the same value. We can't fake that,
  // so we just return the hash itself; if broadcasts land in the "wrong"
  // SQLite file the PG-side audit log still has the right project_hash
  // tagging on the broadcast row.
  return projectHash;
}

export async function handleApproveFromDashboard(args: ApproveArgs): Promise<ApproveResult> {
  const db = await openDbForResult(args.result_id);
  try {
    const result = await fetchByResultId(db, args.result_id);
    if (!result) throw new Error(`Result ${args.result_id} not found OR bodies_hash mismatch`);
    if (result.consumed_at) throw new Error(`Result ${args.result_id} already consumed (decision=${result.consumed_decision})`);
    if (args.picked_candidate_index < 0 || args.picked_candidate_index >= result.bodies.length) {
      throw new Error(`picked_candidate_index ${args.picked_candidate_index} out of range (bundle has ${result.bodies.length} candidates)`);
    }
    const picked = result.bodies[args.picked_candidate_index];

    const current = await getSkillById(db, result.skill_id);
    if (!current) throw new Error(`Skill ${result.skill_id} not found in storage`);

    const newVersion = bumpPatch(current.frontmatter.version);
    const newSkill = await buildSkill(
      { ...current.frontmatter, version: newVersion },
      picked.candidate_body,
      { promoted_from: args.result_id },
    );

    await archiveSkill(db, current.skill_id, `promoted_to_${newSkill.skill_id}`);
    await upsertSkill(db, newSkill);
    await approveMutation(db, args.result_id, args.picked_candidate_index, args.rationale, args.decided_by ?? "operator-dashboard");

    let retry_task_id: string | null = null;
    if (args.auto_reassign && result.original_role) {
      try {
        const taskId = `retry-${randomUUID().slice(0, 12)}`;
        await enqueueTask({
          taskId,
          projectHash: result.project_hash,
          role: result.original_role,
          payload: {
            kind:                  "skill-revalidation",
            skill_id:              newSkill.skill_id,
            fixtures:              newSkill.frontmatter.fixtures ?? [],
            retry_after_promotion: true,
            origin_mutation_result: args.result_id,
            origin_task_id:        result.original_task_id,
            instructions:
              "v0.18.2 RETRY-AFTER-PROMOTION: re-run all skill fixtures against the new version. " +
              "For each fixture, call zc_record_skill_outcome with was_retry_after_promotion=TRUE. " +
              "Then broadcast STATUS state='retry-pass' (or 'retry-fail') summarizing pass/fail counts.",
          },
        });
        retry_task_id = taskId;
      } catch {
        // best-effort: don't fail the approval
      }
    }

    // Broadcast skill-promoted (best-effort; skill change already landed)
    try {
      const projectPath = await resolveProjectPath(result.project_hash);
      const summary = JSON.stringify({
        prior_skill_id: current.skill_id,
        new_skill_id:   newSkill.skill_id,
        picked_index:   args.picked_candidate_index,
        picked_score:   picked.self_rated_score,
        from_result_id: args.result_id,
        retry_task_id,
        decided_by:     args.decided_by ?? "operator-dashboard",
      }).slice(0, 1000);
      broadcastFact(projectPath, "STATUS", args.decided_by ?? "operator-dashboard", {
        task: `skill-promoted:${newSkill.skill_id}`,
        state: "skill-promoted",
        summary,
        importance: 4,
      });
    } catch { /* broadcast best-effort */ }

    return {
      prior_skill_id: current.skill_id,
      new_skill_id:   newSkill.skill_id,
      picked_score:   picked.self_rated_score,
      retry_task_id,
      original_role:  result.original_role,
    };
  } finally {
    try { db.close(); } catch { /* noop */ }
  }
}

export async function handleRejectFromDashboard(args: RejectArgs): Promise<void> {
  const db = await openDbForResult(args.result_id);
  try {
    const result = await fetchByResultId(db, args.result_id);
    if (!result) throw new Error(`Result ${args.result_id} not found OR bodies_hash mismatch`);
    if (result.consumed_at) throw new Error(`Result ${args.result_id} already consumed (decision=${result.consumed_decision})`);

    await rejectMutation(db, args.result_id, args.rationale, args.decided_by ?? "operator-dashboard");

    try {
      const projectPath = await resolveProjectPath(result.project_hash);
      broadcastFact(projectPath, "STATUS", args.decided_by ?? "operator-dashboard", {
        task: `mutation-rejected:${args.result_id}`,
        state: "mutation-rejected",
        summary: JSON.stringify({ result_id: args.result_id, rationale: args.rationale.slice(0, 400) }).slice(0, 1000),
        importance: 3,
      });
    } catch { /* broadcast best-effort */ }
  } finally {
    try { db.close(); } catch { /* noop */ }
  }
}

/**
 * Look up the project_hash for a result_id (PG primary; bodies are in PG when
 * agents run with ZC_TELEMETRY_BACKEND=postgres) and open that project's
 * SQLite DB. The SQLite DB is needed because archiveSkill/upsertSkill/buildSkill
 * dispatch through both backends in dual mode.
 */
async function openDbForResult(result_id: string): Promise<DatabaseSync> {
  let projectHash: string | null = null;
  try {
    projectHash = await withClient(async (c) => {
      const res = await c.query<{ project_hash: string }>(
        `SELECT project_hash FROM mutation_results_pg WHERE result_id = $1`,
        [result_id],
      );
      return res.rows[0]?.project_hash ?? null;
    });
  } catch { /* PG might be unavailable */ }
  if (!projectHash) {
    // Last-resort fallback: assume the result is in some SQLite DB. We can't
    // know which one without scanning every project DB; throw a clear error.
    throw new Error(`Cannot locate project_hash for result ${result_id} (PG unavailable or row missing)`);
  }
  // sanity-check the hash shape
  if (!/^[0-9a-f]{16}$/.test(projectHash)) throw new Error(`Invalid project_hash for ${result_id}`);
  return await openProjectDb(projectHash);
}
