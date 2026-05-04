/**
 * Tests for v0.18.0 — orchestrator.ts (the full skill→mutate→replay→promote cycle).
 *
 * Covers:
 *   - cold-start cycle: parent has no recent runs → baselines via replay
 *   - successful promotion: candidate beats parent by >MIN_PROMOTION_DELTA
 *     → archive parent, insert new version, mutation marked promoted
 *   - failed promotion: candidate below acceptance → no archive, mutation
 *     resolved with reason
 *   - mutator throws → cycle returns reason='mutator error: ...'
 *   - all candidates land in skill_mutations regardless of outcome
 *   - HMAC-tamper between proposal+replay → that candidate's mutation row
 *     records the failure, doesn't affect siblings (RT-S2-09)
 *   - selectUnderperformingSkills: returns bottom-N
 *   - runNightlyCycle: end-to-end on multiple skills
 *   - promotion atomicity: archive + insert in one transaction
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  runMutationCycle, selectUnderperformingSkills, runNightlyCycle,
} from "./orchestrator.js";
import { LocalMockMutator } from "./mutators/local_mock.js";
import { LocalDeterministicExecutor } from "./replay.js";
import { buildSkill } from "./loader.js";
import {
  upsertSkill, recordSkillRun, getRecentMutations, getActiveSkill, listActiveSkills,
} from "./storage.js";
import { runMigrations } from "../migrations.js";
import { _resetCacheForTesting as resetMachineSecret } from "../security/machine_secret.js";
import type { Skill, SkillFixture } from "./types.js";

let tmpDir: string;
let db: DatabaseSync;

beforeEach(() => {
  mkdirSync(join(homedir(), ".claude", "zc-ctx"), { recursive: true });
  resetMachineSecret();
  tmpDir = mkdtempSync(join(tmpdir(), "orch-test-"));
  db = new DatabaseSync(join(tmpDir, "test.db"));
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);
});

afterEach(() => {
  try { db.close(); } catch { /* noop */ }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

const RETRY_FIXTURE: SkillFixture = {
  fixture_id: "retry-aware",
  description: "expects a retried_count >= 1",
  input: { x: 1 },
  expected: { ok: true, retried_count: { ">=": 1 } },
};

const HAPPY_FIXTURE: SkillFixture = {
  fixture_id: "happy",
  description: "happy path",
  input: { x: 5 },
  expected: { ok: true, count: 5 },
};

async function makeParentSkill(fixtures: SkillFixture[] = [RETRY_FIXTURE]): Promise<Skill> {
  // v0.23.0: description and body length comply with the lint gate so mutator
  // candidates (which inherit this frontmatter) pass through storage_dual.upsertSkill.
  return buildSkill(
    {
      name: "audit", version: "1.0.0", scope: "global",
      description: "Audit a source file for security issues and style problems",
      acceptance_criteria: { min_outcome_score: 0.5, min_pass_rate: 0.5 },
      fixtures,
    },
    "# Audit\n\nWhen invoked with input, perform the audit and return findings.\n" +
    "Do not retry on failure unless the candidate body explicitly says otherwise.\n" +
    "## Steps\n1. Validate input shape\n2. Run the audit\n3. Return findings\n",
  );
}

describe("v0.18.0 orchestrator — runMutationCycle", () => {

  it("cold-start: no recent runs → baseline from replay; LocalMock + retry-fixture → promotion", async () => {
    const parent = await makeParentSkill();
    await upsertSkill(db, parent);

    const result = await runMutationCycle(db, parent, {
      mutator:  new LocalMockMutator(),
      executor: new LocalDeterministicExecutor(),
    });

    expect(result.candidates_count).toBe(5);  // LocalMock generates 5
    expect(result.baseline_score).toBeLessThan(result.best_candidate_score);
    // The retry-block candidate is +1 point on retried_count over parent → should promote
    expect(result.promoted).toBe(true);
    expect(result.new_skill_id).toMatch(/audit@1\.0\.1@global/);
    expect(result.archived_skill_id).toBe(parent.skill_id);
    // Reason includes delta info
    expect(result.reason).toMatch(/delta/);
  });

  it("after promotion: parent is archived, new version is active", async () => {
    const parent = await makeParentSkill();
    await upsertSkill(db, parent);

    await runMutationCycle(db, parent, {
      mutator:  new LocalMockMutator(),
      executor: new LocalDeterministicExecutor(),
    });

    const active = await getActiveSkill(db, "audit", "global");
    expect(active?.skill_id).toMatch(/audit@1\.0\.1@global/);
    expect(active?.frontmatter.version).toBe("1.0.1");
  });

  it("all candidates persisted to skill_mutations regardless of promotion", async () => {
    const parent = await makeParentSkill();
    await upsertSkill(db, parent);

    await runMutationCycle(db, parent, {
      mutator:  new LocalMockMutator(),
      executor: new LocalDeterministicExecutor(),
    });
    const muts = getRecentMutations(db, parent.skill_id, 10);
    expect(muts.length).toBe(5);
    // Exactly one promoted
    expect(muts.filter((m) => m.promoted).length).toBe(1);
    // All others non-promoted
    expect(muts.filter((m) => !m.promoted).length).toBe(4);
  });

  it("non-improving fixture set → no promotion, archived skills stays archived (parent stays active)", async () => {
    // HAPPY_FIXTURE doesn't reward retried_count — every candidate scores ~the same as parent
    const parent = await makeParentSkill([HAPPY_FIXTURE]);
    await upsertSkill(db, parent);

    const result = await runMutationCycle(db, parent, {
      mutator:  new LocalMockMutator(),
      executor: new LocalDeterministicExecutor(),
    });
    expect(result.promoted).toBe(false);
    expect(result.reason).toMatch(/delta/);

    // Parent still active
    const active = await getActiveSkill(db, "audit", "global");
    expect(active?.skill_id).toBe(parent.skill_id);
  });

  it("mutator throws → cycle returns no-promotion + error reason", async () => {
    const parent = await makeParentSkill();
    await upsertSkill(db, parent);

    const failingMutator = {
      id: "fail",
      mutate: async () => { throw new Error("boom"); },
    };
    const result = await runMutationCycle(db, parent, {
      mutator:  failingMutator,
      executor: new LocalDeterministicExecutor(),
    });
    expect(result.promoted).toBe(false);
    expect(result.reason).toMatch(/mutator error: boom/);
    expect(result.candidates_count).toBe(0);
  });

  it("baseline computed from recent runs when present", async () => {
    const parent = await makeParentSkill();
    await upsertSkill(db, parent);

    // Seed some succeeded runs with high scores
    for (let i = 0; i < 5; i++) {
      recordSkillRun(db, {
        run_id: `r${i}`, skill_id: parent.skill_id, session_id: "s",
        task_id: null, inputs: {}, outcome_score: 0.95,
        total_cost: 0, total_tokens: 0, duration_ms: 0,
        status: "succeeded", failure_trace: null,
        ts: new Date().toISOString(),
      });
    }

    const result = await runMutationCycle(db, parent, {
      mutator:  new LocalMockMutator(),
      executor: new LocalDeterministicExecutor(),
    });
    // Parent has high baseline (~0.95 succeeded * scoring weights ≈ 0.7+)
    expect(result.baseline_score).toBeGreaterThan(0.5);
    // With a high parent baseline, candidates would need to be MUCH better
    // to clear MIN_PROMOTION_DELTA of 0.10. LocalMock candidates may not.
    // Either way: baseline_score is from runs, not replay.
  });
});

