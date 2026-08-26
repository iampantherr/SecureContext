/**
 * Mutation orchestrator (v0.18.0 Sprint 2)
 * =========================================
 *
 * The full skill→mutate→replay→promote cycle. Stitches together every other
 * Sprint 2 module:
 *
 *   1. select underperforming skills (bottom by recent avg outcome_score)
 *   2. for each: invoke the configured mutator → 5 candidates
 *   3. verify candidate HMACs match (RT-S2-09)
 *   4. replay each candidate against fixtures
 *   5. compare candidate vs parent — pick the best
 *   6. apply scoring.shouldPromote — decision boundary
 *   7. on promote: archive parent, insert new skill version (atomic)
 *   8. record EVERYTHING into skill_mutations + skill_runs for audit
 *
 * Designed for both the nightly cron path (BatchSonnetMutator) AND ad-hoc
 * runs (`zc_propose_mutation` MCP tool with realtime-sonnet or local-mock).
 *
 * SAFETY:
 *   - The orchestrator never overwrites a skill silently. Promotions create
 *     a new (name, scope, version) row; the prior row is soft-archived.
 *   - All mutations are logged to skill_mutations regardless of outcome.
 *   - On any error mid-cycle, partial state is cleaned up + the cycle is
 *     marked as a no-op (caller sees `promoted=false, reason='error: ...'`).
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  Skill, SkillRun, SkillMutation, MutationContext, MutationCycleResult,
  AcceptanceCriteria,
} from "./types.js";
// v0.18.0 — use the dual-backend dispatch so promotions land in PG too
// (when ZC_TELEMETRY_BACKEND=postgres|dual). Falls through to SQLite otherwise.
import {
  upsertSkill, archiveSkill, getRecentSkillRuns, recordMutation, resolveMutation,
  getActiveSkill, listActiveSkills, getExemplarRuns,
} from "./storage_dual.js";
import {
  candidateToSkill, getMutator, type Mutator,
} from "./mutator.js";
import {
  replaySkill, compareReplays, type SkillExecutor, LocalDeterministicExecutor,
} from "./replay.js";
import { aggregateScore, shouldPromote } from "./scoring.js";
import { computeSkillBodyHmac, verifySkillHmac } from "./loader.js";
import { randomUUID } from "node:crypto";

/** Top-level options for one mutation cycle. */
export interface MutationCycleOptions {
  /** Mutator to use; if absent, resolves from ZC_MUTATOR_MODEL env. */
  mutator?:    Mutator;
  /** Executor for replay; if absent, LocalDeterministicExecutor (test/L1 path). */
  executor?:   SkillExecutor;
  /** How many recent skill_runs to consider for parent baseline. */
  parent_runs_window?: number;
  /** Override acceptance_criteria (default: from skill.frontmatter). */
  acceptance?: AcceptanceCriteria;
  /**
   * Project path used for project_hash on PG mirror writes (skill_runs_pg /
   * skill_mutations_pg). Defaults to "default" if absent — the SQLite-only
   * code path doesn't need it, but PG dual-write does.
   */
  projectPath?: string;
}

/**
 * Run one full mutation cycle for a given skill_id. Returns the cycle result
 * (always — even on no-promote / error paths). Records EVERY candidate as a
 * skill_mutations row regardless of promotion.
 */
