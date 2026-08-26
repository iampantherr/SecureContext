/**
 * Independent mutation judge (v0.60.0 — mutation engine M2)
 * ==========================================================
 *
 * Before this module there WAS no judge: `judge_score` was the PROPOSER'S
 * SELF-RATING (candidate.self_rated_score) and `judged_by` whatever string the
 * mutator reported — the mock rated its own candidates 0.58 and the engine's
 * ten lifetime mutations were self-graded. A proposer grading itself is the
 * definition of a gameable gate.
 *
 * This judge is a SEPARATE model call (subscription-billed via `claude -p`,
 * same as the cli-headless proposer) that never sees the proposer's
 * self-ratings, and is explicitly instructed to REJECT overfit: hardcoded
 * outputs, input-matching special cases that only cover the failing scenario,
 * or edits that narrow a general skill to pass one case. That last check is
 * the operator's anti-Goodhart rule: a candidate must fix the UNDERLYING
 * failure, not memorize the test.
 *
 * Selection mirrors the mutator: ZC_JUDGE_MODEL ∈ {cli-headless, local-mock};
 * unset/unknown → local-mock, which preserves the legacy self-rating
 * behavior EXPLICITLY (judged_by='self-rating-no-judge') so dashboards can
 * tell "never judged" from "judged".
 */
import type { MutationContext, MutationCandidate } from "./types.js";
import { extractJsonPayload } from "./mutators/cli_headless.js";

export interface JudgeVerdict {
  score:     number;        // 0..1
  rationale: string;
  overfit:   boolean;       // true → candidate special-cases the failure instead of fixing it
}

export interface JudgeResult {
  judged_by: string;
  verdicts:  JudgeVerdict[];   // parallel to candidates[]
}

export const KNOWN_JUDGES = new Set(["cli-headless", "local-mock"]);

export function resolveJudgeId(envOverride?: string): string {
  const raw = (envOverride ?? process.env["ZC_JUDGE_MODEL"] ?? "local-mock").trim();
  return KNOWN_JUDGES.has(raw) ? raw : "local-mock";
}

export function buildJudgePrompt(ctx: MutationContext, candidates: MutationCandidate[]): string {
  // v0.62.0 M6 — description-tune judging: candidates are replacement
  // DESCRIPTIONS. Different rubric: selection accuracy, honesty vs the body,
  // and the 1024-char admission limit (over-limit = automatic overfit-cap,
  // it can never be admitted).
  if (ctx.description_tune) {
    const cands = candidates.map((c, i) =>
      `### Candidate ${i} (${c.candidate_body.length} chars)\n${c.candidate_body.slice(0, 2_000)}`).join("\n\n");
    return [
      `You are an independent judge for skill DESCRIPTION rewrites. The`,
      `description is the skill-selection surface: agents read it to decide`,
      `whether to load the skill. Score each candidate 0.0-1.0 on:`,
      `- TRIGGER ACCURACY: names the concrete situations/error codes/tasks the`,
      `  body actually handles — an agent facing those must match, an agent`,
      `  facing anything else must not.`,
      `- HONESTY: promises nothing the body does not deliver.`,
      `- ECONOMY: information-dense, no narrative filler.`,
      ``,
      `HARD RULES (violations set "overfit": true, capping the score at 0.2):`,
      `- Over 1024 characters — the admission gate rejects it outright.`,
      `- Drops a concrete trigger (error code, tool name, state name) present`,
      `  in the current description that the body still handles.`,
      ``,
      `## Skill body (ground truth)`,
      "```markdown",
      ctx.parent.body.slice(0, 10_000),
      "```",
      ``,
      `## Current description (${ctx.parent.frontmatter.description.length} chars)`,
      ctx.parent.frontmatter.description,
      ``,
      `## Candidates`,
      cands,
      ``,
      `Reply with ONLY a JSON array, one object per candidate, same order:`,
      `[{"index": 0, "score": 0.0, "overfit": false, "rationale": "<=200 chars"}, ...]`,
    ].join("\n");
  }

  const failures = ctx.failure_traces.slice(0, 5).map((t, i) => `### Failure ${i + 1}\n${t.slice(0, 1500)}`).join("\n\n");
  const cands = candidates.map((c, i) =>
    `### Candidate ${i}\n\`\`\`markdown\n${c.candidate_body.slice(0, 12_000)}\n\`\`\``).join("\n\n");
  return [
    `You are an independent judge for skill mutations. A "skill" is a reusable`,
    `procedure document an AI agent follows. The PARENT skill below failed in`,
    `real use; each CANDIDATE is a proposed replacement body. Score each`,
    `candidate 0.0-1.0 on whether it fixes the UNDERLYING cause of the failures`,
    `without regressing the skill's general usefulness.`,
    ``,
    `HARD RULES (violations cap the score at 0.2 and set "overfit": true):`,
    `- A candidate that hardcodes expected outputs, matches on specifics of the`,
    `  failing input, or adds a special-case branch that only covers the failure`,
    `  scenario is OVERFIT — it memorized the test instead of fixing the cause.`,
    `- A candidate that narrows a broadly-useful skill so it passes one case is`,
    `  OVERFIT (the correct remedy for a project-specific failure of a broad`,
    `  skill is a separate project-scoped skill, not warping the general one).`,
    `- Removing the failing functionality entirely does not count as fixing it.`,
    ``,
    `## Parent skill: ${ctx.parent.skill_id}`,
    "```markdown",
    ctx.parent.body.slice(0, 12_000),
    "```",
    ``,
    `## Recent real failures`,
    failures || "(no traces captured — judge on general quality alone and say so)",
    ``,
    `## Candidates`,
    cands,
    ``,
    `Reply with ONLY a JSON array, one object per candidate, same order:`,
    `[{"index": 0, "score": 0.0, "overfit": false, "rationale": "<=200 chars"}, ...]`,
  ].join("\n");
}

