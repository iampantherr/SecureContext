/**
 * Complexity-based model routing (v0.17.0 §8.5)
 * ==============================================
 *
 * Maps a task's `complexity_estimate` (1-5, from v0.15.0 §8.1 structured
 * ASSIGN) to a recommended Claude model + reasoning. Designed to be
 * called by the orchestrator before assigning a task to a worker pool tier.
 *
 * Default tier mapping (per HARNESS_EVOLUTION_PLAN.md §8.5):
 *   1, 2 → Haiku 4.5 (cheap; trivial code edits, formatting, doc tweaks)
 *   3, 4 → Sonnet 4.6 (default; standard implementation tasks)
 *   5    → Opus 4.7 (complex coordination, hard reasoning)
 *
 * Operators can override the mapping via `ZC_MODEL_TIER_HAIKU`,
 * `ZC_MODEL_TIER_SONNET`, `ZC_MODEL_TIER_OPUS` env vars.
 */

export type ComplexityEstimate = 1 | 2 | 3 | 4 | 5;

export interface ModelRecommendation {
  /** Recommended Claude model identifier. */
  model: string;
  /** Tier label for routing logic (haiku|sonnet|opus). */
  tier: "haiku" | "sonnet" | "opus";
  /** Human-readable rationale (shown in tool output). */
  reason: string;
  /** Per-Mtok input cost in USD (from src/pricing.ts pricing table). */
  estimatedInputCostPerMtok: number;
  /** Was the input clamped to the supported 1-5 range? */
  inputClamped: boolean;
}

// Resolved at call time so env-var overrides take effect without reloading the module.
function resolveModel(tier: "haiku" | "sonnet" | "opus"): string {
  if (tier === "haiku")  return process.env.ZC_MODEL_TIER_HAIKU  || "claude-haiku-4-5";
  if (tier === "sonnet") return process.env.ZC_MODEL_TIER_SONNET || "claude-sonnet-4-6";
  return process.env.ZC_MODEL_TIER_OPUS || "claude-opus-4-7";
}

// Cost reference (from src/pricing.ts table — kept here as a duplicate
// for self-contained explanation; if pricing table changes update both).
const COST_PER_MTOK_INPUT: Record<string, number> = {
  "claude-haiku-4-5":  0.25,
  "claude-sonnet-4-6": 3.00,
  "claude-opus-4-7":   15.00,
};

/**
 * Recommend a model for a given complexity estimate.
 *
 * Behavior:
 *   - undefined/null/non-finite/non-1-5 → defaults to Sonnet + inputClamped=true
 *   - 1-2 → Haiku
 *   - 3-4 → Sonnet
 *   - 5   → Opus
 */
export function chooseModel(complexity: number | null | undefined): ModelRecommendation {
  let level: ComplexityEstimate;
  let clamped = false;

  if (typeof complexity !== "number" || !Number.isFinite(complexity)) {
    level = 3;  // Sonnet default
    clamped = true;
  } else {
    const rounded = Math.round(complexity);
    if (rounded < 1) { level = 1; clamped = rounded !== 1; }
    else if (rounded > 5) { level = 5; clamped = rounded !== 5; }
    else { level = rounded as ComplexityEstimate; }
  }

  let tier: "haiku" | "sonnet" | "opus";
  let model: string;
  let reason: string;

  if (level <= 2) {
    tier = "haiku";
    model = resolveModel("haiku");
    reason = `Complexity ${level}/5 — Haiku is cost-optimal for trivial tasks (formatting, simple edits, doc tweaks).`;
  } else if (level <= 4) {
    tier = "sonnet";
    model = resolveModel("sonnet");
    reason = `Complexity ${level}/5 — Sonnet is the sweet spot for standard implementation work.`;
  } else {
    tier = "opus";
    model = resolveModel("opus");
    reason = `Complexity ${level}/5 — Opus warranted for hard reasoning, complex coordination, or multi-file refactors.`;
  }

  if (clamped) {
    reason += ` (Note: input ${complexity ?? "not provided"} clamped → treated as ${level}.)`;
  }

  return {
    model,
    tier,
    reason,
    estimatedInputCostPerMtok: COST_PER_MTOK_INPUT[model] ?? 0,
    inputClamped: clamped,
  };
}
