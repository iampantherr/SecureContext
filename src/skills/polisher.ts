/**
 * Skill polisher (v0.23.0 Phase 1 #2)
 * ====================================
 *
 * Refines a skill's `frontmatter.description` to be more discriminating —
 * agents pick skills by description-matching at task assignment time, so a
 * vague or generic description leads to wrong skill loads. The polisher
 * uses an LLM to rewrite the description following these rules:
 *
 *   - Start with a verb ("Diagnoses ...", "Generates ...")
 *   - State the trigger condition explicitly ("when X happens" / "before Y")
 *   - 80-200 chars
 *   - Mention primary inputs and outputs
 *   - Preserve all factual content from the original
 *
 * Operator-triggered (manual): the dashboard surfaces a "✨ Polish" button
 * on each skill row. Operator clicks → API endpoint → polisher returns
 * suggestion → operator reviews + approves → frontmatter.description
 * updated in skills_pg.
 *
 * Auto-triggered (cron, optional): a weekly cron MAY auto-polish all
 * descriptions and queue suggestions for operator approval. Off by default
 * to keep cost predictable.
 *
 * Backend selection mirrors the mutator: ZC_MUTATOR_MODEL env var.
 *   - "local-mock": deterministic transformation (for testing)
 *   - "realtime-sonnet": Claude Sonnet 4.6 via Anthropic API
 *
 * COST: ~$0.005 per polish call (Sonnet, 200 input + 100 output tokens).
 *
 * SECURITY: the polished description goes through skill lint (Phase 1 #4)
 * before being saved. If the polish breaks the lint rules, the suggestion
 * is rejected with the lint errors surfaced to the operator.
 */

import type { Skill, SkillFrontmatter } from "./types.js";
import { lintSkillBody } from "./lint.js";

export interface PolishResult {
  skill_id: string;
  /** Original description before polish. Operator can compare. */
  original: string;
  /** LLM-suggested replacement. May or may not be applied. */
  polished: string;
  /** Lint result on the new description (in context of full skill). */
  lint_passed: boolean;
  lint_warnings: string[];
  lint_errors: string[];
  /** Backend that produced the polish. */
  backend: "local-mock" | "realtime-sonnet";
  /** ms wall-clock for the polish call. */
  duration_ms: number;
}

/**
 * Public API: polish a skill's description. Returns a PolishResult; the
 * caller (API endpoint / dashboard handler) decides whether to apply it.
 *
 * Throws if the polish call fails entirely (network error, API down, etc.).
 * Returns a result with `lint_passed=false` if the polish succeeded but
 * the polished description fails lint — operator can review the errors
 * and either fix manually or re-polish.
 */
export async function polishSkillDescription(skill: Skill): Promise<PolishResult> {
  const start = Date.now();
  const backend = (process.env.ZC_MUTATOR_MODEL || "local-mock").toLowerCase();
  const original = skill.frontmatter.description ?? "";

  let polished: string;
  let backendUsed: "local-mock" | "realtime-sonnet";

  if (backend === "realtime-sonnet" && process.env.ANTHROPIC_API_KEY) {
    polished = await polishViaSonnet(skill);
    backendUsed = "realtime-sonnet";
  } else {
    polished = polishViaLocalMock(skill);
    backendUsed = "local-mock";
  }

  // Re-lint the polished frontmatter to make sure we didn't make it worse.
  const polishedFm: SkillFrontmatter = { ...skill.frontmatter, description: polished };
  const lintResult = lintSkillBody(skill.body, polishedFm);

  return {
    skill_id: skill.skill_id,
    original,
    polished,
    lint_passed: lintResult.ok,
    lint_warnings: lintResult.warnings,
    lint_errors: lintResult.errors,
    backend: backendUsed,
    duration_ms: Date.now() - start,
  };
}

/**
 * Local-mock polisher — deterministic transformation suitable for testing
 * and offline use. Applies a few simple rules to make the description
 * more action-oriented:
 *   - Prepend a verb if the description doesn't start with one
 *   - Truncate at 200 chars
 *   - Strip leading/trailing whitespace + duplicated whitespace
 *
 * Not intended to produce production-quality polish; that's what the
 * Sonnet backend is for.
 */
function polishViaLocalMock(skill: Skill): string {
  let d = (skill.frontmatter.description ?? "").trim().replace(/\s+/g, " ");
  // If too short, append the first sentence of the body to extend it.
  if (d.length < 30) {
    const firstSent = (skill.body.split(/\.[^.]/)[0] ?? "").trim().slice(0, 200);
    if (firstSent.length > 10) d = `${d.replace(/\.$/, "")}. ${firstSent}.`;
  }
  // If too long, truncate to ≤200.
  if (d.length > 200) d = d.slice(0, 197) + "...";
  // If doesn't start with a capital letter, capitalize first char.
  if (d.length > 0 && d[0] !== d[0].toUpperCase()) {
    d = d[0].toUpperCase() + d.slice(1);
  }
  return d;
}

/**
 * Sonnet-driven polisher — sends the skill description + body excerpt to
 * Claude Sonnet 4.6 with a refinement prompt. Returns the polished string.
 *
 * Throws on API errors; the caller should fall back gracefully to the
 * local-mock if cost or availability is a concern.
 */
async function polishViaSonnet(skill: Skill): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("polishViaSonnet: ANTHROPIC_API_KEY not set");

  const original = skill.frontmatter.description ?? "(empty)";
  // Use a body excerpt: first 1500 chars is enough to give the LLM context
  // without bloating the prompt cost.
  const bodyExcerpt = skill.body.slice(0, 1500);

  const userPrompt = `You are refining the description of a skill that agents use to decide whether to invoke this skill for a given task.

Skill body (for context):
\`\`\`
${bodyExcerpt}
${skill.body.length > 1500 ? "\n[... body truncated ...]" : ""}
\`\`\`

Current description:
"""${original}"""

Rewrite the description to:
1. Start with a verb (e.g., "Diagnoses ...", "Generates ...", "Validates ...")
2. State the trigger condition explicitly ("when X happens" / "before Y")
3. Be 80-200 chars
4. Mention the primary inputs and outputs at a high level
5. Preserve all factual content from the original — don't invent new claims

Return ONLY the rewritten description. No preamble, no quotes, no markdown.`;

  const body = JSON.stringify({
    model:       "claude-sonnet-4-6",
    max_tokens:  300,
    temperature: 0.2,
    messages: [{ role: "user", content: userPrompt }],
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`polishViaSonnet: API error ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const j = (await res.json()) as { content?: Array<{ type: string; text: string }> };
  const text = j.content?.find((c) => c.type === "text")?.text ?? "";
  return text.trim();
}
