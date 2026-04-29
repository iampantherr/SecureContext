/**
 * Replay harness (v0.18.0 Sprint 2 — D3 synthetic fixtures first)
 * ================================================================
 *
 * Runs a skill (parent or candidate) against a set of fixtures and produces
 * the aggregate score the orchestrator uses to decide promotion.
 *
 * For Sprint 2 we use SYNTHETIC fixtures only (per D3) — real-historical
 * replay is a Sprint 2.5 milestone gated on the synthetic loop being stable.
 *
 * EXECUTION MODEL:
 *   The replay doesn't spawn a real LLM agent — that would cost money and be
 *   non-deterministic. Instead, the harness invokes a `SkillExecutor`
 *   function that takes (skill_body, fixture_input) and returns a structured
 *   `actual_outcome`. Real implementations of SkillExecutor:
 *     - LocalDeterministicExecutor (default for tests + L1 mutation gating):
 *         applies a small set of canned rules to produce an outcome from the
 *         fixture's input, deterministic. Used to exercise the orchestrator.
 *     - LocalLLMExecutor (Sprint 2.5):
 *         spawns Ollama to actually run the skill body as a prompt.
 *     - HostedExecutor (Sprint 3+):
 *         pulls a real Claude session via Anthropic's Sonnet API.
 *
 * SECURITY:
 *   - Skills run in subprocess sandbox per RT-S2-03 (no file/network access
 *     beyond declared `requires_network`).
 *   - candidate_hmac is verified before replay starts (RT-S2-09).
 *   - Network access only when `frontmatter.requires_network=true` AND the
 *     URL matches `network_allowlist` (RT-S2-04).
 */

import type { Skill, SkillFixture, SkillRun } from "./types.js";
import { aggregateScore, scoreFixtureMatch, scoreSkillRun, fixtureRunToAccuracy, DEFAULT_SCORING } from "./scoring.js";
import { verifySkillHmac } from "./loader.js";
import { randomUUID } from "node:crypto";

/** Pluggable executor — produces an actual_outcome from a skill+input. */
export interface SkillExecutor {
  readonly id: string;
  execute(skill: Skill, input: Record<string, unknown>): Promise<{
    actual_outcome: Record<string, unknown>;
    duration_ms:    number;
    cost_usd:       number;
    tokens:         number;
    status:         "succeeded" | "failed" | "timeout";
    error?:         string;
  }>;
}

/**
 * Default executor for the L1 mutation-gating loop and unit tests. Applies
 * a few canned rules:
 *   - if input.simulate === "fail" → status=failed
 *   - if input.simulate === "timeout" → status=timeout
 *   - if input.simulate === "score" → return its `score` value
 *   - if skill body contains "## Mutation 4 (retry)" → bump match_count by 1
 *   - if skill body contains "## Mutation 5 (early-exit)" → return early-exit shape
 *   - default: echo input + small literal expected fields
 *
 * This deliberately makes some LocalMockMutator candidates measurably better
 * than parents on certain fixtures so the promotion path is observable in tests.
 */
export class LocalDeterministicExecutor implements SkillExecutor {
  readonly id = "local-deterministic";

  async execute(skill: Skill, input: Record<string, unknown>): Promise<{
    actual_outcome: Record<string, unknown>;
    duration_ms:    number;
    cost_usd:       number;
    tokens:         number;
    status:         "succeeded" | "failed" | "timeout";
    error?:         string;
  }> {
    const t0 = Date.now();

    if (input.simulate === "fail")    return { actual_outcome: {}, duration_ms: Date.now() - t0, cost_usd: 0, tokens: 0, status: "failed", error: "simulated failure" };
    if (input.simulate === "timeout") return { actual_outcome: {}, duration_ms: 30_001,           cost_usd: 0, tokens: 0, status: "timeout", error: "simulated timeout" };

    const body = skill.body;
    // Rule: skill that has retry block produces +1 retried_count
    const retried = body.includes("## Mutation 4 (retry)");
    // Rule: skill with early-exit returns ok=true even on bad input
    const hasEarlyExit = body.includes("## Mutation 5 (early-exit)");
    // Rule: skill with input-validation block flags bad inputs
    const hasValidation = body.includes("## Mutation 1 (defensive)");

    let outcome: Record<string, unknown> = {};
    if (typeof input.simulate === "object") {
      outcome = { ...(input.simulate as Record<string, unknown>) };
    } else {
      // Default behavior — produce a reasonable echo
      outcome = { ok: true, count: typeof input.x === "number" ? input.x : 0 };
    }
    if (retried) outcome.retried_count = 1;
    if (hasEarlyExit) outcome.ok = true;  // forces ok=true even when input.x is 0/null
    if (hasValidation && (input.x === undefined || input.x === null)) outcome.validation_flagged = true;

    return {
      actual_outcome: outcome,
      duration_ms: Date.now() - t0,
      cost_usd: 0,
      tokens: 0,
      status: "succeeded",
    };
  }
}

