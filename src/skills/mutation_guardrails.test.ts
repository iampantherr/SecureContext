/**
 * Tests for v0.18.1 — mutation_guardrails.ts.
 *
 * Covers:
 *   - cold start (no runs, no mutations) → fails on failure-threshold
 *   - 3 failures in 10 runs, no recent mutation → triggers
 *   - 3 failures BUT recent mutation in last 6h → cooldown blocks
 *   - 5 mutations today across project → daily cap blocks
 *   - 2 failures (below threshold) → blocks regardless of cooldown
 *   - low outcome_score (< 0.5) treated as failure even when status='succeeded'
 *   - env var overrides honor: ZC_MUTATION_COOLDOWN_HOURS, etc.
 *   - metrics shape always populated
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../migrations.js";
import { _resetCacheForTesting as resetMachineSecret } from "../security/machine_secret.js";
import { recordSkillRun, recordMutation } from "./storage.js";
import { checkMutationGuardrails } from "./mutation_guardrails.js";

let tmpDir: string;
let db: DatabaseSync;
const SKILL_ID = "audit@1.0.0@global";

beforeEach(() => {
  mkdirSync(join(homedir(), ".claude", "zc-ctx"), { recursive: true });
  resetMachineSecret();
  tmpDir = mkdtempSync(join(tmpdir(), "guard-test-"));
  db = new DatabaseSync(join(tmpDir, "test.db"));
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);
  // Reset env vars so per-test overrides don't leak
  delete process.env.ZC_MUTATION_COOLDOWN_HOURS;
  delete process.env.ZC_MUTATION_FAILURE_THRESHOLD;
  delete process.env.ZC_MUTATION_FAILURE_WINDOW;
  delete process.env.ZC_MUTATION_DAILY_CAP_PER_PROJECT;
});

afterEach(() => {
  try { db.close(); } catch { /* noop */ }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

function seedRun(status: "succeeded" | "failed" | "timeout", outcome_score: number | null, idSuffix = "") {
  recordSkillRun(db, {
    run_id: `r-${SKILL_ID}-${idSuffix || Date.now() + Math.random()}`,
    skill_id: SKILL_ID, session_id: "s", task_id: null, inputs: {},
    outcome_score, total_cost: 0, total_tokens: 0, duration_ms: 0,
    status, failure_trace: null, ts: new Date().toISOString(),
  });
}

function seedMutation(ageHours: number) {
  const created_at = new Date(Date.now() - ageHours * 3_600_000).toISOString();
  recordMutation(db, {
    mutation_id: `m-${Math.random()}`, parent_skill_id: SKILL_ID,
    candidate_body: "x", candidate_hmac: "x".repeat(64),
    proposed_by: "test", judged_by: null, judge_score: null, judge_rationale: null,
    replay_score: null, promoted: false, promoted_to_skill_id: null,
    created_at, resolved_at: null,
  });
}

