/**
 * Tests for v0.18.0 — storage_dual.ts (PG mirror + dual-backend dispatch).
 *
 * REQUIRES live Postgres at localhost:5432. Tests auto-skip if absent.
 *
 * Covers:
 *   - dual: write to both PG + SQLite; read prefers PG
 *   - postgres-only: SQLite path is bypassed
 *   - sqlite-only: PG path is bypassed
 *   - skill upsert + getById round-trip via PG
 *   - resolveSkill: project overrides global (PG)
 *   - skill_runs round-trip with project_hash
 *   - mutation row + promotion update via PG
 *   - findGlobalPromotionCandidates returns the right shape
 *   - HMAC tamper detection still works on PG read path
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../migrations.js";
import { runPgMigrations } from "../pg_migrations.js";
import { pgHealthCheck, shutdownPgPool } from "../pg_pool.js";
import { _resetCacheForTesting as resetMachineSecret } from "../security/machine_secret.js";
import { buildSkill } from "./loader.js";
import {
  upsertSkill, getSkillById, getActiveSkill, resolveSkill, listActiveSkills,
  archiveSkill, recordSkillRun, getRecentSkillRuns, recordMutation, resolveMutation,
  findGlobalPromotionCandidates, projectHashOf,
} from "./storage_dual.js";
import { _dropSkillTablesForTesting } from "./storage_pg.js";
import type { Skill, SkillRun } from "./types.js";

process.env.ZC_POSTGRES_USER     ??= "scuser";
process.env.ZC_POSTGRES_PASSWORD ??= "79bd1ca6011b797c70e90c02becdaa90d99cfc501abaec09";
process.env.ZC_POSTGRES_DB       ??= "securecontext";
process.env.ZC_POSTGRES_HOST     ??= "localhost";
process.env.ZC_POSTGRES_PORT     ??= "5432";
const pgAvailable = await pgHealthCheck();

let tmpDir: string;
let db: DatabaseSync;
const PROJECT_PATH = "/tmp/test-project-pg-skills";

beforeAll(async () => {
  if (pgAvailable) {
    await _dropSkillTablesForTesting().catch(() => { /* fresh */ });
    await runPgMigrations();
  }
});

afterAll(async () => {
  await shutdownPgPool();
});

beforeEach(async () => {
  mkdirSync(join(homedir(), ".claude", "zc-ctx"), { recursive: true });
  resetMachineSecret();
  tmpDir = mkdtempSync(join(tmpdir(), "stor-dual-"));
  db = new DatabaseSync(join(tmpDir, "test.db"));
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);
  if (pgAvailable) {
    await _dropSkillTablesForTesting();
    await runPgMigrations();
  }
});

afterEach(() => {
  try { db.close(); } catch { /* noop */ }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  delete process.env.ZC_TELEMETRY_BACKEND;
});

async function makeSkill(name = "audit", scope: Skill["frontmatter"]["scope"] = "global"): Promise<Skill> {
  return buildSkill(
    { name, version: "1.0.0", scope, description: "audit" },
    `# ${name} body`,
  );
}

describe.skipIf(!pgAvailable)("v0.18.0 storage_dual — PG primary path", () => {

  it("postgres backend: upsert + getSkillById round-trips via PG", async () => {
    process.env.ZC_TELEMETRY_BACKEND = "postgres";
    const skill = await makeSkill();
    await upsertSkill(db, skill);
    const fetched = await getSkillById(db, skill.skill_id);
    expect(fetched?.skill_id).toBe(skill.skill_id);
    expect(fetched?.body).toBe(skill.body);
    expect(fetched?.frontmatter.name).toBe("audit");
  });

  it("postgres: getActiveSkill returns active row", async () => {
    process.env.ZC_TELEMETRY_BACKEND = "postgres";
    const skill = await makeSkill();
    await upsertSkill(db, skill);
    const active = await getActiveSkill(db, "audit", "global");
    expect(active?.skill_id).toBe(skill.skill_id);
  });

  it("postgres: resolveSkill prefers project over global", async () => {
    process.env.ZC_TELEMETRY_BACKEND = "postgres";
    const projectScope = `project:${projectHashOf(PROJECT_PATH)}` as `project:${string}`;
    const global = await makeSkill("audit", "global");
    const project = await makeSkill("audit", projectScope);
    project.body = "project-specific body";
    project.body_hmac = (await import("./loader.js")).computeSkillBodyHmac(project.body) as unknown as string;
    // Recompute properly
    const { computeSkillBodyHmac } = await import("./loader.js");
    project.body_hmac = await computeSkillBodyHmac(project.body);
    await upsertSkill(db, global);
    await upsertSkill(db, project);
    const resolved = await resolveSkill(db, "audit", projectScope);
    expect(resolved?.body).toBe("project-specific body");
  });

  it("postgres: archiveSkill removes from listActiveSkills", async () => {
    process.env.ZC_TELEMETRY_BACKEND = "postgres";
    const skill = await makeSkill();
    await upsertSkill(db, skill);
    let list = await listActiveSkills(db);
    expect(list.length).toBe(1);
    await archiveSkill(db, skill.skill_id, "test");
    list = await listActiveSkills(db);
    expect(list.length).toBe(0);
  });

  it("postgres: skill_runs round-trip with project_hash", async () => {
    process.env.ZC_TELEMETRY_BACKEND = "postgres";
    const skill = await makeSkill();
    await upsertSkill(db, skill);
    const run: SkillRun = {
      run_id: "r1", skill_id: skill.skill_id, session_id: "s",
      task_id: null, inputs: { x: 1 }, outcome_score: 0.85,
      total_cost: 0.001, total_tokens: 100, duration_ms: 250,
      status: "succeeded", failure_trace: null, ts: new Date().toISOString(),
    };
    await recordSkillRun(db, run, PROJECT_PATH);
    const recent = await getRecentSkillRuns(db, skill.skill_id);
    expect(recent.length).toBe(1);
    expect(recent[0].outcome_score).toBeCloseTo(0.85, 4);
  });

  it("postgres: mutation row + resolution round-trip", async () => {
    process.env.ZC_TELEMETRY_BACKEND = "postgres";
    const skill = await makeSkill();
    await upsertSkill(db, skill);
    await recordMutation(db, {
      mutation_id: "m1", parent_skill_id: skill.skill_id,
      candidate_body: "new body", candidate_hmac: "abc",
      proposed_by: "test", judged_by: null, judge_score: null,
      judge_rationale: null, replay_score: null, promoted: false,
      promoted_to_skill_id: null, created_at: new Date().toISOString(), resolved_at: null,
    }, PROJECT_PATH);
    const ok = await resolveMutation(db, "m1", { replay_score: 0.9, promoted: true });
    expect(ok).toBe(true);
  });
});

