/**
 * Backend-aware skill storage dispatch (v0.18.0)
 * ===============================================
 *
 * Single entry point that routes skill CRUD to SQLite, Postgres, or both
 * (dual mode) based on `ZC_TELEMETRY_BACKEND`. Mirrors the dispatch pattern
 * used by `outcomes.ts` + `telemetry.ts`.
 *
 *   ZC_TELEMETRY_BACKEND=sqlite   → SQLite per-project DB only
 *   ZC_TELEMETRY_BACKEND=postgres → Postgres only (skills_pg + ...)
 *   ZC_TELEMETRY_BACKEND=dual     → write to both (PG primary, SQLite mirror)
 *
 * Reads in dual mode prefer PG (cross-machine consistency) and fall back to
 * SQLite if PG is unreachable.
 *
 * The original `storage.ts` module remains the SQLite-only path, kept for
 * backward compatibility + because the test suite exercises it directly.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Skill, SkillRun, SkillMutation, SkillScope } from "./types.js";
import * as sqlite from "./storage.js";
import * as pg from "./storage_pg.js";
import { createHash } from "node:crypto";

function getBackend(): "sqlite" | "postgres" | "dual" {
  const raw = (process.env.ZC_TELEMETRY_BACKEND || "sqlite").toLowerCase();
  if (raw === "postgres" || raw === "dual") return raw;
  return "sqlite";
}

/** Compute the project_hash used by skill_runs_pg / skill_mutations_pg. */
export function projectHashOf(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

// ─── Skills CRUD ─────────────────────────────────────────────────────────────

export async function upsertSkill(db: DatabaseSync, skill: Skill): Promise<void> {
  const backend = getBackend();
  if (backend === "postgres" || backend === "dual") {
    try { await pg.upsertSkillPg(skill); }
    catch (e) { if (backend === "postgres") throw e; }
  }
  if (backend === "sqlite" || backend === "dual") {
    await sqlite.upsertSkill(db, skill);
  }
}

export async function getSkillById(db: DatabaseSync, skill_id: string): Promise<Skill | null> {
  const backend = getBackend();
  if (backend === "postgres" || backend === "dual") {
    try {
      const r = await pg.getSkillByIdPg(skill_id);
      if (r) return r;
      if (backend === "postgres") return null;
    } catch (e) {
      if (backend === "postgres") throw e;
      // dual: fall through to SQLite
    }
  }
  return sqlite.getSkillById(db, skill_id);
}

export async function getActiveSkill(db: DatabaseSync, name: string, scope: SkillScope): Promise<Skill | null> {
  const backend = getBackend();
  if (backend === "postgres" || backend === "dual") {
    try {
      const r = await pg.getActiveSkillPg(name, scope);
      if (r) return r;
      if (backend === "postgres") return null;
    } catch (e) {
      if (backend === "postgres") throw e;
    }
  }
  return sqlite.getActiveSkill(db, name, scope);
}

export async function resolveSkill(db: DatabaseSync, name: string, projectScope: SkillScope): Promise<Skill | null> {
  const backend = getBackend();
  if (backend === "postgres" || backend === "dual") {
    try {
      const r = await pg.resolveSkillPg(name, projectScope);
      if (r) return r;
      if (backend === "postgres") return null;
    } catch (e) {
      if (backend === "postgres") throw e;
    }
  }
  return sqlite.resolveSkill(db, name, projectScope);
}

export async function listActiveSkills(db: DatabaseSync): Promise<Skill[]> {
  const backend = getBackend();
  if (backend === "postgres" || backend === "dual") {
    try { return await pg.listActiveSkillsPg(); }
    catch (e) {
      if (backend === "postgres") throw e;
    }
  }
  return sqlite.listActiveSkills(db);
}

export async function archiveSkill(db: DatabaseSync, skill_id: string, reason: string): Promise<boolean> {
  const backend = getBackend();
  let changed = false;
  if (backend === "postgres" || backend === "dual") {
    try { changed = await pg.archiveSkillPg(skill_id, reason) || changed; }
    catch (e) { if (backend === "postgres") throw e; }
  }
  if (backend === "sqlite" || backend === "dual") {
    changed = sqlite.archiveSkill(db, skill_id, reason) || changed;
  }
  return changed;
}

// ─── skill_runs ──────────────────────────────────────────────────────────────

export async function recordSkillRun(db: DatabaseSync, run: SkillRun, projectPath: string): Promise<void> {
  const backend = getBackend();
  // v0.22.0 — PG mirror is now best-effort even in 'sqlite' mode if PG creds
  // are present. The agent's local MCP server defaults to sqlite, but if the
  // operator runs Docker (ZC_POSTGRES_HOST set) we mirror to skill_runs_pg
  // so the dashboard can see it. This closes the v0.21.x gap where skill_runs
  // were never visible to the operator dashboard.
  const projectHash = projectHashOf(projectPath);
  const runWithProject: SkillRun = { ...run, project_hash: run.project_hash ?? projectHash };

  if (backend === "postgres" || backend === "dual") {
    try { await pg.recordSkillRunPg(runWithProject, projectHash); }
    catch (e) { if (backend === "postgres") throw e; }
  } else if (process.env.ZC_POSTGRES_HOST || process.env.ZC_POSTGRES_PASSWORD) {
    // Best-effort PG mirror in sqlite-mode — log on failure, don't throw.
    pg.recordSkillRunPg(runWithProject, projectHash).catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[storage_dual] PG mirror failed (sqlite mode, best-effort):", (e as Error).message);
    });
  }
  if (backend === "sqlite" || backend === "dual") {
    sqlite.recordSkillRun(db, runWithProject);
  }
}

