/**
 * CliClaudeMutator (v0.18.1)
 * ==========================
 *
 * The mutator that doesn't need an Anthropic API key. It enqueues a task
 * for the dedicated `mutator` worker role; the actual LLM work happens
 * inside a Claude CLI agent window already running on the operator's
 * machine (auth via Pro plan login). The agent broadcasts results back
 * via the standard A2A channel; this mutator polls broadcasts for the
 * matching mutation_id and returns the candidates to runMutationCycle.
 *
 * FLOW:
 *   1. Generate a unique mutation_id
 *   2. enqueueTask({role: 'mutator', task_id: mutation_id, payload: {
 *        skill_id, parent_body, failure_traces, fixtures, acceptance_criteria,
 *      }})
 *   3. Dispatcher wake-nudge or active heartbeat picks up → mutator agent
 *      claims the task, generates 5 candidate bodies, broadcasts result
 *   4. We poll `recallSharedChannel` for a STATUS broadcast with
 *      state='mutation-result' and a summary containing mutation_id
 *   5. Parse the JSON candidates from the broadcast and return
 *
 * SECURITY:
 *   - Pre-submission scan still applies (RT-S2-07): we don't enqueue a
 *     payload that contains secrets in the prompt fields
 *   - The mutator agent's broadcast is part of the per-agent HMAC chain
 *     so a forged broadcast would break verifyChain
 *
 * COST (under Pro plan):
 *   - $0 dollars (Pro plan, no per-call charge)
 *   - Rate-limit-wise: ~1 mutator-agent message per cycle (Sonnet)
 *
 * TIMEOUT:
 *   - Default 5 min wait. If exceeded, throws CliMutatorTimeoutError.
 *     The orchestrator's cycle will record the mutation as failed-no-replay.
 */

import type { Mutator } from "../mutator.js";
import type { MutationContext, MutationResult, MutationCandidate } from "../types.js";
import { buildProposerPrompt, parseProposerResponse, preSubmissionSecretScan } from "../mutator.js";
import { randomUUID } from "node:crypto";

/** How long to wait for the mutator agent's broadcast response. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** How often to poll the broadcasts table while waiting. */
const POLL_INTERVAL_MS = 2_000;

export class CliMutatorTimeoutError extends Error {
  constructor(public mutation_id: string, public elapsed_ms: number) {
    super(`CliClaudeMutator: no broadcast for mutation_id=${mutation_id} within ${elapsed_ms}ms`);
    this.name = "CliMutatorTimeoutError";
  }
}

export interface CliClaudeMutatorOptions {
  /** Max wait for the mutator agent's response broadcast. Default 5 min. */
  timeout_ms?: number;
  /** Polling cadence while waiting. Default 2s. */
  poll_interval_ms?: number;
  /**
   * The project's path — used to resolve project_hash when enqueuing.
   * Required when the mutator is used in a non-MCP-server context (e.g. tests).
   */
  project_path: string;
  /**
   * Role to enqueue under. Defaults to 'mutator'. Lets operators run a
   * separate role pool (e.g. 'mutator-fast' on Sonnet vs 'mutator-deep'
   * on Opus) by configuring multiple agent windows.
   */
  role?: string;
}

/**
 * Helper extracted so tests can mock the broadcast channel without touching
 * the rest of the flow.
 */
export interface BroadcastSource {
  /**
   * Pull broadcasts since `sinceId`. Used by the polling loop to detect
   * the mutator agent's response. Returns rows newer than sinceId.
   */
  pollBroadcasts(sinceId: number, projectPath: string): Promise<Array<{ id: number; type: string; agent_id: string; state?: string; summary?: string }>>;
  /**
   * The "now" reference id — start polling from here.
   */
  currentMaxId(projectPath: string): Promise<number>;
}

/**
 * Default broadcast source — uses memory.ts's recallSharedChannel.
 * Kept lazy so the mutator can be imported without forcing memory.ts init.
 */
class MemoryBroadcastSource implements BroadcastSource {
  async pollBroadcasts(sinceId: number, projectPath: string) {
    const { recallSharedChannel } = await import("../../memory.js");
    const all = recallSharedChannel(projectPath, { limit: 100 });
    return all
      .filter((b) => b.id > sinceId)
      .map((b) => ({ id: b.id, type: b.type, agent_id: b.agent_id, state: b.state, summary: b.summary }));
  }
  async currentMaxId(projectPath: string): Promise<number> {
    const { recallSharedChannel } = await import("../../memory.js");
    const recent = recallSharedChannel(projectPath, { limit: 1 });
    return recent[0]?.id ?? 0;
  }
}

/**
 * Default enqueue path — uses task_queue.ts's enqueueTask. Lazy-imported.
 */