export async function runMutationCycle(
  db: DatabaseSync,
  parent: Skill,
  options: MutationCycleOptions = {},
): Promise<MutationCycleResult> {
  const startedAt = Date.now();

  // Candidates are scored ONLY by fixture replay (they have no run history).
  // Without fixtures every candidate scores 0.000, which reads as "all the
  // candidates were terrible" — a fabricated zero (live E2E 2026-08-04).
  // Say the true thing and skip the mutator's LLM cost entirely.
  if ((parent.frontmatter.fixtures ?? []).length === 0) {
    return {
      skill_id: parent.skill_id, baseline_score: 0, candidates_count: 0,
      best_candidate_score: 0, promoted: false, total_cost_usd: 0,
      duration_ms: Date.now() - startedAt,
      reason: "no fixtures defined in frontmatter — candidates cannot be evaluated; add `fixtures:` to the skill before proposing mutations",
    };
  }

  const mutator   = options.mutator  ?? await getMutator();
  const executor  = options.executor ?? new LocalDeterministicExecutor();

  // Compute parent baseline — agg of recent runs OR replay-against-fixtures
  // if no recent runs exist.
  const recentRuns = await getRecentSkillRuns(db, parent.skill_id, options.parent_runs_window ?? 20);
  let parentBaselineAgg;
  if (recentRuns.length === 0) {
    // Cold start: replay fixtures to seed a baseline
    const replay = await replaySkill(parent, executor);
    parentBaselineAgg = {
      avg_score:       replay.agg_score,
      pass_rate:       replay.pass_rate,
      avg_cost_usd:    replay.avg_cost_usd,
      avg_duration_ms: replay.avg_duration_ms,
      n:               replay.per_fixture.length,
    };
  } else {
    parentBaselineAgg = aggregateScore(recentRuns);
  }
  const baseline_score = parentBaselineAgg.avg_score;

  // v0.23.0 Phase 1 F — fetch operator-tagged exemplars (PG-only, returns [] if PG unavailable).
  const exemplars = await getExemplarRuns(parent.skill_id, 5);

  // Step 1: invoke mutator
  const ctx: MutationContext = {
    parent,
    recent_runs:    recentRuns,
    failure_traces: recentRuns.filter((r) => r.failure_trace).map((r) => r.failure_trace as string),
    fixtures:       parent.frontmatter.fixtures ?? [],
    exemplars,
  };

  let mutResult;
  try {
    mutResult = await mutator.mutate(ctx);
  } catch (e) {
    // Mutator failed — record nothing (no candidates produced) but return result
    return {
      skill_id:           parent.skill_id,
      baseline_score,
      candidates_count:   0,
      best_candidate_score: 0,
      promoted:           false,
      total_cost_usd:     0,
      duration_ms:        Date.now() - startedAt,
      reason:             `mutator error: ${(e as Error).message}`,
    };
  }

  // Step 1.5 (v0.60.0 M2): INDEPENDENT judge. Historically judge_score was
  // the proposer's self-rating — a self-graded gate. judgeCandidates() makes a
  // separate model call (never sees self-ratings, instructed to reject
  // overfit/special-casing) and falls back to labeled self-ratings only when
  // no real judge is configured. Never throws.
  const { judgeCandidates } = await import("./judge.js");
  const judgeResult = await judgeCandidates(ctx, mutResult.candidates);

  // Step 2: verify candidate HMACs (RT-S2-09 — defense against bytes-modified
  // between proposal and replay). We compute the HMAC ourselves so the
  // candidate provenance is traceable.
  const acceptance = options.acceptance ?? parent.frontmatter.acceptance_criteria;

  // Step 3: for each candidate, build a Skill, replay against fixtures,
  // record skill_mutations row.
  let bestCandidate:        Awaited<ReturnType<typeof candidateToSkill>> | null = null;
  let bestCandidateAgg:     ReturnType<typeof aggregateScore> | null = null;
  let bestCandidateHmac:    string | null = null;
  let bestCandidateMutationId: string | null = null;
  let bestCandidateIndex:   number = -1;

  for (let i = 0; i < mutResult.candidates.length; i++) {
    const c = mutResult.candidates[i];
    const candidateHmac = await computeSkillBodyHmac(c.candidate_body);
    const mutationId = `mut-${randomUUID().slice(0, 12)}`;
    const candidateSkill = await candidateToSkill(parent, c);

    const mutationRow: SkillMutation = {
      mutation_id:     mutationId,
      parent_skill_id: parent.skill_id,
      candidate_body:  c.candidate_body,
      candidate_hmac:  candidateHmac,
      proposed_by:     mutResult.proposer_model,
      judged_by:       judgeResult.judged_by,
      judge_score:     judgeResult.verdicts[i]?.score ?? null,
      judge_rationale: (judgeResult.verdicts[i]?.overfit ? "[OVERFIT] " : "") + (judgeResult.verdicts[i]?.rationale ?? c.rationale),
      replay_score:    null,
      promoted:        false,
      promoted_to_skill_id: null,
      created_at:      new Date().toISOString(),
      resolved_at:     null,
    };
    await recordMutation(db, mutationRow, options.projectPath ?? "default");

    // Re-verify before replay — RT-S2-09 (corruption between propose+replay)
    if (!await verifySkillHmac(candidateSkill.body, candidateSkill.body_hmac)) {
      await resolveMutation(db, mutationId, { replay_score: 0, judge_rationale: "HMAC mismatch — replay refused (RT-S2-09)" });
      continue;
    }

    const replay = await replaySkill(candidateSkill, executor);
    const candAgg = {
      avg_score:       replay.agg_score,
      pass_rate:       replay.pass_rate,
      avg_cost_usd:    replay.avg_cost_usd,
      avg_duration_ms: replay.avg_duration_ms,
      n:               replay.per_fixture.length,
    };
    await resolveMutation(db, mutationId, { replay_score: candAgg.avg_score });

    // v0.60.0 M2 — an overfit verdict makes a candidate PERMANENTLY
    // non-promotable, whatever its replay score: memorizing the failing case
    // can ace a fixture set while fixing nothing (the operator's anti-Goodhart
    // rule). The row is still recorded above, tagged [OVERFIT], for audit.
    if (judgeResult.verdicts[i]?.overfit) continue;
    if (bestCandidateAgg === null || candAgg.avg_score > bestCandidateAgg.avg_score) {
      bestCandidate            = candidateSkill;
      bestCandidateAgg         = candAgg;
      bestCandidateHmac        = candidateHmac;
      bestCandidateMutationId  = mutationId;
      bestCandidateIndex       = i;
    }
  }

  if (bestCandidate === null || bestCandidateAgg === null) {
    return {
      skill_id:           parent.skill_id,
      baseline_score,
      candidates_count:   mutResult.candidates.length,
      best_candidate_score: 0,
      promoted:           false,
      total_cost_usd:     mutResult.total_cost_usd,
      duration_ms:        Date.now() - startedAt,
      reason:             "no candidate replayed successfully",
    };
  }

  // Step 4: promotion decision
  const promoteDecision = shouldPromote(bestCandidateAgg, parentBaselineAgg, acceptance);

  const promoted = false;   // v0.60.0 — the cycle NEVER applies; the operator does.
  let promotionError: string | null = null;
  let pending_result_id: string | undefined;
  const new_skill_id: string | undefined = undefined;
  const archived_skill_id: string | undefined = undefined;

  if (promoteDecision.promote && bestCandidateMutationId && bestCandidateIndex >= 0) {
    // v0.60.0 (operator decision 2026-08-25) — promote-worthy results are
    // ROUTED THROUGH THE OPERATOR APPROVAL QUEUE, never auto-applied. The
    // previous archive+upsert here (a) violated inform-don't-destroy and
    // (b) tore across backends on failure: on the engine's FIRST real cycle
    // the PG archive survived the SQLite ROLLBACK and un-listed a live skill.
    // zc_mutation_pending lists this result; zc_mutation_approve writes the
    // FILE and re-admits (the only apply path that keeps HMACs honest).
    try {
      const { recordMutationResult } = await import("./mutation_results.js");
      const { projectHash: hashProject } = await import("../store.js");
      // Candidates ordered winner-first, overfit-flagged ones excluded; judge
      // scores ride self_rated_score so the queue's best_score reflects the
      // INDEPENDENT judge, not the proposer grading itself.
      const eligible = mutResult.candidates
        .map((c, i) => ({ c, i }))
        .filter(({ i }) => !judgeResult.verdicts[i]?.overfit)
        .sort((a, b) => (a.i === bestCandidateIndex ? -1 : b.i === bestCandidateIndex ? 1 : 0))
        .map(({ c, i }) => ({ ...c, self_rated_score: judgeResult.verdicts[i]?.score ?? c.self_rated_score }));
      const ptr = await recordMutationResult(db, {
        mutation_id:    bestCandidateMutationId,
        skill_id:       parent.skill_id,
        project_hash:   hashProject(options.projectPath ?? "default"),
        proposer_model: mutResult.proposer_model,
        bodies:         eligible,
        headline:
          `promote-worthy (${promoteDecision.reason}) — judge(${judgeResult.judged_by}) best ` +
          `${(judgeResult.verdicts[bestCandidateIndex]?.score ?? 0).toFixed(2)}, replay ${bestCandidateAgg?.avg_score.toFixed(2)} vs baseline ${baseline_score.toFixed(2)}`,
      });
      pending_result_id = ptr.result_id;
    } catch (e) {
      promotionError = (e as Error).message;
    }
  }

  // Use the candidate HMAC if needed (silence linter); also avoids dropping
  // the variable in case future code wants to write it to a sidecar table.
  void bestCandidateHmac;

  return {
    skill_id:           parent.skill_id,
    baseline_score,
    candidates_count:   mutResult.candidates.length,
    best_candidate_score: bestCandidateAgg.avg_score,
    promoted,
    new_skill_id,
    archived_skill_id,
    pending_result_id,
    total_cost_usd:     mutResult.total_cost_usd,
    duration_ms:        Date.now() - startedAt,
    reason:             promotionError
      ? `promote-worthy ('${promoteDecision.reason}') but QUEUEING FAILED: ${promotionError}`
      : pending_result_id
        ? `promote-worthy (${promoteDecision.reason}) — QUEUED FOR OPERATOR APPROVAL: ${pending_result_id}`
        : promoteDecision.reason,
  };
}

