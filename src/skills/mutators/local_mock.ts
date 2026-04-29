/**
 * LocalMockMutator (v0.18.0)
 * ===========================
 *
 * Deterministic non-LLM mutator used in tests + as the safe fallback when
 * ZC_MUTATOR_MODEL is unset or unrecognized. Generates 5 candidates by
 * applying simple text rules to the parent body — pretends to be a smart
 * proposer for the purpose of exercising the orchestrator + replay loop.
 *
 * The "judge_pick_index" is deterministic-pseudo-random based on the parent
 * body hash so test runs are reproducible.
 */

import type { Mutator } from "../mutator.js";
import type { MutationContext, MutationResult, MutationCandidate } from "../types.js";
import { createHash } from "node:crypto";

export class LocalMockMutator implements Mutator {
  readonly id = "local-mock";

  async mutate(ctx: MutationContext): Promise<MutationResult> {
    const body = ctx.parent.body;

    // Five canned mutations — each tweaks the body in a recognizable way so
    // tests can assert on the exact transformation without LLM nondeterminism.
    const candidates: MutationCandidate[] = [
      {
        candidate_body: body + "\n\n## Mutation 1 (defensive)\nAlways validate inputs before processing.",
        rationale:      "Adds explicit input-validation step to address recent failures.",
        self_rated_score: 0.7,
      },
      {
        candidate_body: body.replace(/^# .*$/m, "# Improved Title"),
        rationale:      "Renames the main heading for clarity (no behavioral change).",
        self_rated_score: 0.4,
      },
      {
        candidate_body: body + "\n\n## Mutation 3 (logging)\nLog every step to ~/.claude/zc-ctx/logs/skills.log for debugging.",
        rationale:      "Adds observability so future failures are diagnosable.",
        self_rated_score: 0.6,
      },
      {
        candidate_body: body + "\n\n## Mutation 4 (retry)\nIf the first attempt fails, retry once with reduced inputs.",
        rationale:      "Adds resilience against transient failures.",
        self_rated_score: 0.65,
      },
      {
        candidate_body: body + "\n\n## Mutation 5 (early-exit)\nExit early when input is empty or known-bad.",
        rationale:      "Reduces time spent on inputs that can't possibly succeed.",
        self_rated_score: 0.55,
      },
    ];

    // Deterministic judge pick — hash of body chooses 0-4
    const h = createHash("sha256").update(body).digest();
    const judgePickIndex = h.readUInt8(0) % 5;

    // Avoid linter unused-var warnings
    void ctx.failure_traces;

    return {
      candidates,
      proposer_model:    "local-mock",
      proposer_cost_usd: 0,
      judge_pick_index:  judgePickIndex,
      judge_model:       "local-mock-judge",
      judge_rationale:   `Picked candidate ${judgePickIndex + 1} via deterministic hash-based selection.`,
      total_cost_usd:    0,
    };
  }
}