async function defaultEnqueueTask(payload: { taskId: string; projectPath: string; role: string; payload: Record<string, unknown> }): Promise<boolean> {
  const { enqueueTask } = await import("../../task_queue.js");
  const { createHash } = await import("node:crypto");
  const projectHash = createHash("sha256").update(payload.projectPath).digest("hex").slice(0, 16);
  return enqueueTask({
    taskId: payload.taskId,
    projectHash,
    role: payload.role,
    payload: payload.payload,
  });
}

export class CliClaudeMutator implements Mutator {
  readonly id = "cli-claude";

  // Tunables (kept public so the orchestrator / tests can inject)
  public timeoutMs: number;
  public pollIntervalMs: number;
  public projectPath: string;
  public role: string;
  public broadcastSource: BroadcastSource;
  public enqueueFn: (payload: { taskId: string; projectPath: string; role: string; payload: Record<string, unknown> }) => Promise<boolean>;

  constructor(options: CliClaudeMutatorOptions, deps: {
    broadcastSource?: BroadcastSource;
    enqueueFn?: typeof defaultEnqueueTask;
  } = {}) {
    this.timeoutMs       = options.timeout_ms       ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs  = options.poll_interval_ms ?? POLL_INTERVAL_MS;
    this.projectPath     = options.project_path;
    this.role            = options.role             ?? "mutator";
    this.broadcastSource = deps.broadcastSource     ?? new MemoryBroadcastSource();
    this.enqueueFn       = deps.enqueueFn           ?? defaultEnqueueTask;
  }

  async mutate(ctx: MutationContext): Promise<MutationResult> {
    const mutationId = `mut-${randomUUID().slice(0, 12)}`;

    // 1. Pre-submission scan — RT-S2-07 (don't put secrets into the
    //    payload that the mutator agent will read into its prompt).
    const promptSnapshot = buildProposerPrompt(ctx);
    const scan = await preSubmissionSecretScan(promptSnapshot);
    if (scan.matched) {
      throw new Error(`CliClaudeMutator: pre-submission scan rejected (matched: ${scan.reason})`);
    }

    // 2. Capture the broadcast watermark BEFORE enqueuing so we don't
    //    accidentally pick up an unrelated prior broadcast.
    const sinceId = await this.broadcastSource.currentMaxId(this.projectPath);

    // 3. Enqueue the task. The mutator agent's prompt knows to claim
    //    role='mutator' tasks; it parses the payload and builds a prompt.
    const inserted = await this.enqueueFn({
      taskId: mutationId,
      projectPath: this.projectPath,
      role: this.role,
      payload: {
        kind:               "skill-mutation",
        mutation_id:        mutationId,
        skill_id:           ctx.parent.skill_id,
        skill_name:         ctx.parent.frontmatter.name,
        parent_body:        ctx.parent.body,
        failure_traces:     ctx.failure_traces.slice(0, 10),
        fixtures:           (ctx.parent.frontmatter.fixtures ?? []).slice(0, 5),
        acceptance_criteria: ctx.parent.frontmatter.acceptance_criteria ?? null,
        instructions:       this._instructionsForAgent(mutationId),
      },
    });
    if (!inserted) {
      throw new Error(`CliClaudeMutator: enqueue returned false for ${mutationId} (already queued?)`);
    }

    // 4. Poll for the mutator agent's response broadcast
    const result = await this._waitForResponse(mutationId, sinceId);

    return {
      candidates:        result.candidates,
      proposer_model:    result.proposer_model ?? "cli-claude-sonnet",
      proposer_cost_usd: 0,  // Pro plan
      judge_pick_index:  this._pickBestByScore(result.candidates),
      judge_model:       result.proposer_model ?? "cli-claude-sonnet",
      judge_rationale:   "self-rated by proposer; orchestrator re-replays for ground truth",
      total_cost_usd:    0,
    };
  }

  private _instructionsForAgent(mutationId: string): string {
    return [
      "You are processing a SKILL MUTATION request.",
      "Generate 5 candidate skill bodies that fix the failure patterns.",
      "Each candidate is a FULL replacement for the parent body (markdown only — NO frontmatter).",
      "",
      "STEP 1 — persist via the side-channel (option-b architecture):",
      `  zc_record_mutation_result({`,
      `    mutation_id: "${mutationId}",`,
      `    skill_id: <skill_id from payload>,`,
      `    proposer_model: "claude-sonnet-4-6",`,
      `    proposer_role: "mutator",`,
      `    bodies: [`,
      `      { candidate_body: "...full markdown body, ANY size...", rationale: "...", self_rated_score: 0.0-1.0 },`,
      `      ... 5 total ...`,
      `    ]`,
      `  })`,
      "  → returns {result_id, bodies_hash, headline}.",
      "",
      "STEP 2 — broadcast pointer ONLY (no inline bodies — they live in the side-channel):",
      `  zc_broadcast({`,
      `    type: "STATUS", state: "mutation-result", agent_id: <your agent_id>,`,
      `    summary: JSON.stringify({`,
      `      mutation_id: "${mutationId}",`,
      `      result_id:   <from STEP 1>,`,
      `      bodies_hash: <from STEP 1>,`,
      `      headline:    <from STEP 1>,`,
      `      proposer_model: "claude-sonnet-4-6"`,
      `    })`,
      `  })`,
      "",
      "STEP 3 — call zc_complete_task and loop.",
    ].join("\n");
  }