/**
 * Select the bottom-N skills by recent avg outcome_score for nightly cron.
 * Skills with no recent runs are included at the front (cold start need
 * exploration too).
 */
export async function selectUnderperformingSkills(
  db: DatabaseSync,
  skills: Skill[],
  topN = 3,
  recencyWindow = 20,
): Promise<Skill[]> {
  const scored = await Promise.all(skills.map(async (s) => {
    const runs = await getRecentSkillRuns(db, s.skill_id, recencyWindow);
    const avg = runs.length === 0 ? 0 : aggregateScore(runs).avg_score;
    return { skill: s, avg };
  }));
  // Lowest first; cold-start skills (avg=0) bubble up
  scored.sort((a, b) => a.avg - b.avg);
  return scored.slice(0, topN).map((s) => s.skill);
}

/**
 * Run a full nightly cycle across all active skills:
 *   - select bottom-3
 *   - run mutation cycle on each
 *   - return summary
 */
export async function runNightlyCycle(
  db: DatabaseSync,
  options: MutationCycleOptions & { topN?: number } = {},
): Promise<{ cycles: MutationCycleResult[]; total_cost_usd: number; total_duration_ms: number }> {
  const startedAt = Date.now();
  const skills = await listActiveSkills(db);
  const targets = await selectUnderperformingSkills(db, skills, options.topN ?? 3);
  const cycles: MutationCycleResult[] = [];
  for (const t of targets) {
    cycles.push(await runMutationCycle(db, t, options));
  }
  return {
    cycles,
    total_cost_usd:    cycles.reduce((s, c) => s + c.total_cost_usd, 0),
    total_duration_ms: Date.now() - startedAt,
  };
}

// Helper for callers who want to lookup a skill by name + scope (re-export)
export { getActiveSkill, upsertSkill };
// Silence unused-import linter
void recordMutation;
void replaySkill;
void compareReplays;
