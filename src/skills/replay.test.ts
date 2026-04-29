/**
 * Tests for v0.18.0 — replay harness.
 *
 * Covers:
 *   - LocalDeterministicExecutor: rules produce expected outcomes
 *   - replayFixture: HMAC verified before execution (RT-S2-09)
 *   - replayFixture: failed status produces composite=0
 *   - replaySkill: aggregates per-fixture results
 *   - compareReplays: delta surfaces parent vs candidate gap
 *   - empty-fixtures skill returns zero-scores cleanly
 *   - tampered candidate body → fixture replay marked failed with HMAC trace
 */

import { describe, it, expect } from "vitest";
import {
  LocalDeterministicExecutor, replayFixture, replaySkill, compareReplays,
} from "./replay.js";
import { buildSkill } from "./loader.js";
import type { Skill, SkillFixture } from "./types.js";

async function makeSkill(body: string, fixtures?: SkillFixture[]): Promise<Skill> {
  return buildSkill(
    {
      name: "audit", version: "1.0.0", scope: "global", description: "audit",
      acceptance_criteria: { min_outcome_score: 0.7, min_pass_rate: 0.8 },
      fixtures,
    },
    body,
  );
}

const FIXTURES: SkillFixture[] = [
  { fixture_id: "happy", description: "x=5", input: { x: 5 }, expected: { ok: true, count: 5 } },
  { fixture_id: "edge",  description: "x=0", input: { x: 0 }, expected: { ok: true } },
  { fixture_id: "fail",  description: "fail simulated", input: { simulate: "fail" }, expected: { ok: true } },
];

describe("v0.18.0 — LocalDeterministicExecutor", () => {

  it("succeeds on plain input", async () => {
    const skill = await makeSkill("# audit\n");
    const r = await new LocalDeterministicExecutor().execute(skill, { x: 3 });
    expect(r.status).toBe("succeeded");
    expect(r.actual_outcome).toEqual({ ok: true, count: 3 });
  });

  it("simulate=fail returns failed", async () => {
    const skill = await makeSkill("# audit\n");
    const r = await new LocalDeterministicExecutor().execute(skill, { simulate: "fail" });
    expect(r.status).toBe("failed");
  });

  it("simulate=timeout returns timeout", async () => {
    const skill = await makeSkill("# audit\n");
    const r = await new LocalDeterministicExecutor().execute(skill, { simulate: "timeout" });
    expect(r.status).toBe("timeout");
    expect(r.duration_ms).toBeGreaterThan(30_000);
  });

  it("skill body with retry-block adds retried_count", async () => {
    const skill = await makeSkill("# audit\n\n## Mutation 4 (retry)\nretry once.");
    const r = await new LocalDeterministicExecutor().execute(skill, { x: 1 });
    expect(r.actual_outcome.retried_count).toBe(1);
  });

  it("skill body with early-exit forces ok=true on missing input", async () => {
    const skill = await makeSkill("# audit\n\n## Mutation 5 (early-exit)\nbail early.");
    const r = await new LocalDeterministicExecutor().execute(skill, {});
    expect(r.actual_outcome.ok).toBe(true);
  });
});

describe("v0.18.0 — replayFixture", () => {

  it("matching expected → composite > 0", async () => {
    const skill = await makeSkill("# audit\n", FIXTURES);
    const r = await replayFixture(skill, FIXTURES[0], new LocalDeterministicExecutor());
    expect(r.status).toBe("succeeded");
    expect(r.accuracy).toBe(1.0);
    expect(r.composite).toBeGreaterThan(0.5);
  });

  it("simulated failure → composite=0", async () => {
    const skill = await makeSkill("# audit\n", FIXTURES);
    const r = await replayFixture(skill, FIXTURES[2], new LocalDeterministicExecutor());
    expect(r.status).toBe("failed");
    expect(r.composite).toBe(0);
  });

  it("HMAC mismatch → marked failed with trace (RT-S2-09)", async () => {
    const skill = await makeSkill("# audit\n", FIXTURES);
    skill.body_hmac = "0".repeat(64);  // tamper hmac
    const r = await replayFixture(skill, FIXTURES[0], new LocalDeterministicExecutor());
    expect(r.status).toBe("failed");
    expect(r.composite).toBe(0);
    expect(r.failure_trace).toContain("HMAC");
  });

  it("partially-matching expected reduces accuracy", async () => {
    const skill = await makeSkill("# audit\n", FIXTURES);
    // Fixture expects {ok: true, count: 5} but executor returns {ok: true, count: 3}
    const fix: SkillFixture = { fixture_id: "wrong", description: "", input: { x: 3 }, expected: { ok: true, count: 5 } };
    const r = await replayFixture(skill, fix, new LocalDeterministicExecutor());
    expect(r.accuracy).toBe(0.5);
  });
});

describe("v0.18.0 — replaySkill", () => {

  it("empty fixtures → all zeros", async () => {
    const skill = await makeSkill("# audit\n", []);
    const r = await replaySkill(skill, new LocalDeterministicExecutor());
    expect(r.agg_score).toBe(0);
    expect(r.pass_rate).toBe(0);
  });

  it("happy + edge succeed; fail simulated → pass_rate matches", async () => {
    const skill = await makeSkill("# audit\n", FIXTURES);
    const r = await replaySkill(skill, new LocalDeterministicExecutor());
    expect(r.per_fixture.length).toBe(3);
    // 2 succeeded out of 3
    expect(r.pass_rate).toBeCloseTo(2/3, 4);
  });
});

describe("v0.18.0 — compareReplays", () => {

  it("candidate body with retry-block produces measurable delta on relevant fixture", async () => {
    // Fixture asks for retried_count >= 1
    const fixture: SkillFixture = {
      fixture_id: "retry-aware",
      description: "expects retry support",
      input: { x: 1 },
      expected: { ok: true, retried_count: { ">=": 1 } },
    };
    const parent = await makeSkill("# parent\n", [fixture]);
    const candidate = await makeSkill("# parent\n\n## Mutation 4 (retry)\n", [fixture]);

    const r = await compareReplays(parent, candidate, new LocalDeterministicExecutor());
    expect(r.parent_replay.agg_score).toBeLessThan(r.candidate_replay.agg_score);
    expect(r.delta).toBeGreaterThan(0);
  });

  it("identical bodies → delta ~ 0", async () => {
    const parent = await makeSkill("# audit\n", FIXTURES);
    const candidate = await makeSkill("# audit\n", FIXTURES);
    const r = await compareReplays(parent, candidate, new LocalDeterministicExecutor());
    expect(r.delta).toBeCloseTo(0, 4);
  });
});