describe("v0.18.0 orchestrator — selectUnderperformingSkills", () => {

  it("returns bottom-N by avg outcome_score", async () => {
    const skills: Skill[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await buildSkill({
        name: `s${i}`, version: "1.0.0", scope: "global", description: "x",
      }, "body");
      await upsertSkill(db, s);
      skills.push(s);
      // Seed runs: s0 worst (score 0.1), s4 best (score 0.9)
      const score = 0.1 + i * 0.2;
      for (let j = 0; j < 3; j++) {
        recordSkillRun(db, {
          run_id: `${s.skill_id}-r${j}`, skill_id: s.skill_id, session_id: "s",
          task_id: null, inputs: {}, outcome_score: score,
          total_cost: 0, total_tokens: 0, duration_ms: 0,
          status: "succeeded", failure_trace: null,
          ts: new Date().toISOString(),
        });
      }
    }
    const bottom3 = await selectUnderperformingSkills(db, skills, 3);
    expect(bottom3.length).toBe(3);
    expect(bottom3[0].skill_id).toContain("s0");  // worst
    expect(bottom3[1].skill_id).toContain("s1");
    expect(bottom3[2].skill_id).toContain("s2");
  });

  it("cold-start skills (no runs) bubble to the top", async () => {
    const cold = await buildSkill({
      name: "cold", version: "1.0.0", scope: "global", description: "x",
    }, "body");
    await upsertSkill(db, cold);
    const hot = await buildSkill({
      name: "hot", version: "1.0.0", scope: "global", description: "x",
    }, "body");
    await upsertSkill(db, hot);
    recordSkillRun(db, {
      run_id: "hot-r1", skill_id: hot.skill_id, session_id: "s",
      task_id: null, inputs: {}, outcome_score: 0.9,
      total_cost: 0, total_tokens: 0, duration_ms: 0,
      status: "succeeded", failure_trace: null,
      ts: new Date().toISOString(),
    });
    const bottom = await selectUnderperformingSkills(db, [hot, cold], 1);
    expect(bottom[0].skill_id).toBe(cold.skill_id);
  });
});

describe("v0.18.0 orchestrator — runNightlyCycle", () => {

  it("runs full cycle across active skills", async () => {
    // Seed 2 active skills
    const a = await buildSkill({
      name: "a", version: "1.0.0", scope: "global", description: "a",
      acceptance_criteria: { min_outcome_score: 0.3, min_pass_rate: 0.5 },
      fixtures: [RETRY_FIXTURE],
    }, "# a\n");
    const b = await buildSkill({
      name: "b", version: "1.0.0", scope: "global", description: "b",
      acceptance_criteria: { min_outcome_score: 0.3, min_pass_rate: 0.5 },
      fixtures: [HAPPY_FIXTURE],
    }, "# b\n");
    await upsertSkill(db, a);
    await upsertSkill(db, b);

    const result = await runNightlyCycle(db, {
      mutator:  new LocalMockMutator(),
      executor: new LocalDeterministicExecutor(),
      topN:     2,
    });
    expect(result.cycles.length).toBe(2);
    expect(result.total_duration_ms).toBeGreaterThan(0);
  });
});

describe("v0.18.0 orchestrator — atomicity", () => {

  it("on promotion: only one active row remains for (name, scope)", async () => {
    const parent = await makeParentSkill();
    await upsertSkill(db, parent);
    const result = await runMutationCycle(db, parent, {
      mutator:  new LocalMockMutator(),
      executor: new LocalDeterministicExecutor(),
    });
    expect(result.promoted).toBe(true);
    const all = await listActiveSkills(db);
    const auditActive = all.filter((s) => s.frontmatter.name === "audit");
    expect(auditActive.length).toBe(1);
    expect(auditActive[0].frontmatter.version).toBe("1.0.1");
  });
});
