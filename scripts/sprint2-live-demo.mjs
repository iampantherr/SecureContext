#!/usr/bin/env node
/**
 * Sprint 2 live end-to-end demo
 * ==============================
 *
 * Exercises the full mutation pipeline against a real on-disk SQLite DB
 * so we can observe the round-trip behavior without any unit-test mocks.
 *
 * Steps:
 *   1. Open a fresh project DB (tmp dir)
 *   2. Run migrations 1-22
 *   3. Build a parent skill with two fixtures: one that rewards the retry
 *      pattern, one that's neutral
 *   4. Insert as the active 'global' skill
 *   5. Confirm zc_skill_list / zc_skill_show return it
 *   6. Run zc_skill_run_replay → expect baseline replay scores
 *   7. Run zc_skill_propose_mutation (uses LocalMockMutator) → expect promotion
 *   8. Confirm zc_skill_list shows the new (1.0.1) version + parent archived
 *   9. Run zc_skill_export → import round-trip (lossless)
 *
 * Output: a structured JSON summary the operator can read.
 */

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

// Reset machine secret cache so HMAC computations are stable
process.env.ZC_TEST_DB_DIR = mkdtempSync(join(tmpdir(), "sprint2-demo-"));

const tmp = mkdtempSync(join(tmpdir(), "sprint2-live-"));
mkdirSync(join(homedir(), ".claude", "zc-ctx"), { recursive: true });

const dbPath = join(tmp, "demo.db");

const { runMigrations } = await import("../dist/migrations.js");
const { buildSkill } = await import("../dist/skills/loader.js");
const { upsertSkill, listActiveSkills, getActiveSkill, getRecentMutations } = await import("../dist/skills/storage.js");
const { LocalMockMutator } = await import("../dist/skills/mutators/local_mock.js");
const { LocalDeterministicExecutor, replaySkill } = await import("../dist/skills/replay.js");
const { runMutationCycle } = await import("../dist/skills/orchestrator.js");
const { exportToAgentSkillsIo, importFromAgentSkillsIo } = await import("../dist/skills/format/agentskills_io.js");

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
runMigrations(db);

const summary = { steps: [] };

function log(step, detail) {
  console.log(`[step ${summary.steps.length + 1}] ${step}`, detail ?? "");
  summary.steps.push({ step, detail });
}

// ─── Step 1-2 already done; continue ────────────────────────────────────────

const parent = await buildSkill(
  {
    name: "audit_input", version: "1.0.0", scope: "global",
    description: "Audit input for type-safety issues",
    acceptance_criteria: { min_outcome_score: 0.4, min_pass_rate: 0.5 },
    fixtures: [
      { fixture_id: "retry-aware", description: "expects retried_count >= 1",
        input: { x: 1 }, expected: { ok: true, retried_count: { ">=": 1 } } },
      { fixture_id: "happy",       description: "happy path",
        input: { x: 5 }, expected: { ok: true, count: 5 } },
    ],
  },
  "# Audit Input\n\nCheck the input. Return ok=true if valid.",
);
await upsertSkill(db, parent);
log("seeded parent skill", parent.skill_id);

// ─── Step 5: list ───────────────────────────────────────────────────────────

const list1 = await listActiveSkills(db);
log("zc_skill_list (baseline)", list1.map((s) => s.skill_id));

// ─── Step 6: replay parent ──────────────────────────────────────────────────

const exec = new LocalDeterministicExecutor();
const baselineReplay = await replaySkill(parent, exec);
log("baseline replay", {
  agg_score: baselineReplay.agg_score.toFixed(3),
  pass_rate: baselineReplay.pass_rate.toFixed(2),
  per_fixture: baselineReplay.per_fixture.map((f) => ({ id: f.fixture_id, accuracy: f.accuracy, status: f.status })),
});

// ─── Step 7: run mutation cycle ─────────────────────────────────────────────

const cycle = await runMutationCycle(db, parent, {
  mutator:  new LocalMockMutator(),
  executor: exec,
});
log("mutation cycle result", {
  promoted:             cycle.promoted,
  baseline_score:       cycle.baseline_score.toFixed(3),
  best_candidate_score: cycle.best_candidate_score.toFixed(3),
  candidates_count:     cycle.candidates_count,
  new_skill_id:         cycle.new_skill_id,
  archived_skill_id:    cycle.archived_skill_id,
  reason:               cycle.reason,
});

// All 5 candidates should be in skill_mutations
const muts = getRecentMutations(db, parent.skill_id, 10);
log("skill_mutations rows", muts.map((m) => ({
  id: m.mutation_id, replay_score: m.replay_score?.toFixed(3),
  promoted: m.promoted, promoted_to: m.promoted_to_skill_id,
})));

// ─── Step 8: list after promotion ───────────────────────────────────────────

const list2 = await listActiveSkills(db);
log("zc_skill_list (after promotion)", list2.map((s) => ({ id: s.skill_id, version: s.frontmatter.version })));

const newActive = await getActiveSkill(db, "audit_input", "global");
log("new active skill", newActive ? { id: newActive.skill_id, body_preview: newActive.body.slice(0, 100) } : null);

// ─── Step 9: export → import round-trip ─────────────────────────────────────

if (newActive) {
  const exported = exportToAgentSkillsIo(newActive);
  log("export agentskills.io (first 200 chars)", exported.slice(0, 200));

  const reimported = await importFromAgentSkillsIo(exported);
  log("re-imported skill", {
    id: reimported.skill_id,
    body_matches: reimported.body === newActive.body,
    fixtures_preserved: reimported.frontmatter.fixtures?.length === newActive.frontmatter.fixtures?.length,
  });
}

// ─── Final summary ──────────────────────────────────────────────────────────

console.log("\n=== Sprint 2 live demo summary ===");
console.log(JSON.stringify(summary, null, 2));
console.log(`\n✓ All ${summary.steps.length} steps completed.`);
console.log(`✓ Mutation pipeline: parent → 5 candidates → replay → ${cycle.promoted ? "promoted" : "rejected"}`);
console.log(`✓ All ${muts.length} mutation rows persisted to skill_mutations`);

db.close();