/** Result of replaying a single fixture against a skill. */
export interface FixtureReplayResult {
  fixture_id:    string;
  skill_id:      string;
  status:        "succeeded" | "failed" | "timeout";
  accuracy:      number;        // 0-1 from scoreFixtureMatch
  composite:     number;        // 0-1 from scoreSkillRun + accuracy override
  duration_ms:   number;
  cost_usd:      number;
  tokens:        number;
  matched_keys:  string[];
  failed_keys:   string[];
  failure_trace: string | null;
}

/** Replay one fixture. */
export async function replayFixture(
  skill: Skill,
  fixture: SkillFixture,
  executor: SkillExecutor,
): Promise<FixtureReplayResult> {
  // RT-S2-09 — verify body HMAC before executing
  const hmacOk = await verifySkillHmac(skill.body, skill.body_hmac);
  if (!hmacOk) {
    return {
      fixture_id: fixture.fixture_id, skill_id: skill.skill_id,
      status: "failed", accuracy: 0, composite: 0,
      duration_ms: 0, cost_usd: 0, tokens: 0,
      matched_keys: [], failed_keys: Object.keys(fixture.expected),
      failure_trace: "skill body HMAC mismatch — refusing to execute",
    };
  }

  const exec = await executor.execute(skill, fixture.input);
  const match = scoreFixtureMatch(exec.actual_outcome, fixture.expected);

  // Build a synthetic SkillRun so we can use scoreSkillRun's composite formula
  const run: SkillRun = {
    run_id:        randomUUID(),
    skill_id:      skill.skill_id,
    session_id:    "replay",
    task_id:       fixture.fixture_id,
    inputs:        fixture.input,
    outcome_score: match.score,        // accuracy from fixture match
    total_cost:    exec.cost_usd,
    total_tokens:  exec.tokens,
    duration_ms:   exec.duration_ms,
    status:        exec.status,
    failure_trace: exec.error ?? null,
    ts:            new Date().toISOString(),
  };

  const composite = scoreSkillRun(run, DEFAULT_SCORING, match.score);

  return {
    fixture_id:    fixture.fixture_id,
    skill_id:      skill.skill_id,
    status:        exec.status,
    accuracy:      match.score,
    composite,
    duration_ms:   exec.duration_ms,
    cost_usd:      exec.cost_usd,
    tokens:        exec.tokens,
    matched_keys:  match.matched_keys,
    failed_keys:   match.failed_keys,
    failure_trace: exec.error ?? null,
  };
}

/** Replay all fixtures attached to a skill. */
export async function replaySkill(skill: Skill, executor: SkillExecutor): Promise<{
  per_fixture:   FixtureReplayResult[];
  agg_score:     number;
  pass_rate:     number;
  avg_cost_usd:  number;
  avg_duration_ms: number;
}> {
  const fixtures = skill.frontmatter.fixtures ?? [];
  if (fixtures.length === 0) {
    return { per_fixture: [], agg_score: 0, pass_rate: 0, avg_cost_usd: 0, avg_duration_ms: 0 };
  }
  const results = await Promise.all(fixtures.map((f) => replayFixture(skill, f, executor)));

  // Convert to SkillRun shape so we can aggregate via scoring.aggregateScore
  const runs: SkillRun[] = results.map((r) => ({
    run_id: r.fixture_id, skill_id: r.skill_id, session_id: "replay", task_id: null,
    inputs: {}, outcome_score: r.accuracy, total_cost: r.cost_usd,
    total_tokens: r.tokens, duration_ms: r.duration_ms, status: r.status,
    failure_trace: r.failure_trace, ts: new Date().toISOString(),
  }));
  const agg = aggregateScore(runs);
  void fixtureRunToAccuracy;  // kept for external callers

  return {
    per_fixture:   results,
    agg_score:     agg.avg_score,
    pass_rate:     agg.pass_rate,
    avg_cost_usd:  agg.avg_cost_usd,
    avg_duration_ms: agg.avg_duration_ms,
  };
}

/**
 * Compare a candidate skill's replay vs. the parent's. Used by the
 * orchestrator to decide promotion.
 *
 * Returns the per-fixture results for both + aggregate scores.
 */
export async function compareReplays(
  parent:   Skill,
  candidate: Skill,
  executor:  SkillExecutor,
): Promise<{
  parent_replay:    Awaited<ReturnType<typeof replaySkill>>;
  candidate_replay: Awaited<ReturnType<typeof replaySkill>>;
  delta:            number;
}> {
  const [parent_replay, candidate_replay] = await Promise.all([
    replaySkill(parent,    executor),
    replaySkill(candidate, executor),
  ]);
  return {
    parent_replay,
    candidate_replay,
    delta: candidate_replay.agg_score - parent_replay.agg_score,
  };
}
