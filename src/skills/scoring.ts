/**
 * Skill outcome scoring (v0.18.0 Sprint 2)
 * =========================================
 *
 * Composite "outcome_score" used by the mutation engine to rank skill
 * candidates. The score combines three signals — accuracy, cost, speed —
 * each normalized to 0-1, weighted, summed.
 *
 *   accuracy = 0  if status != 'succeeded'
 *            = 1.0 - clamped(failure_count / pass_count) for happy-path
 *            = match-rate-vs-fixture-expected when running through replay harness
 *
 *   cost_score = 1.0 when total_cost == 0 (no LLM calls)
 *              = exp(-total_cost / cost_anchor)  with anchor configurable
 *
 *   speed_score = 1.0 when duration_ms == 0
 *               = exp(-duration_ms / duration_anchor)
 *
 * Defaults: weights {accuracy:0.5, cost:0.3, speed:0.2}, cost_anchor=$0.10,
 * duration_anchor=30000ms (30s).
 *
 * Why weight accuracy highest: a faster cheaper wrong answer is worse than
 * a slower more expensive correct one. Operators can override the weights
 * per-skill via acceptance_criteria + env vars.
 *
 * The mutation engine compares avg(outcome_score) of recent runs of the
 * parent skill vs. avg(outcome_score) of replay runs of each candidate.
 * Any candidate that beats the parent by ≥ MIN_PROMOTION_DELTA AND meets
 * the per-skill acceptance_criteria is eligible for promotion.
 */

import type { SkillRun, AcceptanceCriteria, SkillFixture, Skill } from "./types.js";

/** Tunable defaults — can be overridden per-skill or via env. */
export interface ScoringConfig {
  weight_accuracy:    number;
  weight_cost:        number;
  weight_speed:       number;
  cost_anchor_usd:    number;     // cost at which cost_score = 1/e ≈ 0.37
  duration_anchor_ms: number;     // duration at which speed_score = 1/e
}

export const DEFAULT_SCORING: ScoringConfig = {
  weight_accuracy:    0.5,
  weight_cost:        0.3,
  weight_speed:       0.2,
  cost_anchor_usd:    0.10,
  duration_anchor_ms: 30_000,
};

/** Min improvement margin for a candidate to be promoted over the parent. */
export const MIN_PROMOTION_DELTA = 0.10;

/** Per-skill scoring config — lets a skill's frontmatter override defaults. */
export function scoringConfigForSkill(skill: Skill, base: ScoringConfig = DEFAULT_SCORING): ScoringConfig {
  // For now we don't read scoring from frontmatter — defaults apply.
  // Future: skill.frontmatter.scoring?.weight_accuracy etc.
  void skill;
  return base;
}

/**
 * Score a single skill_run. Returns 0-1.
 *
 * For a successful run with a known input/expected pair (replay-driven),
 * the caller should pre-compute `accuracy` from the fixture match before
 * calling this. For a happy-path production run with no expected, accuracy
 * comes from the agent's self-reported `outcome_score` (already in the row).
 */
export function scoreSkillRun(
  run: SkillRun,
  config: ScoringConfig = DEFAULT_SCORING,
  accuracyOverride?: number,
): number {
  // Failed / timeout runs score 0 regardless of cost/speed
  if (run.status !== "succeeded") return 0;

  const accuracy =
    typeof accuracyOverride === "number" ? clamp01(accuracyOverride) :
    typeof run.outcome_score === "number" ? clamp01(run.outcome_score) : 0.5;

  const costScore = run.total_cost == null
    ? 1.0
    : Math.exp(-(Math.max(0, run.total_cost)) / config.cost_anchor_usd);

  const speedScore = run.duration_ms == null
    ? 1.0
    : Math.exp(-(Math.max(0, run.duration_ms)) / config.duration_anchor_ms);

  const composite =
    accuracy   * config.weight_accuracy +
    costScore  * config.weight_cost +
    speedScore * config.weight_speed;

  return clamp01(composite);
}

/**
 * Aggregate score across a set of runs. Used to compare candidates
 * vs. parent — average over recent runs.
 */
export function aggregateScore(runs: SkillRun[], config: ScoringConfig = DEFAULT_SCORING): {
  avg_score:     number;
  pass_rate:     number;
  avg_cost_usd:  number;
  avg_duration_ms: number;
  n:             number;
} {
  if (runs.length === 0) {
    return { avg_score: 0, pass_rate: 0, avg_cost_usd: 0, avg_duration_ms: 0, n: 0 };
  }
  let sumScore = 0;
  let succeeded = 0;
  let sumCost = 0;
  let sumDur = 0;
  let costN = 0;
  let durN = 0;
  for (const r of runs) {
    sumScore += scoreSkillRun(r, config);
    if (r.status === "succeeded") succeeded++;
    if (r.total_cost  != null) { sumCost += r.total_cost; costN++; }
    if (r.duration_ms != null) { sumDur += r.duration_ms; durN++; }
  }
  return {
    avg_score:       sumScore / runs.length,
    pass_rate:       succeeded / runs.length,
    avg_cost_usd:    costN > 0 ? sumCost / costN : 0,
    avg_duration_ms: durN > 0 ? sumDur / durN : 0,
    n:               runs.length,
  };
}

/**
 * Check a candidate's aggregate against acceptance_criteria. Returns:
 *   { eligible: boolean, reasons: string[] }
 * `reasons` lists every criterion that failed.
 */