// v0.22.0 — link tool calls captured during a skill_run (currentSkillContext)
// to the run. Writes to BOTH local SQLite and PG (best-effort) so the L1
// hook + dashboard both have the trail.
export async function linkSkillRunToolCalls(
  db: DatabaseSync,
  run_id: string,
  call_ids: string[],
  ts: string,
): Promise<void> {
  if (call_ids.length === 0) return;
  // Local SQLite (used by L1 hook + offline analysis)
  try { sqlite.linkSkillRunToolCalls(db, run_id, call_ids, ts); }
  catch (e) {
    // eslint-disable-next-line no-console
    console.error("[storage_dual] SQLite link skill_run_tool_calls failed:", (e as Error).message);
  }
  // PG (used by dashboard)
  if (process.env.ZC_POSTGRES_HOST || process.env.ZC_POSTGRES_PASSWORD) {
    pg.linkSkillRunToolCallsPg(run_id, call_ids).catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[storage_dual] PG link skill_run_tool_calls failed:", (e as Error).message);
    });
  }
}

// v0.22.0 — operator action log. Best-effort PG write.
export async function recordMutationReview(args: {
  review_id: string;
  mutation_id: string;
  result_id?: string | null;
  action: "approve" | "reject" | "defer";
  operator: string;
  rationale?: string | null;
}): Promise<void> {
  if (process.env.ZC_POSTGRES_HOST || process.env.ZC_POSTGRES_PASSWORD) {
    try { await pg.recordMutationReviewPg(args); }
    catch (e) {
      // eslint-disable-next-line no-console
      console.error("[storage_dual] PG mutation_review write failed:", (e as Error).message);
    }
  }
}

export async function getRecentSkillRuns(db: DatabaseSync, skill_id: string, limit = 20): Promise<SkillRun[]> {
  const backend = getBackend();
  if (backend === "postgres" || backend === "dual") {
    try { return await pg.getRecentSkillRunsPg(skill_id, limit); }
    catch (e) {
      if (backend === "postgres") throw e;
    }
  }
  return sqlite.getRecentSkillRuns(db, skill_id, limit);
}

// ─── skill_mutations ─────────────────────────────────────────────────────────

export async function recordMutation(db: DatabaseSync, m: SkillMutation, projectPath: string): Promise<void> {
  const backend = getBackend();
  if (backend === "postgres" || backend === "dual") {
    try { await pg.recordMutationPg(m, projectHashOf(projectPath)); }
    catch (e) { if (backend === "postgres") throw e; }
  }
  if (backend === "sqlite" || backend === "dual") {
    sqlite.recordMutation(db, m);
  }
}

export async function resolveMutation(
  db: DatabaseSync,
  mutation_id: string,
  patch: { replay_score?: number; promoted?: boolean; promoted_to_skill_id?: string; judged_by?: string; judge_score?: number; judge_rationale?: string },
): Promise<boolean> {
  const backend = getBackend();
  let changed = false;
  if (backend === "postgres" || backend === "dual") {
    try { changed = await pg.resolveMutationPg(mutation_id, patch) || changed; }
    catch (e) { if (backend === "postgres") throw e; }
  }
  if (backend === "sqlite" || backend === "dual") {
    changed = sqlite.resolveMutation(db, mutation_id, patch) || changed;
  }
  return changed;
}

// Re-export PG-only helpers (no SQLite equivalent yet)
export { findGlobalPromotionCandidates } from "./storage_pg.js";
