/**
 * RealtimeSonnetMutator (v0.18.0)
 * ================================
 *
 * Calls Anthropic's Messages API directly with claude-sonnet-4-6 to
 * generate 5 mutation candidates synchronously. Used for ad-hoc /
 * on-demand mutations where 24h batch SLA is too slow.
 *
 * AUTH:
 *   - Uses ANTHROPIC_API_KEY env var. If absent, throws — orchestrator
 *     should catch + degrade to LocalMockMutator.
 *
 * SECURITY:
 *   - Pre-submission secret_scanner via mutator.ts helper.
 *   - Response is JSON-parsed via parseProposerResponse — malformed
 *     output throws.
 *
 * COST: ~$0.024 per mutate call (3k in + 1k out × Sonnet pricing).
 *
 * NOTE: This module imports `node:https` lazily so it can be loaded in
 * environments without network and tested with the request builder
 * isolated from actual fetches.
 */

import type { Mutator } from "../mutator.js";
import type { MutationContext, MutationResult } from "../types.js";
import { buildProposerPrompt, parseProposerResponse, preSubmissionSecretScan } from "../mutator.js";

const ANTHROPIC_MODEL  = "claude-sonnet-4-6";
const ANTHROPIC_URL    = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const TIMEOUT_MS = 60_000;

export class RealtimeSonnetMutator implements Mutator {
  readonly id = "realtime-sonnet";

  async mutate(ctx: MutationContext): Promise<MutationResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("RealtimeSonnetMutator: ANTHROPIC_API_KEY not set");
    }

    const prompt = buildProposerPrompt(ctx);
    const scan = await preSubmissionSecretScan(prompt);
    if (scan.matched) {
      throw new Error(`RealtimeSonnetMutator: pre-submission scan rejected (matched: ${scan.reason})`);
    }

    const body = JSON.stringify({
      model:       ANTHROPIC_MODEL,
      max_tokens:  4096,
      messages:    [{ role: "user", content: prompt }],
      temperature: 0.7,
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(ANTHROPIC_URL, {
        method:  "POST",
        headers: {
          "x-api-key":         apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type":      "application/json",
        },
        body,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "<no body>");
      throw new Error(`RealtimeSonnetMutator: API ${response.status} — ${errText.slice(0, 500)}`);
    }

    const respJson = await response.json() as {
      content: Array<{ type: string; text?: string }>;
      usage:   { input_tokens: number; output_tokens: number };
      model:   string;
    };

    // Concatenate any text blocks
    const textBlocks = (respJson.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    if (!textBlocks) throw new Error("RealtimeSonnetMutator: no text in API response");

    const candidates = parseProposerResponse(textBlocks);

    // Cost: per Tier 1 pricing — input × output_rate (LLM emitted args) +
    // output × input_rate (LLM ingest on next turn). For the proposer call
    // we treat the input as actual input (the user prompt) at input rate
    // and the output as output. (Different from MCP-tool-call accounting.)
    const SONNET_INPUT_PER_MTOK  = 3;
    const SONNET_OUTPUT_PER_MTOK = 15;
    const cost = (respJson.usage.input_tokens / 1_000_000) * SONNET_INPUT_PER_MTOK
               + (respJson.usage.output_tokens / 1_000_000) * SONNET_OUTPUT_PER_MTOK;

    // Self-judge: ask the model which one it picked first (it's already there
    // in the candidate self-ratings if it included them). Fall back to
    // first-candidate if self-rating absent.
    const judgePickIndex = pickBestByScore(candidates);

    return {
      candidates,
      proposer_model:    respJson.model,
      proposer_cost_usd: cost,
      judge_pick_index:  judgePickIndex,
      judge_model:       respJson.model,
      judge_rationale:   "Picked highest self_rated_score (or first candidate if none rated).",
      total_cost_usd:    cost,
    };
  }
}

function pickBestByScore(cs: Array<{ self_rated_score?: number }>): number {
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < cs.length; i++) {
    const s = cs[i].self_rated_score ?? 0;
    if (s > bestScore) { bestScore = s; bestIdx = i; }
  }
  return bestIdx;
}