export function checkAcceptance(
  agg: ReturnType<typeof aggregateScore>,
  criteria: AcceptanceCriteria | undefined,
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const ac = criteria ?? {};
  if ((ac.min_outcome_score ?? 0.7)     >  agg.avg_score)        reasons.push(`avg_score ${agg.avg_score.toFixed(3)} < min ${ac.min_outcome_score ?? 0.7}`);
  if ((ac.min_pass_rate     ?? 0.8)     >  agg.pass_rate)        reasons.push(`pass_rate ${agg.pass_rate.toFixed(3)} < min ${ac.min_pass_rate ?? 0.8}`);
  if (ac.max_avg_cost_usd     !== undefined && agg.avg_cost_usd    > ac.max_avg_cost_usd)    reasons.push(`avg_cost ${agg.avg_cost_usd.toFixed(4)} > max ${ac.max_avg_cost_usd}`);
  if (ac.max_avg_duration_ms  !== undefined && agg.avg_duration_ms > ac.max_avg_duration_ms) reasons.push(`avg_duration ${agg.avg_duration_ms.toFixed(0)}ms > max ${ac.max_avg_duration_ms}ms`);
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Decide if a candidate should be promoted over the parent.
 *
 *   - Candidate must clear acceptance_criteria
 *   - Candidate's avg_score must beat parent's by ≥ MIN_PROMOTION_DELTA
 *   - Optionally: candidate's avg_cost ≤ parent's (no cost regression)
 *
 * Returns { promote: boolean, reason: string, delta: number }.
 */
export function shouldPromote(
  candidateAgg: ReturnType<typeof aggregateScore>,
  parentAgg:    ReturnType<typeof aggregateScore>,
  acceptance:   AcceptanceCriteria | undefined,
): { promote: boolean; reason: string; delta: number } {
  const delta = candidateAgg.avg_score - parentAgg.avg_score;
  const accept = checkAcceptance(candidateAgg, acceptance);
  if (!accept.eligible) {
    return { promote: false, reason: `acceptance not met: ${accept.reasons.join("; ")}`, delta };
  }
  if (delta < MIN_PROMOTION_DELTA) {
    return { promote: false, reason: `delta ${delta.toFixed(3)} < min ${MIN_PROMOTION_DELTA}`, delta };
  }
  // Cost-regression guard: a candidate that's better-but-much-more-expensive
  // is suspect. Reject if cost is 2× the parent.
  if (parentAgg.avg_cost_usd > 0 && candidateAgg.avg_cost_usd > 2 * parentAgg.avg_cost_usd) {
    return { promote: false, reason: `cost regression: candidate ${candidateAgg.avg_cost_usd.toFixed(4)} > 2× parent ${parentAgg.avg_cost_usd.toFixed(4)}`, delta };
  }
  return { promote: true, reason: `delta ${delta.toFixed(3)} ≥ min ${MIN_PROMOTION_DELTA} and acceptance met`, delta };
}

/**
 * Score a fixture-replay match. Compares the actual outcome of replaying
 * the skill against `expected` from the fixture. Returns 0-1.
 *
 * The scoring rule depends on the shape of expected:
 *   - shallow object: each key compared via deep equality (or numeric
 *     range via {">="/"<=" comparators}); accuracy = matches / total_keys
 *   - regex pattern (string starting with `/...`/i): matched against actual stringified
 *
 * Kept intentionally simple — sophisticated replay scoring is a Sprint 2.5 item.
 */
export function scoreFixtureMatch(
  actual:   Record<string, unknown>,
  expected: Record<string, unknown>,
): { score: number; matched_keys: string[]; failed_keys: string[] } {
  const matched: string[] = [];
  const failed:  string[] = [];
  const keys = Object.keys(expected);
  if (keys.length === 0) return { score: 1, matched_keys: [], failed_keys: [] };

  for (const k of keys) {
    const exp = expected[k];
    const act = actual[k];
    if (matchesExpected(act, exp)) matched.push(k);
    else failed.push(k);
  }
  return { score: matched.length / keys.length, matched_keys: matched, failed_keys: failed };
}

function matchesExpected(actual: unknown, expected: unknown): boolean {
  // Comparator object: { ">=": 0.5 } / { "<=": 100 } / { "==": "foo" } / { "regex": "^abc" }
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    const o = expected as Record<string, unknown>;
    if ("==" in o) return JSON.stringify(actual) === JSON.stringify(o["=="]);
    if (">=" in o) return typeof actual === "number" && actual >= (o[">="] as number);
    if ("<=" in o) return typeof actual === "number" && actual <= (o["<="] as number);
    if (">"  in o) return typeof actual === "number" && actual >  (o[">"]  as number);
    if ("<"  in o) return typeof actual === "number" && actual <  (o["<"]  as number);
    if ("regex" in o) {
      try { return new RegExp(o["regex"] as string).test(String(actual)); }
      catch { return false; }
    }
    if ("includes" in o) return String(actual).includes(String(o["includes"]));
    // Plain object equality (recursive shallow)
    const actObj = (actual ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (!matchesExpected(actObj[k], o[k])) return false;
    }
    return true;
  }
  // Plain equality
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** Score a fixture run as a single SkillRun's accuracy-override. */
export function fixtureRunToAccuracy(
  fixture: SkillFixture,
  actualOutcome: Record<string, unknown>,
): number {
  return scoreFixtureMatch(actualOutcome, fixture.expected).score;
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