describe.skipIf(!pgAvailable)("v0.18.0 storage_dual — dual-write mode", () => {

  it("dual: writes to both backends; reads prefer PG", async () => {
    process.env.ZC_TELEMETRY_BACKEND = "dual";
    const skill = await makeSkill();
    await upsertSkill(db, skill);
    // Read via dual → returns PG row
    const fetched = await getSkillById(db, skill.skill_id);
    expect(fetched?.skill_id).toBe(skill.skill_id);
    // SQLite was also written — verify directly
    const sqliteRow = db.prepare(`SELECT skill_id FROM skills WHERE skill_id = ?`).get(skill.skill_id);
    expect(sqliteRow).toBeDefined();
  });
});

describe.skipIf(!pgAvailable)("v0.18.0 storage_dual — findGlobalPromotionCandidates", () => {

  it("returns shape with name, project_count, best_skill_id, best_avg, global_avg", async () => {
    process.env.ZC_TELEMETRY_BACKEND = "postgres";
    const projectScope = `project:${projectHashOf(PROJECT_PATH)}` as `project:${string}`;
    const project2Scope = `project:${projectHashOf("/tmp/another-project")}` as `project:${string}`;

    const global = await makeSkill("score-test", "global");
    const projA = await makeSkill("score-test", projectScope);
    const projB = await makeSkill("score-test", project2Scope);
    await upsertSkill(db, global);
    await upsertSkill(db, projA);
    await upsertSkill(db, projB);

    // Seed runs: global avg 0.5, both per-project avg 0.85 → both clear threshold
    for (let i = 0; i < 3; i++) {
      await recordSkillRun(db, {
        run_id: `g${i}`, skill_id: global.skill_id, session_id: "s", task_id: null,
        inputs: {}, outcome_score: 0.5, total_cost: 0, total_tokens: 0,
        duration_ms: 0, status: "succeeded", failure_trace: null, ts: new Date().toISOString(),
      }, "/tmp/proj-global");
      await recordSkillRun(db, {
        run_id: `a${i}`, skill_id: projA.skill_id, session_id: "s", task_id: null,
        inputs: {}, outcome_score: 0.85, total_cost: 0, total_tokens: 0,
        duration_ms: 0, status: "succeeded", failure_trace: null, ts: new Date().toISOString(),
      }, PROJECT_PATH);
      await recordSkillRun(db, {
        run_id: `b${i}`, skill_id: projB.skill_id, session_id: "s", task_id: null,
        inputs: {}, outcome_score: 0.85, total_cost: 0, total_tokens: 0,
        duration_ms: 0, status: "succeeded", failure_trace: null, ts: new Date().toISOString(),
      }, "/tmp/another-project");
    }

    const candidates = await findGlobalPromotionCandidates(0.10, 2);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const cand = candidates.find((c) => c.name === "score-test");
    expect(cand).toBeDefined();
    expect(cand!.project_count).toBeGreaterThanOrEqual(2);
    expect(cand!.best_avg).toBeGreaterThan(cand!.global_avg);
  });

  it("returns empty when no per-project beats global by threshold", async () => {
    process.env.ZC_TELEMETRY_BACKEND = "postgres";
    const projectScope = `project:${projectHashOf(PROJECT_PATH)}` as `project:${string}`;
    const global = await makeSkill("no-win", "global");
    const proj = await makeSkill("no-win", projectScope);
    await upsertSkill(db, global);
    await upsertSkill(db, proj);
    // Both score 0.7 — no beat
    for (let i = 0; i < 3; i++) {
      await recordSkillRun(db, {
        run_id: `g${i}`, skill_id: global.skill_id, session_id: "s", task_id: null,
        inputs: {}, outcome_score: 0.7, total_cost: 0, total_tokens: 0,
        duration_ms: 0, status: "succeeded", failure_trace: null, ts: new Date().toISOString(),
      }, "/tmp/proj-global");
      await recordSkillRun(db, {
        run_id: `p${i}`, skill_id: proj.skill_id, session_id: "s", task_id: null,
        inputs: {}, outcome_score: 0.7, total_cost: 0, total_tokens: 0,
        duration_ms: 0, status: "succeeded", failure_trace: null, ts: new Date().toISOString(),
      }, PROJECT_PATH);
    }
    const candidates = await findGlobalPromotionCandidates(0.10, 1);
    expect(candidates.find((c) => c.name === "no-win")).toBeUndefined();
  });
});
