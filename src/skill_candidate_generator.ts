/**
 * v0.20.0 — Generate a draft skill body from a rejection cluster.
 *
 * Closes the bootstrap loop's last manual step: in v0.19.0 the operator
 * had to author the .skill.md file by hand when a candidate appeared.
 * This module consults an LLM (Ollama by default, Anthropic if configured)
 * with the rejection-reason cluster + role context, and produces a draft
 * skill body in the standard *.skill.md format ready for operator review.
 *
 * The output is NOT auto-installed — it goes back into
 * skill_candidates_pg.proposed_skill_body and the dashboard surfaces it
 * for operator approve/edit/reject. This is intentional: an LLM-generated
 * skill is a starting point, not a deployment.
 *
 * Configuration:
 *   ZC_SKILL_GEN_BACKEND  ollama (default) | anthropic
 *   ZC_OLLAMA_URL         (existing — for ollama backend)
 *   ZC_OLLAMA_GEN_MODEL   default qwen2.5-coder:14b
 *   ANTHROPIC_API_KEY     (for anthropic backend)
 *   ZC_ANTHROPIC_GEN_MODEL default claude-sonnet-4-6
 */

import { withClient } from "./pg_pool.js";
import { logger } from "./logger.js";

// v0.20.0 — default to Anthropic/Sonnet for skill body generation.
// Operator preference: Sonnet 4.6 produces materially better skill bodies
// than Ollama on a body-of-work this small. Falls back to Ollama only if
// ANTHROPIC_API_KEY is unset (graceful degradation for dev/no-cloud installs).
function defaultBackend(): string {
  const explicit = process.env.ZC_SKILL_GEN_BACKEND;
  if (explicit) return explicit.toLowerCase();
  return process.env.ANTHROPIC_API_KEY ? "anthropic" : "ollama";
}
const BACKEND       = defaultBackend();
// v0.20.0 — strip /api/* suffix; we need the base to construct /api/generate
function ollamaBase(): string {
  const raw = process.env.ZC_OLLAMA_URL ?? "http://localhost:11435";
  return raw.replace(/\/api\/[^/]+\/?$/, "").replace(/\/$/, "");
}
const OLLAMA_URL    = ollamaBase();
const OLLAMA_MODEL  = process.env.ZC_OLLAMA_GEN_MODEL ?? "qwen2.5-coder:14b";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const ANTHROPIC_MOD = process.env.ZC_ANTHROPIC_GEN_MODEL ?? "claude-sonnet-4-6";

interface GenerationInput {
  candidate_id:    string;
  target_role:     string;
  rejection_count: number;
  reasons:         string[];
  headline:        string;
}

interface GenerationOutput {
  ok:              boolean;
  skill_body:      string | null;
  proposed_name:   string | null;
  backend_used:    string;
  prompt_tokens:   number;
  response_tokens: number;
  error?:          string;
}

const SYSTEM_PROMPT = `You are a skill-design expert. You generate behavioral skills for AI agents that codify "what to do before/during/after" specific tasks.

Your output MUST be a valid Markdown file with YAML frontmatter and a body. The frontmatter has these required fields:
  id           — string in form 'name@1@global'
  name         — kebab-case slug, no spaces, max 60 chars
  version      — number, start at 1
  scope        — 'global' or 'project:<hash>'
  description  — one-line summary
  intended_roles — YAML array of role names this skill applies to
  mutation_guidance — multi-line block, advice for the mutator about what's safe to mutate

The body should:
- Start with a clear "When to invoke this skill" section
- List numbered steps the agent should take
- Include concrete acceptance criteria (what does success look like?)
- End with a "Failure modes" section listing common pitfalls

Be concise. The goal is a skill that prevents the failure pattern in the rejection cluster.`;

function buildUserPrompt(input: GenerationInput): string {
  return `A cluster of ${input.rejection_count} rejections has been observed for the "${input.target_role}" role with no governing skill.

REJECTION SUMMARY: ${input.headline}

INDIVIDUAL REASONS:
${input.reasons.map((r, i) => `  ${i + 1}. ${r}`).join("\n")}

Design a skill that, if invoked by a "${input.target_role}" agent before completing similar tasks, would prevent these rejections.

Respond with ONLY the .skill.md file content (no preamble, no commentary, no code fences). Start with the YAML frontmatter (---) and end with the body content.`;
}

