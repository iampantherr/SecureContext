/**
 * TKG-T3 (v0.47.0) — LOCAL-LLM PAIR ADJUDICATOR.
 *
 * The invalidation loop's escalation step: given two memory facts the
 * algorithmic pass could not classify (no same-key supersession, ambiguous
 * cosine+conflict signals), ask a local model for a CONSTRAINED judgment:
 * contradiction | update | compatible.
 *
 * Model choice is evidence-based (bench/t3/, 52-case gold set, 2026-07-18):
 * qwen2.5-coder:14b was the only candidate with ZERO false contradictions,
 * 5/5 true-contradiction recall, and the best safe update-recall. Two design
 * rules follow directly from that data:
 *   1. The model CLASSIFIES; it never picks the surviving side (current-side
 *      accuracy topped out ~40% across all six candidates) — RECENCY picks the
 *      winner, mirroring Graphiti's "new information wins" policy.
 *   2. "contradiction" verdicts NEVER auto-invalidate — they open operator
 *      triage. Only "update" verdicts drive automatic invalidation.
 * Ollama structured output (format: <json schema>) constrains decoding, which
 * neutralizes the small-model JSON-conformance failure mode Zep warns about.
 *
 * ZC_LLM_ADJUDICATE=0 disables; ZC_LLM_ADJUDICATE_MODEL overrides the model.
 * Fails null on ANY error — callers fall back to open-triage behavior.
 */
import { Config } from "./config.js";

export interface AdjudicationVerdict {
  verdict: "contradiction" | "update" | "compatible";
}

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["contradiction", "update", "compatible"] },
    current: { type: "string", enum: ["a", "b", "none"] },
    reason: { type: "string" },
  },
  required: ["verdict", "current", "reason"],
};

export function adjudicatorEnabled(): boolean {
  return process.env["ZC_LLM_ADJUDICATE"] !== "0";
}

function chatUrl(): string {
  return Config.OLLAMA_URL.replace(/\/api\/embeddings\/?$/, "/api/chat");
}

function adjudicatorModel(): string {
  return process.env["ZC_LLM_ADJUDICATE_MODEL"] ?? "qwen2.5-coder:14b";
}

export async function adjudicatePair(
  a: { key: string; value: string },
  b: { key: string; value: string },
): Promise<AdjudicationVerdict | null> {
  if (!adjudicatorEnabled()) return null;
  const prompt = `You maintain an AI agent team's project memory. Two stored facts follow. Decide their relationship:
- "contradiction": they make incompatible claims about the SAME thing and the text gives no way to tell which is the current truth.
- "update": they concern the same thing and one clearly SUPERSEDES the other (newer decision, revised value, later state).
- "compatible": they can both be true (different topics, different scopes/environments, sequential progress reports, a status and a later status of DIFFERENT work).

Facts are work-journal entries from a software project; sequential progress on the same effort is compatible, not contradictory.

FACT A (key: ${a.key}):
${a.value.slice(0, 700)}

FACT B (key: ${b.key}):
${b.value.slice(0, 700)}

Answer with JSON only: {"verdict": "contradiction"|"update"|"compatible", "current": "a"|"b"|"none", "reason": "<one sentence>"}`;

  try {
    const resp = await fetch(chatUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: adjudicatorModel(),
        messages: [{ role: "user", content: prompt }],
        stream: false,
        format: SCHEMA,
        options: { temperature: 0, num_predict: 200 },
      }),
      signal: AbortSignal.timeout(parseInt(process.env["ZC_LLM_ADJUDICATE_TIMEOUT_MS"] ?? "45000", 10) || 45_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { message?: { content?: string } };
    const text = (data.message?.content ?? "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]) as { verdict?: string };
    if (j.verdict === "contradiction" || j.verdict === "update" || j.verdict === "compatible") {
      return { verdict: j.verdict };
    }
    return null;
  } catch {
    return null; // model down / timeout / bad output — caller falls back to triage
  }
}