  private async _waitForResponse(mutationId: string, sinceId: number): Promise<{ candidates: MutationCandidate[]; proposer_model?: string }> {
    const startedAt = Date.now();
    let cursor = sinceId;
    while (Date.now() - startedAt < this.timeoutMs) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      const fresh = await this.broadcastSource.pollBroadcasts(cursor, this.projectPath);
      if (fresh.length === 0) continue;
      // Advance cursor regardless so we don't re-scan the same rows
      cursor = Math.max(cursor, ...fresh.map((b) => b.id));
      // Look for a STATUS broadcast with state='mutation-result' and a
      // summary containing OUR mutation_id (multiple mutations can be in
      // flight — ours is identified by the JSON summary).
      for (const b of fresh) {
        if (b.type !== "STATUS") continue;
        if ((b.state ?? "").toLowerCase() !== "mutation-result") continue;
        if (!b.summary) continue;
        let parsed: {
          mutation_id?: string;
          // Option-b (side-channel pointer)
          result_id?: string;
          bodies_hash?: string;
          // Legacy inline format (backward compat)
          candidates?: unknown;
          proposer_model?: string;
        };
        try { parsed = JSON.parse(b.summary); } catch { continue; }
        if (parsed.mutation_id !== mutationId) continue;

        // ── Option-b: pointer-style summary ─────────────────────────────────
        // The bodies live in the mutation_results side-channel. Fetch + verify.
        if (parsed.result_id && parsed.bodies_hash) {
          const { fetchMutationResult } = await import("../mutation_results.js");
          const { DatabaseSync } = await import("node:sqlite");
          const { mkdirSync } = await import("node:fs");
          const { join } = await import("node:path");
          const { homedir } = await import("node:os");
          const { createHash } = await import("node:crypto");
          const dbDir = join(homedir(), ".claude", "zc-ctx", "sessions");
          mkdirSync(dbDir, { recursive: true });
          const projectHash = createHash("sha256").update(this.projectPath).digest("hex").slice(0, 16);
          const dbFile = join(dbDir, `${projectHash}.db`);
          const db = new DatabaseSync(dbFile);
          db.exec("PRAGMA journal_mode = WAL");
          try {
            const row = await fetchMutationResult(db, mutationId, { expectedHash: parsed.bodies_hash });
            if (!row) {
              throw new Error(`CliClaudeMutator: side-channel fetch failed for ${mutationId} (hash mismatch or row missing — broadcast pointer says bodies_hash=${parsed.bodies_hash})`);
            }
            if (row.bodies.length === 0) {
              throw new Error(`CliClaudeMutator: side-channel row for ${mutationId} had 0 candidates`);
            }
            return {
              candidates: row.bodies.map((c) => ({
                candidate_body: c.candidate_body,
                rationale: c.rationale,
                self_rated_score: typeof c.self_rated_score === "number" ? c.self_rated_score : undefined,
              })),
              proposer_model: row.proposer_model ?? parsed.proposer_model,
            };
          } finally {
            db.close();
          }
        }

        // ── Legacy: inline candidates in summary ────────────────────────────
        // Kept for backward compat with v0.18.0 mutator agents that broadcast
        // the bodies inline. Subject to the 1000-char summary cap (truncation
        // hazard) — option-b above is preferred.
        if (!Array.isArray(parsed.candidates)) {
          throw new Error(`CliClaudeMutator: response for ${mutationId} has neither side-channel pointer nor inline candidates`);
        }
        const candidates = parsed.candidates
          .filter((c): c is { candidate_body: string; rationale: string; self_rated_score?: number } =>
            !!c && typeof (c as { candidate_body?: unknown }).candidate_body === "string"
                && typeof (c as { rationale?: unknown }).rationale === "string"
          )
          .map((c) => ({
            candidate_body:    c.candidate_body,
            rationale:         c.rationale,
            self_rated_score:  typeof c.self_rated_score === "number" ? c.self_rated_score : undefined,
          }));
        if (candidates.length === 0) {
          throw new Error(`CliClaudeMutator: response for ${mutationId} had 0 valid candidates`);
        }
        return { candidates, proposer_model: parsed.proposer_model };
      }
    }
    // Backup: parseProposerResponse helper isn't used here because the
    // mutator agent's wrapper format differs from raw API output. But we
    // KEEP the import so its tests don't break and operators can extend.
    void parseProposerResponse;
    throw new CliMutatorTimeoutError(mutationId, Date.now() - startedAt);
  }

  private _pickBestByScore(cs: MutationCandidate[]): number {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < cs.length; i++) {
      const s = cs[i].self_rated_score ?? 0;
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    return bestIdx;
  }
}
