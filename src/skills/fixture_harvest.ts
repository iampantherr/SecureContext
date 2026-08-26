/**
 * Fixture harvesting (v0.61.0 — mutation engine M3)
 * ===================================================
 *
 * Two sources, one rule: the test-maker is never the test-taker.
 *
 * 1. deriveFailureFixtures — turn the REAL failure traces that triggered a
 *    mutation cycle into replay fixtures. These are the failure ANCHORS: a
 *    candidate that does not pass them has not fixed the underlying thing,
 *    whatever else it improves (operator's rule). Derived by a model call
 *    that is separate from proposer, judge, and replay simulator.
 *
 * 2. harvestFixturesFromRuns — turn high-scoring historical runs into
 *    regression fixtures ("what already worked must keep working"), so a fix
 *    for the failing case cannot quietly narrow the skill.
 *
 * Fixtures carry provenance in their ids: `failure-anchor-*` and
 * `harvested-run-*`. The orchestrator's promotion gate treats the anchors as
 * MUST-PASS and everything else as no-regression.
 */
import type { MutationContext, SkillFixture, SkillRun, Skill } from "./types.js";
import { runClaudeHeadless, extractJsonPayload } from "./mutators/cli_headless.js";

/** Derive up to `n` failure-anchor fixtures from the cycle's failure traces. */
export function deriveFailureFixtures(ctx: MutationContext, n = 2): SkillFixture[] {
  const traces = ctx.failure_traces.filter((t) => t && t.trim().length > 20).slice(0, 4);
  if (traces.length === 0) return [];
  const prompt = [
    `Turn REAL failure reports about a skill (a procedure document AI agents`,
    `follow) into replay fixtures. A fixture describes the SCENARIO that`,
    `exposed the failure and the outcome a CORRECT skill would produce there.`,
    ``,
    `Rules:`,
    `- input.scenario: a concrete, self-contained restatement of the situation`,
    `  from the trace (what the agent faced), NOT a quote of the trace.`,
    `- expected: 2-4 plain keys a correct skill must achieve in that scenario`,
    `  (booleans preferred; short strings allowed). These must describe the`,
    `  UNDERLYING requirement that failed, not superficial wording.`,
    ``,
    `## Skill (for context)`,
    "```markdown",
    ctx.parent.body.slice(0, 8_000),
    "```",
    ``,
    `## Failure reports`,
    ...traces.map((t, i) => `### Trace ${i + 1}\n${t.slice(0, 1200)}`),
    ``,
    `Reply with ONLY a JSON array of at most ${n} fixtures:`,
    `[{"fixture_id":"failure-anchor-1","description":"<=120 chars","input":{"scenario":"..."},"expected":{...}}]`,
  ].join("\n");
  try {
    const raw = runClaudeHeadless(prompt, { timeoutMs: 240_000 });
    const arr = JSON.parse(extractJsonPayload(raw)) as SkillFixture[];
    return arr.slice(0, n).map((f, i) => ({
      fixture_id:  `failure-anchor-${i + 1}`,
      description: String(f.description ?? "").slice(0, 200),
      input:       (f.input && typeof f.input === "object") ? f.input : { scenario: String(f.input ?? "") },
      expected:    (f.expected && typeof f.expected === "object") ? f.expected : {},
    })).filter((f) => Object.keys(f.expected).length > 0);
  } catch {
    return [];   // no anchors derivable — cycle falls back to judge-only gating
  }
}

/**
 * Harvest regression fixtures from high-scoring historical runs. Pure data
 * transformation (no model): the run's task context becomes the scenario, the
 * high outcome becomes the expectation that it stays achieved.
 */
export function harvestFixturesFromRuns(_skill: Skill, runs: SkillRun[], n = 3): SkillFixture[] {
  const good = runs
    .filter((r) => (r.outcome_score ?? 0) >= 0.8 && Object.keys(r.inputs ?? {}).length > 0)
    .slice(0, n);
  return good.map((r, i) => ({
    fixture_id:  `harvested-run-${i + 1}`,
    description: `regression: high-scoring real run ${r.run_id} (score ${(r.outcome_score ?? 0).toFixed(2)})`,
    input:       { scenario: JSON.stringify(r.inputs).slice(0, 1_500) },
    expected:    { handled_successfully: true },
  }));
}
