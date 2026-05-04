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
import { withClient } from "../pg_pool.js";

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

/**
 * Upsert source for the audit log. Marketplace pulls / mutator candidates /
 * operator-authored / auto-import all log a different `source` so the
 * dashboard can surface "where did this skill come from."
 *
 * `"test"` is reserved for unit-test round-trip fixtures: it BYPASSES the
 * lint and security gates because the synthetic fixtures are intentionally
 * tiny / placeholder. NEVER use "test" in production paths — the gates
 * exist for a reason.
 */
export type SkillUpsertSource = "mutator" | "marketplace" | "operator" | "auto-import" | "unknown" | "test";

/**
 * Upsert a skill into both PG and local SQLite (per backend mode).
 *
 * v0.23.0 GATES (in order):
 *   1. Lint (Phase 1 #4) — structural quality bar (description length,
 *      body sections, secret patterns). Errors reject. Warnings logged.
 *   2. Security scan (Phase 1 #1) — 8-point scan. Score >= 7 required;
 *      score 8/8 auto-passes; 7/8 logs as "warn-pass" needing operator
 *      review (still upserts but flagged); ≤6/8 rejects outright.
 *   3. Audit log — every scan result (pass or fail) lands in
 *      skill_security_scans_pg with the source attribution.
 *
 * Both gates run BEFORE any DB write. A failed scan never reaches the
 * skills_pg INSERT. The audit row is written regardless of pass/fail so
 * the operator can see attempted promotions and their rejection reasons.
 */
export async function upsertSkill(
  db: DatabaseSync,
  skill: Skill,
  source: SkillUpsertSource = "unknown",
): Promise<void> {
  // v0.23.0: synthetic test fixtures bypass the lint / security gates.
  // Round-trip / scoring tests use intentionally tiny fixtures that wouldn't
  // pass the production bar. Real ingestion paths (operator, mutator,
  // marketplace, auto-import, unknown) all run the gates.
  if (source === "test") {
    const backend = getBackend();
    if (backend === "postgres" || backend === "dual") {
      try { await pg.upsertSkillPg(skill); }
      catch (e) { if (backend === "postgres") throw e; }
    }
    if (backend === "sqlite" || backend === "dual") {
      await sqlite.upsertSkill(db, skill);
    }
    return;
  }

  // v0.23.0 Phase 1 #4 — lint gate
  const { lintSkillBody } = await import("./lint.js");
  const lintResult = lintSkillBody(skill.body, skill.frontmatter);
  if (!lintResult.ok) {
    throw new Error(`Cannot upsert skill ${skill.skill_id}: lint failed with ${lintResult.errors.length} error(s) — ${lintResult.errors.join("; ")}`);
  }

  // v0.23.0 Phase 1 #1 — security scan gate
  const { scanSkillBody } = await import("./security_scan.js");
  const scanResult = await scanSkillBody(skill);

  // Always audit-log the scan, regardless of outcome
  await logSecurityScan(skill, scanResult, source);

  // v0.23.0 Phase 1 #1 — gate logic:
  //   ANY check with severity='block' that failed → REJECT (regardless of score).
  //     This catches: secret_scan, prompt_injection, tool_spawn, body_length,
  //     frontmatter_integrity. These are categorical risks; one fail is one
  //     too many. A skill with a leaked OpenAI key scores 7/8 but MUST be
  //     rejected — it doesn't matter that 7 other checks passed.
  //   Only severity='warn' failures contribute to the warn-pass path:
  //     filesystem_escape, network_exfil, sleep_abuse. Those are fuzzy
  //     heuristics where a score-based threshold makes sense.
  const blockingFailures = scanResult.checks.filter((c) => !c.passed && c.severity === "block");
  if (blockingFailures.length > 0) {
    const names = blockingFailures.map((c) => `${c.name} (${c.detail ?? "no detail"})`);
    throw new Error(
      `Cannot upsert skill ${skill.skill_id}: security scan blocked — ${names.join("; ")}`,
    );
  }
  // No block-severity failures. If score is still ≤6 (lots of warn-fails),
  // require operator review explicitly.
  if (scanResult.score <= 6) {
    const warnNames = scanResult.checks.filter((c) => !c.passed).map((c) => c.name);
    throw new Error(
      `Cannot upsert skill ${skill.skill_id}: security scan score ${scanResult.score}/8 too low (failed: ${warnNames.join(", ")}); requires operator review`,
    );
  }
  // score 7-8/8 with no block-severity failures: pass. Audit row already written.

  const backend = getBackend();
  if (backend === "postgres" || backend === "dual") {
    try { await pg.upsertSkillPg(skill); }
    catch (e) { if (backend === "postgres") throw e; }
  }
  if (backend === "sqlite" || backend === "dual") {
    await sqlite.upsertSkill(db, skill);
  }
}

/**
 * Best-effort write of a security scan to skill_security_scans_pg.
 * Never throws — if PG is unreachable or the table doesn't exist, we
 * just log to stderr. The skill upsert proceeds based on the scan score.
 */
async function logSecurityScan(
  skill: Skill,
  scan: import("./security_scan.js").ScanResult,
  source: SkillUpsertSource,
): Promise<void> {
  if (!process.env.ZC_POSTGRES_HOST && !process.env.ZC_POSTGRES_PASSWORD) return;
  try {
    const failureRows = scan.checks
      .filter((c) => !c.passed)
      .map((c) => ({ name: c.name, severity: c.severity, detail: c.detail ?? null }));
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO skill_security_scans_pg
           (skill_id, candidate_hmac, body_hash, score, passed, failures, source)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          skill.skill_id,
          skill.body_hmac,
          scan.body_hash,
          scan.score,
          scan.passed,
          JSON.stringify(failureRows),
          source,
        ],
      );
    });
  } catch (e) {
    process.stderr.write(`[skill-security-scan] audit-log write failed: ${(e as Error).message}\n`);
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

/**
 * v0.23.0 Phase 1 F — fetch operator-tagged exemplar runs for a skill.
 *
 * Reads from skill_runs_pg WHERE is_exemplar = TRUE. PG-only (the SQLite
 * mirror does not carry the is_exemplar column — this is a v0.23+ feature
 * and requires the PG backend). Returns [] if PG is unavailable, so the
 * mutation cycle remains usable in SQLite-only test environments.
 */
export async function getExemplarRuns(skill_id: string, limit = 5): Promise<Array<{
  run_id:    string;
  inputs?:   unknown;
  evidence?: unknown;
  note?:     string;
  tagged_at?: string;
}>> {
  if (!(process.env.ZC_POSTGRES_HOST || process.env.ZC_POSTGRES_PASSWORD)) {
    return [];
  }
  try {
    return await withClient(async (c) => {
      // skill_runs_pg has no `evidence` column — the operator's note + the
      // inputs payload is the evidence we surface to the proposer. The
      // `evidence` field on the exemplar shape stays undefined and the
      // mutator's prompt template handles that gracefully (renders as {}).
      const r = await c.query(
        `SELECT run_id, inputs, exemplar_note, exemplar_tagged_at
           FROM skill_runs_pg
           WHERE skill_id = $1 AND is_exemplar = TRUE
           ORDER BY exemplar_tagged_at DESC NULLS LAST
           LIMIT $2`,
        [skill_id, limit],
      );
      return r.rows.map((row) => ({
        run_id:    row.run_id,
        inputs:    row.inputs ?? undefined,
        note:      row.exemplar_note ?? undefined,
        tagged_at: row.exemplar_tagged_at ?? undefined,
      }));
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[storage_dual] getExemplarRuns failed (returning []):", (e as Error).message);
    return [];
  }
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
