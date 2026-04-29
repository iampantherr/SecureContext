/**
 * Tests for v0.18.0 — scoring.ts
 *
 * Covers:
 *   - scoreSkillRun: success / failure / timeout produce expected scores
 *   - cost penalty: high cost reduces score
 *   - speed penalty: slow runs reduce score
 *   - accuracy override path (replay-driven)
 *   - aggregateScore: pass_rate, avg_score, n
 *   - checkAcceptance: each criterion failure surfaces in reasons
 *   - shouldPromote: requires delta + acceptance + no cost regression
 *   - scoreFixtureMatch: literal equality, comparators, regex, includes, nested objects
 *   - empty / edge cases
 */

import { describe, it, expect } from "vitest";
import {
  scoreSkillRun, aggregateScore, checkAcceptance, shouldPromote,
  scoreFixtureMatch, DEFAULT_SCORING, MIN_PROMOTION_DELTA, fixtureRunToAccuracy,
} from "./scoring.js";
import type { SkillRun } from "./types.js";

function mkRun(overrides: Partial<SkillRun> = {}): SkillRun {
  return {
    run_id: "r", skill_id: "s@1@global", session_id: "sess",
    task_id: null, inputs: {},
    outcome_score: 1.0, total_cost: 0.001, total_tokens: 100, duration_ms: 100,
    status: "succeeded", failure_trace: null, ts: new Date().toISOString(),
    ...overrides,
  };
}

describe("v0.18.0 scoring — scoreSkillRun", () => {

  it("succeeded run with perfect everything → score ≈ 1.0", () => {
    const r = mkRun({ outcome_score: 1.0, total_cost: 0, duration_ms: 0 });
    expect(scoreSkillRun(r)).toBeCloseTo(1.0, 3);
  });

  it("failed run → 0", () => {
    expect(scoreSkillRun(mkRun({ status: "failed" }))).toBe(0);
  });

  it("timeout run → 0", () => {
    expect(scoreSkillRun(mkRun({ status: "timeout" }))).toBe(0);
  });

  it("high cost reduces score", () => {
    const cheap = mkRun({ total_cost: 0.001, outcome_score: 1.0, duration_ms: 0 });
    const expensive = mkRun({ total_cost: 1.0, outcome_score: 1.0, duration_ms: 0 });
    expect(scoreSkillRun(cheap)).toBeGreaterThan(scoreSkillRun(expensive));
  });

  it("slow run reduces score", () => {
    const fast = mkRun({ duration_ms: 100, outcome_score: 1.0, total_cost: 0 });
    const slow = mkRun({ duration_ms: 60_000, outcome_score: 1.0, total_cost: 0 });
    expect(scoreSkillRun(fast)).toBeGreaterThan(scoreSkillRun(slow));
  });

  it("accuracy override is honored", () => {
    const r = mkRun({ outcome_score: 0.0, total_cost: 0, duration_ms: 0 });
    // outcome_score is 0 but we override with 1.0 (replay matched expected)
    expect(scoreSkillRun(r, DEFAULT_SCORING, 1.0)).toBeGreaterThan(0.4);
  });

  it("missing total_cost / duration_ms defaults to perfect (cost=1, speed=1)", () => {
    const r = mkRun({ outcome_score: 1.0, total_cost: null, duration_ms: null });
    expect(scoreSkillRun(r)).toBeCloseTo(1.0, 3);
  });
});

describe("v0.18.0 scoring — aggregateScore", () => {

  it("empty input → all zeros", () => {
    const a = aggregateScore([]);
    expect(a).toEqual({ avg_score: 0, pass_rate: 0, avg_cost_usd: 0, avg_duration_ms: 0, n: 0 });
  });

  it("3 succeeded runs → pass_rate 1.0, avg over runs", () => {
    const runs = [
      mkRun({ outcome_score: 0.5, total_cost: 0.01, duration_ms: 100 }),
      mkRun({ outcome_score: 0.7, total_cost: 0.01, duration_ms: 100 }),
      mkRun({ outcome_score: 0.9, total_cost: 0.01, duration_ms: 100 }),
    ];
    const a = aggregateScore(runs);
    expect(a.pass_rate).toBe(1.0);
    expect(a.n).toBe(3);
    expect(a.avg_cost_usd).toBeCloseTo(0.01, 4);
  });

  it("mixed runs → pass_rate matches succeeded count", () => {
    const runs = [
      mkRun({ status: "succeeded" }),
      mkRun({ status: "failed" }),
      mkRun({ status: "succeeded" }),
      mkRun({ status: "timeout" }),
    ];
    const a = aggregateScore(runs);
    expect(a.pass_rate).toBe(0.5);
    expect(a.n).toBe(4);
  });
});

describe("v0.18.0 scoring — checkAcceptance", () => {

  it("default criteria (min_outcome_score=0.7, min_pass_rate=0.8) passes a strong agg", () => {
    const agg = { avg_score: 0.8, pass_rate: 0.9, avg_cost_usd: 0.01, avg_duration_ms: 100, n: 10 };
    expect(checkAcceptance(agg, undefined).eligible).toBe(true);
  });

  it("low outcome_score fails with reason", () => {
    const agg = { avg_score: 0.5, pass_rate: 1.0, avg_cost_usd: 0, avg_duration_ms: 0, n: 5 };
    const r = checkAcceptance(agg, undefined);
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(",")).toMatch(/avg_score/);
  });

  it("low pass_rate fails", () => {
    const agg = { avg_score: 0.9, pass_rate: 0.5, avg_cost_usd: 0, avg_duration_ms: 0, n: 5 };
    const r = checkAcceptance(agg, undefined);
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(",")).toMatch(/pass_rate/);
  });

  it("explicit max_avg_cost_usd is honored", () => {
    const agg = { avg_score: 0.9, pass_rate: 1.0, avg_cost_usd: 0.5, avg_duration_ms: 0, n: 5 };
    const r = checkAcceptance(agg, { max_avg_cost_usd: 0.1 });
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(",")).toMatch(/avg_cost/);
  });

  it("explicit max_avg_duration_ms is honored", () => {
    const agg = { avg_score: 0.9, pass_rate: 1.0, avg_cost_usd: 0, avg_duration_ms: 60_000, n: 5 };
    const r = checkAcceptance(agg, { max_avg_duration_ms: 5_000 });
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(",")).toMatch(/avg_duration/);
  });
});