describe("v0.18.1 — checkMutationGuardrails", () => {

  it("cold start (no runs) → trigger=false (failure threshold)", () => {
    const r = checkMutationGuardrails(db, SKILL_ID);
    expect(r.trigger).toBe(false);
    expect(r.reason).toMatch(/0 failures/);
    expect(r.metrics.failure_threshold).toBe(3);
  });

  it("3 explicit failures, no prior mutation → trigger=true", () => {
    seedRun("failed", null, "1");
    seedRun("failed", null, "2");
    seedRun("failed", null, "3");
    const r = checkMutationGuardrails(db, SKILL_ID);
    expect(r.trigger).toBe(true);
    expect(r.metrics.failures_in_window).toBe(3);
    expect(r.metrics.last_mutation_age_h).toBeNull();
  });

  it("3 succeeded runs with low outcome_score (< 0.5) counted as failures", () => {
    seedRun("succeeded", 0.2, "1");
    seedRun("succeeded", 0.3, "2");
    seedRun("succeeded", 0.4, "3");
    const r = checkMutationGuardrails(db, SKILL_ID);
    expect(r.trigger).toBe(true);
    expect(r.metrics.failures_in_window).toBe(3);
  });

  it("2 failures → trigger=false (below threshold)", () => {
    seedRun("failed", null, "1");
    seedRun("failed", null, "2");
    const r = checkMutationGuardrails(db, SKILL_ID);
    expect(r.trigger).toBe(false);
    expect(r.reason).toMatch(/2 failures/);
  });

  it("3 failures BUT recent mutation in last 6h → cooldown blocks", () => {
    seedRun("failed", null, "1");
    seedRun("failed", null, "2");
    seedRun("failed", null, "3");
    seedMutation(2.0);  // 2 hours ago
    const r = checkMutationGuardrails(db, SKILL_ID);
    expect(r.trigger).toBe(false);
    expect(r.reason).toMatch(/cooldown/);
    expect(r.metrics.last_mutation_age_h).toBeCloseTo(2.0, 1);
  });

  it("3 failures + last mutation > 6h ago → trigger=true", () => {
    seedRun("failed", null, "1");
    seedRun("failed", null, "2");
    seedRun("failed", null, "3");
    seedMutation(7.0);  // 7 hours ago
    const r = checkMutationGuardrails(db, SKILL_ID);
    expect(r.trigger).toBe(true);
  });

  it("daily cap blocks at 5 mutations today across project", () => {
    seedRun("failed", null, "1");
    seedRun("failed", null, "2");
    seedRun("failed", null, "3");
    // Insert 5 mutations TODAY (before threshold check would've blocked)
    for (let i = 0; i < 5; i++) seedMutation(0.1);  // 6 min ago each
    // Cooldown blocks first since most-recent is 0.1h
    // To isolate the daily-cap check, override cooldown to 0
    process.env.ZC_MUTATION_COOLDOWN_HOURS = "0";
    const r = checkMutationGuardrails(db, SKILL_ID);
    expect(r.trigger).toBe(false);
    expect(r.reason).toMatch(/daily cap reached/);
    expect(r.metrics.todays_mutations).toBe(5);
  });

  it("env var overrides — ZC_MUTATION_FAILURE_THRESHOLD=1 lets one failure trigger", () => {
    process.env.ZC_MUTATION_FAILURE_THRESHOLD = "1";
    seedRun("failed", null, "1");
    const r = checkMutationGuardrails(db, SKILL_ID);
    expect(r.trigger).toBe(true);
    expect(r.metrics.failure_threshold).toBe(1);
  });

  it("env var overrides — ZC_MUTATION_COOLDOWN_HOURS=0 disables cooldown", () => {
    seedRun("failed", null, "1");
    seedRun("failed", null, "2");
    seedRun("failed", null, "3");
    seedMutation(0.5);  // 30 min ago
    process.env.ZC_MUTATION_COOLDOWN_HOURS = "0";
    const r = checkMutationGuardrails(db, SKILL_ID);
    expect(r.trigger).toBe(true);
  });

  it("invalid env var falls back to default", () => {
    process.env.ZC_MUTATION_FAILURE_THRESHOLD = "not-a-number";
    seedRun("failed", null, "1");
    seedRun("failed", null, "2");
    const r = checkMutationGuardrails(db, SKILL_ID);
    // Default threshold is 3, we have 2 → blocks
    expect(r.trigger).toBe(false);
    expect(r.metrics.failure_threshold).toBe(3);
  });

  it("metrics shape is always populated", () => {
    const r = checkMutationGuardrails(db, SKILL_ID);
    expect(r.metrics).toEqual(expect.objectContaining({
      failures_in_window:  expect.any(Number),
      failure_threshold:   expect.any(Number),
      failure_window:      expect.any(Number),
      cooldown_hours:      expect.any(Number),
      todays_mutations:    expect.any(Number),
      daily_cap:           expect.any(Number),
    }));
  });
});
