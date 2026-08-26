/**
 * LLM replay executor (v0.61.0 — mutation engine M3)
 * ====================================================
 *
 * The LocalDeterministicExecutor is a TOY: it pattern-matches the mock's
 * template strings and echoes inputs — it cannot evaluate whether a real
 * markdown skill handles a real scenario. This executor does the only honest
 * replay for procedure-documents: a model SIMULATES an agent following the
 * skill body against the fixture's scenario and reports the outcome object,
 * which the existing scorer compares against `expected`.
 *
 * Subscription-billed via the same `claude -p` runner as proposer and judge.
 *
 * ANTI-GAMING position in the pipeline: the proposer never sees fixture
 * expected-outputs (held-out — see orchestrator), and this executor never
 * sees the proposer's rationale or the judge's verdicts. Three independent
 * model roles, three separate calls.
 */
import type { Skill } from "./types.js";
import type { SkillExecutor } from "./replay.js";
import { runClaudeHeadless, extractJsonPayload } from "./mutators/cli_headless.js";

export class CliHeadlessExecutor implements SkillExecutor {
  readonly id = "cli-headless-replay";

  async execute(skill: Skill, input: Record<string, unknown>, meta?: { expected_keys?: string[] }): Promise<{
    actual_outcome: Record<string, unknown>;
    duration_ms:    number;
    cost_usd:       number;
    tokens:         number;
    status:         "succeeded" | "failed" | "timeout";
    error?:         string;
  }> {
    const t0 = Date.now();
    const prompt = [
      `You are simulating an AI agent that follows the skill document below,`,
      `applied to the scenario described in INPUT. Faithfully work through what`,
      `an agent following THESE EXACT instructions would do and what outcome it`,
      `would reach. Judge the skill as written — do not fix its gaps for it: if`,
      `the instructions would miss something in this scenario, the outcome must`,
      `reflect that miss.`,
      ``,
      `## Skill document`,
      "```markdown",
      skill.body.slice(0, 14_000),
      "```",
      ``,
      `## INPUT (scenario)`,
      "```json",
      JSON.stringify(input).slice(0, 4_000),
      "```",
      ``,
      `Reply with ONLY a JSON object describing the outcome an agent following`,
      `this skill would produce for this scenario. Use plain keys with boolean /`,
      `number / short-string values (e.g. {"captured_g7": false, "reason": "…"}).`,
      // The rubric: key NAMES the scorer grades (never target values). Without
      // this the simulator answers in its own vocabulary and every graded key
      // scores 0 even when the skill handles the scenario.
      ...(meta?.expected_keys?.length
        ? [``, `Your JSON object MUST include each of these keys with your honest`,
           `value for what the skill as written would achieve:`,
           meta.expected_keys.map((k) => `- ${k}`).join("\n")]
        : []),
    ].join("\n");

    try {
      const raw = runClaudeHeadless(prompt, {
        model: process.env["ZC_REPLAY_CLI_MODEL"] || undefined,
        timeoutMs: parseInt(process.env["ZC_REPLAY_TIMEOUT_MS"] ?? "", 10) || 240_000,
      });
      const outcome = JSON.parse(extractJsonPayload(raw)) as Record<string, unknown>;
      return { actual_outcome: outcome, duration_ms: Date.now() - t0, cost_usd: 0, tokens: 0, status: "succeeded" };
    } catch (e) {
      return { actual_outcome: {}, duration_ms: Date.now() - t0, cost_usd: 0, tokens: 0, status: "failed", error: (e as Error).message.slice(0, 300) };
    }
  }
}

export const KNOWN_REPLAY_EXECUTORS = new Set(["cli-headless", "local-deterministic"]);

/** ZC_REPLAY_MODEL selects the executor; unset/unknown → the deterministic toy
 *  (tests). Mirrors mutator/judge resolution. */
export function resolveReplayExecutorId(envOverride?: string): string {
  const raw = (envOverride ?? process.env["ZC_REPLAY_MODEL"] ?? "local-deterministic").trim();
  return KNOWN_REPLAY_EXECUTORS.has(raw) ? raw : "local-deterministic";
}
