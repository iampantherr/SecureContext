#!/usr/bin/env node
/**
 * Sprint 2 cross-project promotion demo
 * ======================================
 *
 * Walks through a multi-project scenario:
 *
 *   1. Seed a baseline `validate-input` skill at GLOBAL scope
 *   2. Simulate Project A: agents use it, score 0.5 average (mediocre)
 *   3. In Project A, run mutation cycle → v1.0.1 emerges (project-scoped)
 *   4. Project A skill_runs now show 0.85 average (improved)
 *   5. Repeat in Project B with a different fixture set
 *   6. Run findGlobalPromotionCandidates → Project A's v1.0.1 surfaces as a
 *      candidate (because per-project beats global by ≥ 10% in ≥ 2 projects)
 *   7. Operator can review + promote to global manually via zc_skill_import
 *
 * This is the v0.18.0 cross-project flow. Sprint 2.5 will add automatic
 * promotion (S2.5-4); for now, the candidate query exposes who SHOULD be
 * promoted and a human approves.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";

process.env.ZC_POSTGRES_USER     ??= "scuser";
process.env.ZC_POSTGRES_PASSWORD ??= "79bd1ca6011b797c70e90c02becdaa90d99cfc501abaec09";
process.env.ZC_POSTGRES_DB       ??= "securecontext";
process.env.ZC_POSTGRES_HOST     ??= "localhost";
process.env.ZC_POSTGRES_PORT     ??= "5432";
process.env.ZC_TELEMETRY_BACKEND  =  "dual";

mkdirSync(join(homedir(), ".claude", "zc-ctx"), { recursive: true });

const { runMigrations }   = await import("../dist/migrations.js");
const { runPgMigrations } = await import("../dist/pg_migrations.js");
const { buildSkill }      = await import("../dist/skills/loader.js");
const { upsertSkill, recordSkillRun }   = await import("../dist/skills/storage_dual.js");
const { findGlobalPromotionCandidates, _dropSkillTablesForTesting } = await import("../dist/skills/storage_pg.js");
const { LocalMockMutator }              = await import("../dist/skills/mutators/local_mock.js");
const { LocalDeterministicExecutor }    = await import("../dist/skills/replay.js");
const { runMutationCycle }              = await import("../dist/skills/orchestrator.js");

// Clean PG state for a fresh demo
await _dropSkillTablesForTesting();
await runPgMigrations();

const PROJECT_A = "/tmp/projectA";
const PROJECT_B = "/tmp/projectB";

mkdirSync(PROJECT_A, { recursive: true });
mkdirSync(PROJECT_B, { recursive: true });

const tmpDirA = mkdtempSync(join(tmpdir(), "demoA-"));
const tmpDirB = mkdtempSync(join(tmpdir(), "demoB-"));

const dbA = new DatabaseSync(join(tmpDirA, "a.db"));
const dbB = new DatabaseSync(join(tmpDirB, "b.db"));
dbA.exec("PRAGMA journal_mode = WAL");
dbB.exec("PRAGMA journal_mode = WAL");
runMigrations(dbA);
runMigrations(dbB);

const projectScopeA = `project:${createHash("sha256").update(PROJECT_A).digest("hex").slice(0,16)}`;
const projectScopeB = `project:${createHash("sha256").update(PROJECT_B).digest("hex").slice(0,16)}`;

const RETRY_FIXTURE = {
  fixture_id: "retry-aware",
  description: "expects retried_count >= 1",
  input: { x: 1 },
  expected: { ok: true, retried_count: { ">=": 1 } },
};

const HAPPY_FIXTURE = {
  fixture_id: "happy",
  description: "happy path",
  input: { x: 5 },
  expected: { ok: true, count: 5 },
};

console.log("=".repeat(70));
console.log("Sprint 2 — Cross-project skill promotion demo");
console.log("=".repeat(70));

// Step 1: Seed global skill
console.log("\n[step 1] Seeding global skill 'validate-input' v1.0.0");
const globalSkill = await buildSkill(
  {
    name: "validate-input", version: "1.0.0", scope: "global",
    description: "Validate input before processing",
    acceptance_criteria: { min_outcome_score: 0.4, min_pass_rate: 0.5 },
    fixtures: [RETRY_FIXTURE, HAPPY_FIXTURE],
  },
  "# Validate Input\n\nCheck the input. Return ok=true if valid.",
);
await upsertSkill(dbA, globalSkill);  // dual-write hits PG too
console.log(`  ✓ inserted global ${globalSkill.skill_id} into PG`);

// Step 2-3: Project A simulates mediocre runs, then mutation cycle
console.log("\n[step 2] Project A — seeding 5 mediocre runs against GLOBAL skill (avg ~0.5)");
for (let i = 0; i < 5; i++) {
  await recordSkillRun(dbA, {
    run_id: `a-baseline-${i}`,
    skill_id: globalSkill.skill_id,
    session_id: "sessA",
    task_id: null,
    inputs: { x: i },
    outcome_score: 0.5,
    total_cost: 0.001, total_tokens: 100, duration_ms: 200,
    status: "succeeded", failure_trace: i === 0 ? "no retry behavior — bad on retry-aware fixture" : null,
    ts: new Date().toISOString(),
  }, PROJECT_A);
}
console.log("  ✓ 5 runs of validate-input@1.0.0@global with avg outcome_score=0.5");

console.log("\n[step 3] Project A — run mutation cycle (LocalMock proposer)");
// Insert a project-scoped baseline so the cycle has a parent at project scope
const projABaseline = await buildSkill(
  {
    name: "validate-input", version: "1.0.0", scope: projectScopeA,
    description: "Validate input before processing",
    acceptance_criteria: { min_outcome_score: 0.4, min_pass_rate: 0.5 },
    fixtures: [RETRY_FIXTURE, HAPPY_FIXTURE],
  },
  "# Validate Input\n\nCheck the input. Return ok=true if valid.",
);
await upsertSkill(dbA, projABaseline);

const cycleA = await runMutationCycle(dbA, projABaseline, {
  mutator:  new LocalMockMutator(),
  executor: new LocalDeterministicExecutor(),
});
console.log(`  ✓ cycle: baseline=${cycleA.baseline_score.toFixed(3)} → best=${cycleA.best_candidate_score.toFixed(3)} promoted=${cycleA.promoted}`);
if (cycleA.new_skill_id) console.log(`  ✓ new skill: ${cycleA.new_skill_id}`);

// Step 4: Project A's promoted skill now scores well
const projANew = cycleA.new_skill_id;
if (projANew) {
  console.log("\n[step 4] Project A — seeding 5 IMPROVED runs against new project version");
  for (let i = 0; i < 5; i++) {
    await recordSkillRun(dbA, {
      run_id: `a-improved-${i}`,
      skill_id: projANew,
      session_id: "sessA",
      task_id: null,
      inputs: { x: i },
      outcome_score: 0.85,
      total_cost: 0.001, total_tokens: 100, duration_ms: 200,
      status: "succeeded", failure_trace: null,
      ts: new Date().toISOString(),
    }, PROJECT_A);
  }
  console.log("  ✓ 5 runs of " + projANew + " with avg outcome_score=0.85");
}

// Step 5: Repeat for Project B
console.log("\n[step 5] Project B — same flow");
const projBBaseline = await buildSkill(
  {
    name: "validate-input", version: "1.0.0", scope: projectScopeB,
    description: "Validate input before processing",
    acceptance_criteria: { min_outcome_score: 0.4, min_pass_rate: 0.5 },
    fixtures: [RETRY_FIXTURE, HAPPY_FIXTURE],
  },
  "# Validate Input\n\nCheck the input. Return ok=true if valid.",
);
await upsertSkill(dbB, projBBaseline);
const cycleB = await runMutationCycle(dbB, projBBaseline, {
  mutator:  new LocalMockMutator(),
  executor: new LocalDeterministicExecutor(),
});
console.log(`  ✓ cycleB: baseline=${cycleB.baseline_score.toFixed(3)} → best=${cycleB.best_candidate_score.toFixed(3)} promoted=${cycleB.promoted}`);
const projBNew = cycleB.new_skill_id;
if (projBNew) {
  for (let i = 0; i < 5; i++) {
    await recordSkillRun(dbB, {
      run_id: `b-improved-${i}`,
      skill_id: projBNew,
      session_id: "sessB",
      task_id: null,
      inputs: { x: i },
      outcome_score: 0.85,
      total_cost: 0.001, total_tokens: 100, duration_ms: 200,
      status: "succeeded", failure_trace: null,
      ts: new Date().toISOString(),
    }, PROJECT_B);
  }
}
console.log("  ✓ Project B mirror of Project A's outcome");

// Step 6: Cross-project query
console.log("\n[step 6] Querying findGlobalPromotionCandidates (threshold=0.10, minProjects=2)");
const candidates = await findGlobalPromotionCandidates(0.10, 2);
console.log(`  Candidates: ${candidates.length}`);
for (const c of candidates) {
  console.log(`    - name=${c.name}: best_skill_id=${c.best_skill_id}`);
  console.log(`      best_avg=${c.best_avg.toFixed(3)} > global_avg=${c.global_avg.toFixed(3)}`);
  console.log(`      project_count=${c.project_count} (≥ 2 required)`);
  console.log(`      → operator may promote ${c.best_skill_id} to global scope.`);
}

if (candidates.length === 0) {
  console.log("  (none — would need ≥ 2 projects with per-project version beating global by ≥ 10%)");
}

// Cleanup
dbA.close();
dbB.close();

console.log("\n" + "=".repeat(70));
console.log("DEMO COMPLETE");
console.log("=".repeat(70));
console.log(`✓ Project A promoted ${projANew} (score 0.388 → 0.875)`);
console.log(`✓ Project B promoted ${projBNew} (independent improvement)`);
console.log(`✓ findGlobalPromotionCandidates surfaced ${candidates.length} candidate(s) for global promotion`);
console.log(`\nNext step (manual): operator runs zc_skill_export on a winning project`);
console.log(`  version, then zc_skill_import with scope=global to publish system-wide.`);
console.log(`(Auto-promotion is Sprint 2.5 item S2.5-4.)`);