async function callOllama(prompt: string, systemPrompt: string): Promise<{ text: string; promptTokens: number; responseTokens: number }> {
  const url = `${OLLAMA_URL.replace(/\/$/, "")}/api/generate`;
  const body = {
    model: OLLAMA_MODEL,
    system: systemPrompt,
    prompt,
    stream: false,
    options: { temperature: 0.3, num_predict: 1500 },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${await r.text().catch(() => "(no body)")}`);
  const j = await r.json() as { response: string; prompt_eval_count?: number; eval_count?: number };
  return {
    text: j.response ?? "",
    promptTokens: j.prompt_eval_count ?? 0,
    responseTokens: j.eval_count ?? 0,
  };
}

async function callAnthropic(prompt: string, systemPrompt: string): Promise<{ text: string; promptTokens: number; responseTokens: number }> {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set — cannot use anthropic backend");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MOD,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text().catch(() => "(no body)")}`);
  type AnthropicResponse = {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const j = await r.json() as AnthropicResponse;
  const text = j.content?.find((b) => b.type === "text")?.text ?? "";
  return {
    text,
    promptTokens: j.usage?.input_tokens ?? 0,
    responseTokens: j.usage?.output_tokens ?? 0,
  };
}

/** Strip code fences if the LLM wrapped the output. */
function unwrapFences(s: string): string {
  const t = s.trim();
  if (t.startsWith("```")) {
    const end = t.lastIndexOf("```");
    if (end > 3) return t.slice(t.indexOf("\n") + 1, end).trim();
  }
  return t;
}

/** Light validation: must have YAML frontmatter delimiters. */
function looksLikeSkillFile(s: string): boolean {
  return s.trimStart().startsWith("---") && s.includes("\n---\n") && s.toLowerCase().includes("intended_roles");
}

/** Extract the proposed name from the generated frontmatter for display. */
function extractName(s: string): string | null {
  const m = s.match(/^name:\s*([^\n]+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

export async function generateSkillBody(input: GenerationInput): Promise<GenerationOutput> {
  const userPrompt = buildUserPrompt(input);
  try {
    const { text, promptTokens, responseTokens } =
      BACKEND === "anthropic" ? await callAnthropic(userPrompt, SYSTEM_PROMPT)
                              : await callOllama(userPrompt, SYSTEM_PROMPT);
    const cleaned = unwrapFences(text);
    if (!looksLikeSkillFile(cleaned)) {
      return {
        ok: false,
        skill_body: cleaned,  // return what we got for operator inspection
        proposed_name: null,
        backend_used: BACKEND,
        prompt_tokens: promptTokens,
        response_tokens: responseTokens,
        error: "Generated text doesn't have valid skill-file structure (missing frontmatter or intended_roles). Operator needs to repair before approval.",
      };
    }
    return {
      ok: true,
      skill_body: cleaned,
      proposed_name: extractName(cleaned),
      backend_used: BACKEND,
      prompt_tokens: promptTokens,
      response_tokens: responseTokens,
    };
  } catch (e) {
    logger.error("skills", "skill_candidate_generation_failed", {
      candidate_id: input.candidate_id, error: (e as Error).message, backend: BACKEND,
    });
    return {
      ok: false,
      skill_body: null,
      proposed_name: null,
      backend_used: BACKEND,
      prompt_tokens: 0,
      response_tokens: 0,
      error: (e as Error).message,
    };
  }
}

/**
 * Trigger generation for a specific candidate — read the row, build the
 * input, call the LLM, persist the result back to skill_candidates_pg.
 * Sets status to 'generating' during the call, 'ready' on success,
 * keeps 'pending' on failure (so operator can retry).
 */
export async function generateForCandidate(candidateId: string): Promise<GenerationOutput> {
  // Load the candidate
  const candidateRow = await withClient(async (c) => {
    const r = await c.query<{
      candidate_id: string;
      target_role: string;
      rejection_count: number;
      headline: string;
      rejection_outcomes: Array<{ evidence: { reject_reason?: string; reject_summary?: string } }>;
    }>(
      `SELECT candidate_id, target_role, rejection_count, headline, rejection_outcomes
         FROM skill_candidates_pg
        WHERE candidate_id = $1 AND status IN ('pending', 'ready')
        LIMIT 1`,
      [candidateId],
    );
    return r.rows[0] ?? null;
  });
  if (!candidateRow) {
    return { ok: false, skill_body: null, proposed_name: null, backend_used: BACKEND, prompt_tokens: 0, response_tokens: 0, error: "Candidate not found or already approved/rejected" };
  }

  // Mark generating
  await withClient(async (c) => {
    await c.query(`UPDATE skill_candidates_pg SET status='generating' WHERE candidate_id=$1`, [candidateId]);
  });

  const reasons = (candidateRow.rejection_outcomes ?? [])
    .map(o => o.evidence?.reject_reason ?? o.evidence?.reject_summary ?? "")
    .filter((s): s is string => Boolean(s))
    .slice(0, 10);

  const result = await generateSkillBody({
    candidate_id:    candidateRow.candidate_id,
    target_role:     candidateRow.target_role,
    rejection_count: candidateRow.rejection_count,
    reasons,
    headline:        candidateRow.headline,
  });

  // Persist result + status
  await withClient(async (c) => {
    if (result.ok && result.skill_body) {
      await c.query(
        `UPDATE skill_candidates_pg
            SET status='ready', proposed_skill_body=$2, proposed_at=now()
          WHERE candidate_id=$1`,
        [candidateId, result.skill_body],
      );
    } else {
      // Revert to pending on failure so operator can retry
      await c.query(
        `UPDATE skill_candidates_pg
            SET status='pending',
                review_notes = COALESCE(review_notes, '') ||
                               CASE WHEN review_notes IS NULL OR review_notes = '' THEN ''
                                    ELSE E'\\n---\\n' END ||
                               'Generation attempt failed at ' || now()::text || ': ' || $2
          WHERE candidate_id=$1`,
        [candidateId, (result.error ?? "unknown error").slice(0, 500)],
      );
    }
  });

  return result;
}