describe("v0.18.0 scoring — shouldPromote", () => {

  const STRONG = { avg_score: 0.9, pass_rate: 1.0, avg_cost_usd: 0.01, avg_duration_ms: 100, n: 5 };
  const WEAK   = { avg_score: 0.6, pass_rate: 0.7, avg_cost_usd: 0.01, avg_duration_ms: 100, n: 5 };
  const MARG   = { avg_score: 0.65, pass_rate: 0.9, avg_cost_usd: 0.01, avg_duration_ms: 100, n: 5 };

  it("promotes when delta ≥ min and acceptance met", () => {
    // Need parent < candidate by ≥ 0.10 AND candidate accepted (avg≥0.7, pass≥0.8)
    const parent = { avg_score: 0.7, pass_rate: 0.85, avg_cost_usd: 0.01, avg_duration_ms: 100, n: 5 };
    const r = shouldPromote(STRONG, parent, undefined);
    expect(r.promote).toBe(true);
    expect(r.delta).toBeCloseTo(0.2, 2);
  });

  it("rejects when delta below MIN_PROMOTION_DELTA", () => {
    const parent = { avg_score: 0.85, pass_rate: 1.0, avg_cost_usd: 0.01, avg_duration_ms: 100, n: 5 };
    const r = shouldPromote(STRONG, parent, undefined);
    expect(r.promote).toBe(false);
    expect(r.reason).toMatch(/delta/);
  });

  it("rejects when candidate doesn't meet acceptance", () => {
    const r = shouldPromote(WEAK, STRONG, undefined);
    expect(r.promote).toBe(false);
    expect(r.reason).toMatch(/acceptance/);
  });

  it("rejects on cost regression > 2× parent", () => {
    const parent = { avg_score: 0.7, pass_rate: 0.85, avg_cost_usd: 0.01, avg_duration_ms: 100, n: 5 };
    const candidate = { avg_score: 0.95, pass_rate: 1.0, avg_cost_usd: 0.05, avg_duration_ms: 100, n: 5 };
    const r = shouldPromote(candidate, parent, undefined);
    expect(r.promote).toBe(false);
    expect(r.reason).toMatch(/cost regression/);
  });

  it("MIN_PROMOTION_DELTA is exposed", () => {
    expect(MIN_PROMOTION_DELTA).toBe(0.10);
  });
  void MARG;
});

describe("v0.18.0 scoring — scoreFixtureMatch", () => {

  it("perfect match → 1.0", () => {
    const r = scoreFixtureMatch({ a: 1, b: "x" }, { a: 1, b: "x" });
    expect(r.score).toBe(1.0);
    expect(r.failed_keys).toEqual([]);
  });

  it("partial match → fraction", () => {
    const r = scoreFixtureMatch({ a: 1, b: "x" }, { a: 1, b: "y" });
    expect(r.score).toBe(0.5);
    expect(r.failed_keys).toContain("b");
  });

  it("comparator >= passes when actual ≥", () => {
    const r = scoreFixtureMatch({ count: 5 }, { count: { ">=": 3 } });
    expect(r.score).toBe(1.0);
  });

  it("comparator >= fails when actual <", () => {
    const r = scoreFixtureMatch({ count: 1 }, { count: { ">=": 3 } });
    expect(r.score).toBe(0);
  });

  it("comparator <= works", () => {
    expect(scoreFixtureMatch({ count: 5 }, { count: { "<=": 5 } }).score).toBe(1.0);
    expect(scoreFixtureMatch({ count: 6 }, { count: { "<=": 5 } }).score).toBe(0);
  });

  it("comparator regex works", () => {
    expect(scoreFixtureMatch({ msg: "hello world" }, { msg: { regex: "^hello" } }).score).toBe(1.0);
    expect(scoreFixtureMatch({ msg: "hello" }, { msg: { regex: "^bye" } }).score).toBe(0);
  });

  it("comparator includes works", () => {
    expect(scoreFixtureMatch({ msg: "TypeError raised" }, { msg: { includes: "TypeError" } }).score).toBe(1.0);
    expect(scoreFixtureMatch({ msg: "no error" }, { msg: { includes: "TypeError" } }).score).toBe(0);
  });

  it("nested object expected requires recursive match", () => {
    const r = scoreFixtureMatch(
      { result: { count: 5, status: "ok" } },
      { result: { count: { ">=": 3 }, status: "ok" } },
    );
    expect(r.score).toBe(1.0);
  });

  it("empty expected → score 1.0", () => {
    const r = scoreFixtureMatch({ x: 1 }, {});
    expect(r.score).toBe(1.0);
  });

  it("fixtureRunToAccuracy mirrors scoreFixtureMatch.score", () => {
    const fixture = {
      fixture_id: "f1", description: "",
      input: {}, expected: { count: { ">=": 0 } },
    };
    expect(fixtureRunToAccuracy(fixture, { count: 5 })).toBe(1.0);
    expect(fixtureRunToAccuracy(fixture, { count: -1 })).toBe(0);
  });
});