export function parseJudgeResponse(raw: string, n: number): JudgeVerdict[] {
  // Tolerant extraction shared with the proposer — the full-CLI model wraps
  // payloads in prose/fences despite instructions (observed live).
  const arr = JSON.parse(extractJsonPayload(raw));
  if (!Array.isArray(arr)) throw new Error("judge response is not an array");
  const out: JudgeVerdict[] = [];
  for (let i = 0; i < n; i++) {
    const row = arr.find((r: { index?: number }) => r?.index === i) ?? arr[i];
    const score = typeof row?.score === "number" ? Math.max(0, Math.min(1, row.score)) : 0;
    const overfit = row?.overfit === true;
    out.push({
      score: overfit ? Math.min(score, 0.2) : score,   // enforce the cap even if the model forgot
      rationale: String(row?.rationale ?? "").slice(0, 400),
      overfit,
    });
  }
  return out;
}

/**
 * Judge all candidates. local-mock preserves legacy self-ratings but LABELS
 * them honestly. cli-headless makes one real model call for the whole set.
 * Never throws — a judge error falls back to self-ratings with the error in
 * the rationale, so a cycle is never lost to a judging hiccup.
 */
export async function judgeCandidates(ctx: MutationContext, candidates: MutationCandidate[]): Promise<JudgeResult> {
  const id = resolveJudgeId();
  if (id !== "cli-headless") {
    return {
      judged_by: "self-rating-no-judge",
      verdicts: candidates.map((c) => ({
        score: c.self_rated_score ?? 0,
        rationale: c.rationale ?? "",
        overfit: false,
      })),
    };
  }
  try {
    const { runClaudeHeadless } = await import("./mutators/cli_headless.js");
    const raw = runClaudeHeadless(buildJudgePrompt(ctx, candidates), {
      model: process.env["ZC_JUDGE_CLI_MODEL"] || undefined,
    });
    return { judged_by: "cli-headless", verdicts: parseJudgeResponse(raw, candidates.length) };
  } catch (e) {
    return {
      judged_by: "self-rating-no-judge",
      verdicts: candidates.map((c) => ({
        score: c.self_rated_score ?? 0,
        rationale: `judge error, fell back to self-rating: ${(e as Error).message.slice(0, 200)}`,
        overfit: false,
      })),
    };
  }
}
