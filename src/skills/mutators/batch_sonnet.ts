/**
 * BatchSonnetMutator (v0.18.0)
 * =============================
 *
 * Submits the proposer prompt to Anthropic's Message Batches API for the
 * 50% discount + 24h SLA. The orchestrator's nightly cron scaffold uses
 * this for unattended overnight mutation rounds.
 *
 * Lifecycle (per Anthropic docs):
 *   1. POST /v1/messages/batches with custom_id + request body
 *   2. Poll GET /v1/messages/batches/{id} until processing_status == "ended"
 *   3. GET /v1/messages/batches/{id}/results — JSONL, one line per request
 *
 * To keep this simple for v0.18.0 we model `mutate()` as ONE-CALL:
 *   - submit a single-request batch
 *   - poll until done (with backoff)
 *   - parse the result
 *
 * For real nightly use, the cron loop should batch ALL skills' mutation
 * requests into ONE submission — but that's a Phase F scaffolding concern,
 * not the mutator's. The mutator stays one-skill-per-call.
 *
 * If the batch hasn't completed within MAX_WAIT_MS, the mutator throws
 * BatchTimeoutError so the caller can decide whether to retry or fall back.
 *
 * SECURITY: same pre-submission secret_scan as realtime mutator.
 *
 * COST: ~$0.012 per mutate (50% of realtime).
 */

import type { Mutator } from "../mutator.js";
import type { MutationContext, MutationResult } from "../types.js";
import { buildProposerPrompt, parseProposerResponse, preSubmissionSecretScan } from "../mutator.js";
import { randomUUID } from "node:crypto";

const ANTHROPIC_MODEL    = "claude-sonnet-4-6";
const BATCH_BASE_URL     = "https://api.anthropic.com/v1/messages/batches";
const ANTHROPIC_VERSION  = "2023-06-01";
const MAX_WAIT_MS        = 24 * 60 * 60 * 1000;  // 24 hours per Anthropic SLA
const POLL_INTERVAL_MS   = 60 * 1000;            // 1 min — runners override

export class BatchTimeoutError extends Error {
  constructor(public batch_id: string, public elapsed_ms: number) {
    super(`Batch ${batch_id} did not complete within ${elapsed_ms}ms`);
    this.name = "BatchTimeoutError";
  }
}

export class BatchSonnetMutator implements Mutator {
  readonly id = "batch-sonnet";
  // Tunables exposed for tests / runners
  public maxWaitMs:      number = MAX_WAIT_MS;
  public pollIntervalMs: number = POLL_INTERVAL_MS;

  async mutate(ctx: MutationContext): Promise<MutationResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("BatchSonnetMutator: ANTHROPIC_API_KEY not set");

    const prompt = buildProposerPrompt(ctx);
    const scan = await preSubmissionSecretScan(prompt);
    if (scan.matched) {
      throw new Error(`BatchSonnetMutator: pre-submission scan rejected (matched: ${scan.reason})`);
    }

    const customId = `mut-${ctx.parent.skill_id}-${randomUUID().slice(0, 8)}`;
    const submitBody = JSON.stringify({
      requests: [{
        custom_id: customId,
        params: {
          model:       ANTHROPIC_MODEL,
          max_tokens:  4096,
          messages:    [{ role: "user", content: prompt }],
          temperature: 0.7,
        },
      }],
    });

    // 1. Submit
    const submitResp = await fetch(BATCH_BASE_URL, {
      method:  "POST",
      headers: this._headers(apiKey),
      body:    submitBody,
    });
    if (!submitResp.ok) {
      throw new Error(`BatchSonnetMutator: submit failed ${submitResp.status} — ${await submitResp.text().catch(() => "")}`);
    }
    const submitJson = await submitResp.json() as { id: string };
    const batchId = submitJson.id;

    // 2. Poll
    const startedAt = Date.now();
    while (true) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      const elapsed = Date.now() - startedAt;
      if (elapsed > this.maxWaitMs) throw new BatchTimeoutError(batchId, elapsed);

      const statusResp = await fetch(`${BATCH_BASE_URL}/${batchId}`, { headers: this._headers(apiKey) });
      if (!statusResp.ok) continue;
      const statusJson = await statusResp.json() as { processing_status: string; results_url?: string };
      if (statusJson.processing_status === "ended") break;
    }

    // 3. Retrieve
    const resultsResp = await fetch(`${BATCH_BASE_URL}/${batchId}/results`, { headers: this._headers(apiKey) });
    if (!resultsResp.ok) {
      throw new Error(`BatchSonnetMutator: results fetch ${resultsResp.status}`);
    }
    const text = await resultsResp.text();
    // JSONL — one line per request. We submitted exactly one.
    const line = text.split("\n").find((l) => l.trim().length > 0);
    if (!line) throw new Error("BatchSonnetMutator: empty results");
    const parsedLine = JSON.parse(line) as {
      custom_id: string;
      result: { type: string; message?: { content: Array<{ type: string; text?: string }>; usage: { input_tokens: number; output_tokens: number }; model: string }; error?: { message: string } };
    };
    if (parsedLine.result.type !== "succeeded" || !parsedLine.result.message) {
      throw new Error(`BatchSonnetMutator: result error — ${parsedLine.result.error?.message ?? "unknown"}`);
    }
    const message = parsedLine.result.message;
    const textBlocks = (message.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    if (!textBlocks) throw new Error("BatchSonnetMutator: no text in result");

    const candidates = parseProposerResponse(textBlocks);

    // Cost: 50% of realtime
    const SONNET_INPUT_PER_MTOK  = 3 * 0.5;
    const SONNET_OUTPUT_PER_MTOK = 15 * 0.5;
    const cost = (message.usage.input_tokens / 1_000_000) * SONNET_INPUT_PER_MTOK
               + (message.usage.output_tokens / 1_000_000) * SONNET_OUTPUT_PER_MTOK;

    return {
      candidates,
      proposer_model:    message.model,
      proposer_cost_usd: cost,
      judge_pick_index:  pickBestByScore(candidates),
      judge_model:       message.model,
      judge_rationale:   "Picked highest self_rated_score (batch path).",
      total_cost_usd:    cost,
    };
  }

  private _headers(apiKey: string): Record<string, string> {
    return {
      "x-api-key":         apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type":      "application/json",
    };
  }
}

function pickBestByScore(cs: Array<{ self_rated_score?: number }>): number {
  let bestIdx = 0;
  let best = -Infinity;
  for (let i = 0; i < cs.length; i++) {
    const s = cs[i].self_rated_score ?? 0;
    if (s > best) { best = s; bestIdx = i; }
  }
  return bestIdx;
}
